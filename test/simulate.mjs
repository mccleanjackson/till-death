// End-to-end simulation of a 10-player game against the real SQL, using in-memory Postgres (PGlite).
// Usage: node test/simulate.mjs [path/to/story.json]   (defaults to the practice story — no spoilers printed)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storyFile = process.argv[2] || join(root, 'scripts/demo-story.json');
const story = JSON.parse(readFileSync(storyFile, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'td-test-'));
copyFileSync(storyFile, join(dir, 'story.json'));
const hostRole = story.solution.killer === 'avery' ? 'blair' : 'avery';
execFileSync('node', [join(root, 'scripts/make-seed.mjs'), '--host', hostRole], { env: { ...process.env, TD_PRIVATE_DIR: dir }, stdio: 'ignore' });
const allCodes = JSON.parse(readFileSync(join(dir, 'codes.json'), 'utf8'));
const codes = allCodes.party;
const demo = JSON.parse(readFileSync(join(root, 'scripts/demo-story.json'), 'utf8'));

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
await db.exec(readFileSync(join(dir, 'seed.sql'), 'utf8'));
await db.exec(`grant usage on schema public to anon; set role anon;`); // behave like the browser from here on

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : (fail++, console.log('FAIL:', msg)); };
const rpc = async (fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(`select public.${fn}(${ph}) as v`, args);
  return r.rows[0].v;
};
const err = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const ids = story.roles.map(r => r.id);
const killer = story.solution.killer;
const host = codes[hostRole];
const n = ids.length;
const accomplice = story.solution.accomplice;
const secretNeedles = [story.solution.summary, story.solution.reveal, story.roles.find(r => r.id === killer).killerBrief, story.solution.accompliceReveal].filter(Boolean);
const leaks = (state) => secretNeedles.some(n => JSON.stringify(state).includes(n));

// Browser can't touch private data directly
ok(await err(db.query('select * from td_private.games')), 'anon must not read td_private tables');
ok(await err(db.query(`select td_private.story('party')`)), 'anon must not call td_private.story');

// Join: all 10 at once
const states = await Promise.all(ids.map(id => rpc('td_state', codes[id], null)));
ok(states.every(s => s.phase === 0), 'everyone starts in lobby');
const fresh = await rpc('td_state', host, null);
ok(fresh.joinedCount === n, `joinedCount ${n} (got ${fresh.joinedCount})`);
ok(Array.isArray(fresh.hostPlayers) && fresh.hostPlayers.length === n, 'host sees player list');
ok(/^[A-Z2-9]{6}$/.test(fresh.joinCode) && fresh.requiredOpen === 0, 'host gets a join code');
ok(!states.find(s => s.me.roleId !== hostRole && s.joinCode), 'non-hosts do not see the join code');
ok(!states.find(s => s.me.roleId !== hostRole && s.hostPlayers), 'non-hosts do not see codes');
ok(await err(rpc('td_state', 'NOPE12', null)) === 'INVALID_CODE', 'wrong code rejected');
ok((await rpc('td_state', codes[ids[1]].toLowerCase().split('').join(' '), null)).me.roleId === ids[1], 'code is case/space tolerant');
await Promise.all(ids.map((id, i) => rpc('td_set_name', codes[id], `Guest ${i + 1}`)));
ok((await rpc('td_state', host, null)).cast.every(c => c.guestName), 'names show in cast');
ok(await err(rpc('td_set_name', host, '   ')) === 'BAD_NAME', 'blank name rejected');

// Lobby: cards are sealed for everyone, nothing secret is sent
for (const id of ids) {
  const s = await rpc('td_state', codes[id], null);
  ok(s.role.sealed && !s.role.secret && !s.role.killerBrief, `card sealed in lobby (${id})`);
  ok(!leaks(s), `no secret text in lobby (${id})`);
  ok(!s.reveal && s.rounds.length === 0 && !s.event, `no reveal, evidence or discovery in lobby (${id})`);
}
ok(await err(rpc('td_ready', codes[ids[0]])) === 'NOT_YET', 'cannot mark ready before cards unlock');

// Phase control
const nonHost = codes[ids.find(id => id !== hostRole)];
ok(await err(rpc('td_advance', nonHost, 0, 1)) === 'NOT_HOST', 'non-host cannot advance');
ok(await err(rpc('td_vote', nonHost, ids[0], 'm', 'r')) === 'VOTING_CLOSED', 'no voting in lobby');
const v0 = (await rpc('td_state', host, null)).version;
const race = await Promise.allSettled([rpc('td_advance', host, 0, 1), rpc('td_advance', host, 0, 1)]);
ok(race.filter(r => r.status === 'fulfilled').length === 1, 'double-tap advances only once');
ok(await err(rpc('td_advance', host, 1, 3)) === 'BAD_PHASE', 'cannot skip phases');
const sOpen = await rpc('td_state', codes[ids[3]], null);
ok(sOpen.phase === 1 && sOpen.version > v0 && sOpen.intro && sOpen.role.sealed && sOpen.rounds.length === 0, 'opening story: intro shown, card still sealed');
ok((await rpc('td_state', host, sOpen.version)).unchanged === true, 'unchanged poll is cheap');

