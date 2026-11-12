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
const codes = JSON.parse(readFileSync(join(dir, 'codes.json'), 'utf8')).party;

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
const secretNeedles = [story.solution.summary, story.solution.reveal, story.roles.find(r => r.id === killer).killerBrief];
const leaks = (state) => secretNeedles.some(n => JSON.stringify(state).includes(n));

// Browser can't touch private data directly
ok(await err(db.query('select * from td_private.games')), 'anon must not read td_private tables');
ok(await err(db.query(`select td_private.story('party')`)), 'anon must not call td_private.story');

// Join: all 10 at once
const states = await Promise.all(ids.map(id => rpc('td_state', codes[id], null)));
ok(states.every(s => s.phase === 0), 'everyone starts in lobby');
const fresh = await rpc('td_state', host, null);
ok(fresh.joinedCount === 10, `joinedCount 10 (got ${fresh.joinedCount})`);
ok(Array.isArray(fresh.hostPlayers) && fresh.hostPlayers.length === 10, 'host sees player list');
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
  ok(!s.reveal && s.rounds.length === 0, `no reveal or evidence in lobby (${id})`);
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
  ok(!s.reveal && s.rounds.length === 0, `no evidence or reveal while reading roles (${id})`);
  if (id !== killer) ok(!leaks(s), `no solution text leaks to ${id}`);
  ok(!JSON.stringify(s.cast).includes('"secret"'), 'cast has no secrets');
}
await Promise.all(ids.slice(0, 7).map(id => rpc('td_ready', codes[id])));
await rpc('td_ready', codes[ids[0]]); // idempotent
const sReady = await rpc('td_state', host, null);
ok(sReady.readyCount === 7 && sReady.hostPlayers.filter(p => p.ready).length === 7, `ready count 7 (got ${sReady.readyCount})`);

await rpc('td_advance', host, 2, 3);
ok((await rpc('td_state', host, null)).rounds.length === 1, 'round 1 released at phase 3');
for (const p of [4, 5, 6]) await rpc('td_advance', host, p - 1, p);
const s4 = await rpc('td_state', codes[ids[2]], null);
ok(s4.phase === 6 && s4.rounds.length === 3, 'all three rounds visible during accusations');
const r3 = story.roles.find(r => r.id === ids[2]).roundInfo || {};
ok(Object.keys(s4.role.roundInfo).length === Object.values(r3).filter(Boolean).length, 'round info unlocked');

// Voting
const votes = await Promise.all(ids.map((id, i) => rpc('td_vote', codes[id], i < 6 ? killer : ids[(i + 1) % 10], 'motive', 'because')));
ok(votes.every(v => v.ok), 'all ten votes accepted');
ok(await err(rpc('td_vote', codes[ids[0]], ids[3], 'x', 'y')) === 'ALREADY_VOTED', 'cannot change vote');
ok(await err(rpc('td_vote', codes[ids[0]], 'nobody', 'x', 'y')) !== null, 'bad suspect rejected');
const sv = await rpc('td_state', codes[ids[0]], null);
ok(sv.voteCount === 10 && sv.myBallot?.suspect === killer, 'vote count + my ballot');
ok(!sv.reveal && !leaks(sv) || ids[0] === killer, 'still no reveal while voting');

// Reveal
await rpc('td_advance', host, 6, 7);
const s5 = await rpc('td_state', codes[ids[5]], null);
ok(s5.reveal?.solution?.killer === killer && s5.reveal.ballots.length === 10, 'reveal shows solution + ballots');
ok(await err(rpc('td_advance', host, 7, 8)) === 'BAD_PHASE', 'nothing after reveal');

// Reset (rehearsal)
ok(await err(rpc('td_reset', host, 'nah')) === 'CONFIRM_REQUIRED', 'reset needs confirmation');
ok(await err(rpc('td_reset', nonHost, 'RESET')) === 'NOT_HOST', 'only host resets');
await rpc('td_reset', host, 'RESET');
const sr = await rpc('td_state', host, null);
ok(sr.phase === 0 && sr.voteCount === 0 && sr.readyCount === 0 && sr.joinedCount === 10, 'reset to lobby, players kept');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