// Read-your-role phase: cards unlock, killerBrief only for killer, ready check-ins
await rpc('td_advance', host, 1, 2);
for (const id of ids) {
  const s = await rpc('td_state', codes[id], null);
  ok(!s.role.sealed && s.role.secret, `card unlocked (${id})`);
  ok(!!s.role.killerBrief === (id === killer), `killerBrief only for killer (${id})`);
  ok(!!s.role.accompliceBrief === (id === accomplice), `accompliceBrief only for accomplice (${id})`);
  ok(s.hasAccomplice === !!accomplice, `hasAccomplice flag (${id})`);
  ok(!s.reveal && s.rounds.length === 0 && !s.event, `no evidence, discovery or reveal while reading roles (${id})`);
  if (id !== killer) ok(!leaks(s), `no solution text leaks to ${id}`);
  ok(!JSON.stringify(s.cast).includes('"secret"'), 'cast has no secrets');
}
await Promise.all(ids.slice(0, 7).map(id => rpc('td_ready', codes[id])));
await rpc('td_ready', codes[ids[0]]); // idempotent
const sReady = await rpc('td_state', host, null);
ok(sReady.readyCount === 7 && sReady.hostPlayers.filter(p => p.ready).length === 7, `ready count 7 (got ${sReady.readyCount})`);

await rpc('td_advance', host, 2, 3);
const sEv = await rpc('td_state', codes[ids[4]], null);
ok(sEv.phase === 3 && sEv.event?.text && sEv.rounds.length === 0, 'discovery shown, no evidence yet');
await rpc('td_advance', host, 3, 4);
ok((await rpc('td_state', host, null)).rounds.length === 1, 'round 1 released at phase 4');
for (const p of [5, 6, 7]) await rpc('td_advance', host, p - 1, p);
const s4 = await rpc('td_state', codes[ids[2]], null);
ok(s4.phase === 7 && s4.rounds.length === 3, 'all three rounds visible during accusations');
const r3 = story.roles.find(r => r.id === ids[2]).roundInfo || {};
ok(Object.keys(s4.role.roundInfo).length === Object.values(r3).filter(Boolean).length, 'round info unlocked');

// Voting
const votes = await Promise.all(ids.map((id, i) => rpc('td_vote', codes[id], i < 6 ? killer : ids[(i + 1) % n], 'motive', 'because')));
ok(votes.every(v => v.ok), `all ${n} votes accepted`);
ok(await err(rpc('td_vote', codes[ids[0]], ids[3], 'x', 'y')) === 'ALREADY_VOTED', 'cannot change vote');
ok(await err(rpc('td_vote', codes[ids[0]], 'nobody', 'x', 'y')) !== null, 'bad suspect rejected');
const sv = await rpc('td_state', codes[ids[0]], null);
ok(sv.voteCount === n && sv.myBallot?.suspect === killer, 'vote count + my ballot');
ok(!sv.reveal && !leaks(sv) || ids[0] === killer, 'still no reveal while voting');

// Reveal
await rpc('td_advance', host, 7, 8);
const s5 = await rpc('td_state', codes[ids[5]], null);
ok(s5.reveal?.solution?.killer === killer && s5.reveal.ballots.length === n, 'reveal shows solution + ballots');
ok(await err(rpc('td_advance', host, 8, 9)) === 'BAD_PHASE', 'nothing after reveal');

// Reset (rehearsal)
ok(await err(rpc('td_reset', host, 'nah')) === 'CONFIRM_REQUIRED', 'reset needs confirmation');
ok(await err(rpc('td_reset', nonHost, 'RESET')) === 'NOT_HOST', 'only host resets');
await rpc('td_reset', host, 'RESET');
const sr = await rpc('td_state', host, null);
ok(sr.phase === 0 && sr.voteCount === 0 && sr.readyCount === 0 && sr.joinedCount === n, 'reset to lobby, players kept');

// Scan-to-join on the practice game: random seats, couples together, optional seats last, host never assigned
{
  const pc = allCodes.practice, roles = demo.roles, byId = Object.fromEntries(roles.map(r => [r.id, r]));
  const owner = Object.fromEntries(Object.entries(pc).map(([id, c]) => [c, id]));
  const ph = await rpc('td_state', pc[hostRole], null);
  await rpc('td_set_name', pc[hostRole], 'Host');
  const jc = ph.joinCode;
  ok(await err(rpc('td_join_info', 'ZZZZZZ')) === 'INVALID_JOIN', 'bad join code rejected');
  const info = await rpc('td_join_info', jc.toLowerCase());
  ok(info.gameId === 'practice' && info.open === roles.length - 1 && info.partners.length === 1 && info.partners[0].name === 'Host', 'join info: open seats + host as partner option');
  ok(!Object.values(pc).some(c => JSON.stringify(info).includes(c)), 'join info leaks no codes');
  const a = await rpc('td_join', jc, 'Sam', null);
  const aRole = owner[a.code];
  ok(aRole && aRole !== hostRole && !byId[aRole].optional, 'first joiner gets a main character');
  ok(byId[aRole].partner !== hostRole, 'solo joiner is not seated with the host');
  ok(await err(rpc('td_join', jc, ' sam ', null)) === 'NAME_TAKEN', 'duplicate name rejected');
  ok(await err(rpc('td_join', jc, '', null)) === 'BAD_NAME', 'blank name rejected at join');
  const b = await rpc('td_join', jc, 'Pat', aRole);
  ok(owner[b.code] === byId[aRole].partner, 'partner pick seats the couple together');
  ok(await err(rpc('td_join', jc, 'Lee', aRole)) === 'PARTNER_TAKEN', 'taken partner seat rejected');
  const hp = await rpc('td_join', jc, 'Hostmate', hostRole);
  ok(owner[hp.code] === byId[hostRole].partner, "host's partner can sit with the host");
  const order = [];
  for (let i = 0; ; i++) {
    const e = await err(rpc('td_join', jc, `Guest ${i}`, null).then(r => order.push(owner[r.code])));
    if (e) { ok(e === 'GAME_FULL', `full game rejects (${e})`); break; }
  }
  const optional = roles.filter(r => r.optional).map(r => r.id);
  ok(order.length === roles.length - 4 && !order.includes(hostRole), 'every remaining seat filled exactly once');
  ok(optional.every(id => order.slice(-optional.length).includes(id)), 'optional seats are filled last');
  const after = await rpc('td_state', pc[hostRole], null);
  ok(after.joinedCount === roles.length && after.requiredOpen === 0 && after.cast.every(c => c.guestName), 'everyone joined with names');
  ok((await rpc('td_state', a.code, null)).me.guestName === 'Sam', 'joined player sees their own name');
}

// Only 10 guests in a 12-seat game (practice2): the optional couple stays empty and doesn't count
{
  const pc = allCodes.practice2, roles = demo.roles, optional = roles.filter(r => r.optional).map(r => r.id);
  const owner = Object.fromEntries(Object.entries(pc).map(([id, c]) => [c, id]));
  const seats = [pc[hostRole]];
  const jc = (await rpc('td_state', pc[hostRole], null)).joinCode;
  for (let i = 1; i < 10; i++) seats.push((await rpc('td_join', jc, `Ten ${i}`, null)).code);
  ok(seats.every(c => !optional.includes(owner[c])), '10 guests fill the 10 main characters');
  let s = await rpc('td_state', pc[hostRole], null);
  ok(s.joinedCount === 10 && s.playerCount === 10 && s.requiredOpen === 0, `10 of 10 joined (got ${s.joinedCount}/${s.playerCount})`);
  ok(optional.every(id => s.cast.find(c => c.id === id)?.optional && !s.cast.find(c => c.id === id).joined), 'cast marks empty optional seats');
  for (let p = 1; p <= 2; p++) await rpc('td_advance', pc[hostRole], p - 1, p);
  const all = await Promise.all(seats.map(c => rpc('td_state', c, null)));
  ok(all.every(x => !x.hasAccomplice && !x.role.accompliceBrief), 'no accomplice when that seat is empty');
  ok(all.some(x => x.role.killerBrief), 'murderer is seated');
  await Promise.all(seats.map(c => rpc('td_ready', c)));
  ok((await rpc('td_state', pc[hostRole], null)).readyCount === 10, '10 of 10 ready');
  for (let p = 3; p <= 7; p++) await rpc('td_advance', pc[hostRole], p - 1, p);
  ok(await err(rpc('td_vote', seats[1], optional[0], 'm', 'r')) === 'BAD_SUSPECT', 'cannot accuse an empty optional seat');
  await Promise.all(seats.map(c => rpc('td_vote', c, demo.solution.killer, 'm', 'r')));
  s = await rpc('td_state', pc[hostRole], null);
  ok(s.voteCount === 10 && s.playerCount === 10, `10 of 10 voted (got ${s.voteCount}/${s.playerCount})`);
  await rpc('td_advance', pc[hostRole], 7, 8);
  ok((await rpc('td_state', seats[2], null)).reveal.ballots.length === 10, 'reveal with 10 ballots');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
