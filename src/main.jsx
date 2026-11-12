import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, configured, store } from './api.js';
import './style.css';

const POLL_MS = 3000;
const PHASE_LABEL = ['Lobby', 'Round 1', 'Round 2', 'Round 3', 'Accusations', 'The Reveal'];

// ---------- join code from link: …/#/j/ABC123 ----------
function codeFromHash() {
  const m = location.hash.match(/#\/?j\/([A-Za-z0-9-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1].toUpperCase();
}

// Replace every character name in the story with the real name of the guest playing it.
// Single regex pass, so a guest whose real name matches another character can't cause chain swaps.
// Fields typed by guests (accusations) and identifiers are left alone.
const KEEP = new Set(['guestName', 'code', 'roleId', 'id', 'partner', 'suspect', 'gameId', 'ballots', 'myBallot', 'hostPlayers', 'character', 'me']);
export function personalize(game) {
  if (!game?.cast) return game;
  const map = Object.fromEntries(game.cast.filter(c => c.guestName).map(c => [c.name, c.guestName]));
  const names = Object.keys(map).sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = names.length ? new RegExp(`\\b(${names.join('|')})\\b`, 'g') : null;
  const walk = v => {
    if (typeof v === 'string') return re ? v.replace(re, m => map[m] ?? m) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, KEEP.has(k) ? x : walk(x)]));
    return v;
  };
  const withChars = {
    ...game,
    cast: game.cast.map(c => ({ ...c, character: c.name })),
    role: game.role && { ...game.role, character: game.role.name },
  };
  return walk(withChars);
}

function useGame(code) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);
  const versionRef = useRef(null);
  const timer = useRef(null);

  const refresh = useCallback(async (force = false) => {
    if (!code) return;
    clearTimeout(timer.current);
    try {
      const s = await api.state(code, force ? null : versionRef.current);
      setOffline(false);
      if (!s.unchanged) { versionRef.current = s.version; setGame(s); setError(null); }
    } catch (e) {
      if (e.network) setOffline(true); else { setError(e); if (e.code === 'INVALID_CODE') return; }
    }
    timer.current = setTimeout(() => refresh(), document.hidden ? POLL_MS * 3 : POLL_MS);
  }, [code]);

  useEffect(() => {
    versionRef.current = null; setGame(null); setError(null);
    refresh(true);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => { clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onVis); };
  }, [refresh]);

  return { game, error, offline, refresh };
}

// ---------- app ----------
function App() {
  const [code, setCode] = useState(() => { const c = codeFromHash(); if (c) store.set('td_code', c); return c || store.get('td_code'); });
  const { game: rawGame, error, offline, refresh } = useGame(code);
  const game = useMemo(() => personalize(rawGame), [rawGame]);
  const [tab, setTab] = useState(() => store.get('td_tab', 'home'));
  const [toast, setToast] = useState(null);
  const lastPhase = useRef(null);

  useEffect(() => {
    const onHash = () => { const c = codeFromHash(); if (c) { store.set('td_code', c); lastPhase.current = null; setCode(c); } };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => store.set('td_tab', tab), [tab]);
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  // Announce phase changes
  useEffect(() => {
    if (!game) return;
    const prev = lastPhase.current;
    lastPhase.current = game.phase;
    if (prev === null || prev === game.phase || game.phase < prev) return;
    const msg = game.phase <= 3 ? `${PHASE_LABEL[game.phase]} evidence is unlocked` : game.phase === 4 ? 'Accusations are open' : 'The truth is revealed';
    setToast(msg);
    try { navigator.vibrate?.([120, 60, 120]); } catch { /* ignore */ }
    setTab(game.phase <= 3 ? 'clues' : game.phase === 4 ? 'accuse' : 'home');
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [game?.phase]);

  const leave = () => { store.del('td_code'); setCode(null); setTab('home'); lastPhase.current = null; };

  if (!configured) return <Shell><Panel title="Setup needed"><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> and rebuild.</p></Panel></Shell>;
  if (!code || error?.code === 'INVALID_CODE') return <Shell hero><Join error={error && code ? error.message : null} onJoin={c => { store.set('td_code', c); setCode(c); }} /></Shell>;
  if (!game) return <Shell hero>{offline ? <Banner kind="warn">Can’t reach the game server. Retrying…</Banner> : <div className="loading">Opening the case file…</div>}</Shell>;
  if (!game.me.guestName) return <Shell hero><NameForm code={code} onDone={() => refresh(true)} game={game} /></Shell>;

  const tabs = [['home', 'Home', '⌂'], ['card', 'My Card', '✦'], ['suspects', 'Suspects', '☍'], ['clues', 'Clues', '⌕'], ['accuse', game.phase >= 5 ? 'Votes' : 'Accuse', '⚖']];
  const props = { game, code, refresh, setTab };
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Till Death <em>Do Us Part</em></div>
        <div className="phase"><span className={`dot p${game.phase}`} />{PHASE_LABEL[game.phase]}</div>
      </div>
      {offline && <Banner kind="warn">Reconnecting… your phone will catch up automatically.</Banner>}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      <main>
        {tab === 'home' && <Home {...props} onLeave={leave} />}
        {tab === 'card' && <Card {...props} />}
        {tab === 'suspects' && <Suspects {...props} />}
        {tab === 'clues' && <Clues {...props} />}
        {tab === 'accuse' && <Accuse {...props} />}
      </main>
      <nav className="tabs">
        {tabs.map(([id, label, icon]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <span className="ic" aria-hidden>{icon}</span><span>{label}</span>
            {id === 'clues' && tab !== 'clues' && game.phase >= 1 && game.phase <= 3 && <NewDot game={game} />}
          </button>
        ))}
      </nav>
    </div>
  );
}

function NewDot({ game }) {
  const seen = store.get(`td_seen_${game.gameId}`, 0);
  return game.rounds.length > seen ? <span className="badge" /> : null;
}

// ---------- shells ----------
function Shell({ children, hero }) {
  return <div className="app">{hero && <header className="hero"><div className="eyebrow">A murder mystery for five couples</div><h1>Till Death<br /><em>Do Us Part</em></h1></header>}<main>{children}</main></div>;
}
const Panel = ({ title, kicker, children, className = '' }) => <section className={`panel ${className}`}>{kicker && <div className="kicker">{kicker}</div>}{title && <h2>{title}</h2>}{children}</section>;
const Banner = ({ kind = 'info', children }) => <div className={`banner ${kind}`}>{children}</div>;
const Paras = ({ text }) => (text || '').split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>);

function Join({ onJoin, error }) {
  const [v, setV] = useState('');
  const clean = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <Panel title="Enter the investigation">
      <p>Tap the personal link the host sent you, or type the 6-character code from it.</p>
      {error && <Banner kind="error">{error}</Banner>}
      <form onSubmit={e => { e.preventDefault(); if (clean.length >= 6) onJoin(clean); }}>
        <input className="code" inputMode="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck="false" maxLength={8} placeholder="ABC123" value={v} onChange={e => setV(e.target.value)} />
        <button className="primary" disabled={clean.length < 6}>Join the party</button>
      </form>
      <p className="small">Your code is private. It unlocks your character and nobody else’s.</p>
    </Panel>
  );
}

function NameForm({ code, onDone, game }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async e => {
    e.preventDefault(); setErr(null);
    const taken = game.cast.some(c => c.id !== game.me.roleId && c.guestName && c.guestName.trim().toLowerCase() === v.trim().toLowerCase());
    if (taken) { setErr('Someone already joined with that name. Add your last initial, e.g. “Sam B.”'); return; }
    setBusy(true);
    try { await api.setName(code, v); onDone(); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Panel kicker={`You’re in · ${game.role.couple}`} title="What’s your name?">
      <p>Use the name your friends call you. It replaces your character’s name everywhere in the story, on every phone.</p>
      {err && <Banner kind="error">{err}</Banner>}
      <form onSubmit={submit}>
        <input autoFocus maxLength={40} placeholder="Your first name" value={v} onChange={e => setV(e.target.value)} />
        <button className="primary" disabled={busy || !v.trim()}>{busy ? 'Saving…' : 'Continue'}</button>
      </form>
    </Panel>
  );
}

// ---------- home ----------
function Home({ game, code, refresh, onLeave, setTab }) {
  const round = game.phase >= 1 && game.phase <= 3 ? game.rounds[game.phase - 1] : null;
  return (
    <>
      {game.phase === 5 ? <Reveal game={game} /> : (
        <>
          <Panel kicker={`Welcome, ${game.me.guestName}`} title={game.phase === 0 ? 'Before we begin' : round ? round.title : 'Time to accuse'}>
            {game.phase === 0 && <>
              <p>You and {game.cast.find(c => c.id === game.role.partner)?.name} are <b>{game.role.couple}</b>. Read your card now, then wait for the host to start.</p>
              <button className="primary" onClick={() => setTab('card')}>Read my character card</button>
            </>}
            {round && <>
              <Paras text={round.prompt} />
              <button className="primary" onClick={() => setTab('clues')}>See the new evidence</button>
            </>}
            {game.phase === 4 && <>
              <p>No more evidence is coming. Talk it through, then lock in who you think did it, why, and how you know.</p>
              <p className="stat"><b>{game.voteCount}</b> of {game.playerCount} accusations received</p>
              <button className="primary" onClick={() => setTab('accuse')}>{game.myBallot ? 'View my accusation' : 'Make my accusation'}</button>
            </>}
          </Panel>
          <Panel kicker="The case" title={game.victim?.name || 'The victim'}>
            {game.victim?.about && <p className="lede">{game.victim.about}</p>}
            <Paras text={game.intro} />
          </Panel>
          {game.howToPlay?.length > 0 && game.phase <= 1 && <Panel kicker="House rules" title="How to play"><ul className="rules">{game.howToPlay.map((r, i) => <li key={i}>{r}</li>)}</ul></Panel>}
        </>
      )}
      {game.me.isHost && <HostPanel game={game} code={code} refresh={refresh} />}
      <div className="foot">
        <span>{game.gameId === 'practice' ? 'Practice game' : 'Party game'} · {game.joinedCount}/{game.playerCount} joined</span>
        <button className="link" onClick={() => { if (confirm('Leave this game on this phone? You can rejoin with your link.')) onLeave(); }}>Switch code</button>
      </div>
    </>
  );
}

const NEXT = [
  ['Start the game', 'This releases Round 1 evidence to every phone. Everyone joined and read their card?'],
  ['Release Round 2', 'Release Round 2 evidence to every phone?'],
  ['Release Round 3', 'Release the final round of evidence?'],
  ['Open accusations', 'Open accusations? No more evidence comes after this.'],
  ['Reveal the murderer', 'Reveal the solution on every phone? Do this once everyone has voted.'],
];

function HostPanel({ game, code, refresh }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showLinks, setShowLinks] = useState(game.phase === 0);
  const cast = Object.fromEntries(game.cast.map(c => [c.id, c]));
  const base = location.origin + location.pathname;

  const move = async (to) => {
    const [label, ask] = to > game.phase ? NEXT[game.phase] : ['Go back', `Go back to ${PHASE_LABEL[to]}? Evidence already seen stays in people’s heads!`];
    let warn = '';
    if (to === 5 && game.voteCount < game.playerCount) warn = `\n\nOnly ${game.voteCount} of ${game.playerCount} have voted.`;
    if (to === 1 && game.joinedCount < game.playerCount) warn = `\n\nOnly ${game.joinedCount} of ${game.playerCount} have joined.`;
    if (!confirm(`${label}: ${ask}${warn}`)) return;
    setBusy(true); setMsg(null);
    try { await api.advance(code, game.phase, to); } catch (e) { setMsg(e.message); }
    await refresh(true); setBusy(false);
  };
  const share = async (c) => {
    const link = `${base}#/j/${c.code}`;
    const text = `Your private link for Till Death Do Us Part (${cast[c.roleId]?.couple}). Open it on your own phone and don't share it! ${link}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setMsg(`Copied the link for ${cast[c.roleId]?.name}`); }
    } catch { /* cancelled */ }
  };
  const reset = async () => {
    if (prompt('Type RESET to send everyone back to the lobby and erase all accusations.') !== 'RESET') return;
    setBusy(true); try { await api.reset(code); } catch (e) { setMsg(e.message); } await refresh(true); setBusy(false);
  };

  return (
    <Panel kicker="Host controls · only you see this" title={PHASE_LABEL[game.phase]} className="host">
      <div className="meters">
        <div><b>{game.joinedCount}</b><span>/{game.playerCount} joined</span></div>
        <div><b>{game.voteCount}</b><span>/{game.playerCount} voted</span></div>
      </div>
      {msg && <Banner>{msg}</Banner>}
      {game.phase < 5 && <button className="primary big" disabled={busy} onClick={() => move(game.phase + 1)}>{busy ? 'Working…' : NEXT[game.phase][0]}</button>}
      {game.phase > 0 && game.phase < 5 && <button className="ghost" disabled={busy} onClick={() => move(game.phase - 1)}>Undo — go back to {PHASE_LABEL[game.phase - 1]}</button>}
      <button className="ghost" onClick={() => setShowLinks(s => !s)}>{showLinks ? 'Hide' : 'Show'} guest links & status</button>
      {showLinks && (
        <ul className="roster">
          {game.cast.map(c => {
            const hp = game.hostPlayers.find(p => p.roleId === c.id);
            return (
              <li key={c.id}>
                <div><b>{c.guestName || <span className="muted">Waiting for a guest</span>}</b> <span className="muted">· {c.character}</span>
                  <div className="small">{hp.joined ? '✓ joined' : 'not joined yet'}{game.phase === 4 ? (hp.voted ? ' · ✓ voted' : ' · waiting on vote') : ''}</div></div>
                <button className="chip" onClick={() => share(hp)}>Send link</button>
              </li>
            );
          })}
        </ul>
      )}
      {(game.gameId === 'practice' || game.phase === 5) && <button className="link danger" onClick={reset}>Reset this game to the lobby</button>}
    </Panel>
  );
}

// ---------- my card ----------
function Card({ game }) {
  const r = game.role;
  const partner = game.cast.find(c => c.id === r.partner);
  const rounds = Object.entries(r.roundInfo || {}).sort(([a], [b]) => a - b);
  return (
    <>
      <Panel kicker={`${r.couple} · married to ${partner?.name}`} title={r.name} className="card">
        <p className="lede">{r.publicBio}</p>
        <p className="small">Everyone can see the line above. Everything below is private: don’t show your screen.</p>
      </Panel>
      <Envelope killerBrief={r.killerBrief} />
      {rounds.length > 0 && <Panel kicker="New memories" title="What you’ve remembered">{rounds.map(([n, t]) => <div key={n} className="memory"><div className="tag">Round {n}</div><Paras text={t} /></div>)}</Panel>}
      {r.background && <Panel kicker="Who you are tonight" title="Background"><Paras text={r.background} /></Panel>}
      {r.coupleStory && <Panel kicker={`Shared with ${partner?.name}`} title="Your couple’s story"><Paras text={r.coupleStory} /></Panel>}
      <Panel kicker="Hide this if you can" title="Your secret"><Paras text={r.secret} /></Panel>
      <Panel kicker="Where you were" title="Your alibi"><Paras text={r.alibi} /></Panel>
      {r.knows?.length > 0 && <Panel kicker="Share these when it helps you" title="What you know"><ul className="facts">{r.knows.map((k, i) => <li key={i}>{k}</li>)}</ul></Panel>}
      {r.goals?.length > 0 && <Panel kicker="Little missions" title="Your goals tonight"><ul className="facts">{r.goals.map((k, i) => <li key={i}>{k}</li>)}</ul></Panel>}
      <p className="small center">Innocent players may hide secrets but should never lie about evidence.</p>
    </>
  );
}

// Every player gets the same sealed envelope so a glance at someone's screen gives nothing away.
function Envelope({ killerBrief }) {
  const [open, setOpen] = useState(false);
  if (!open) return (
    <button className="envelope" onClick={() => setOpen(true)}>
      <span className="kicker">Top secret · for your eyes only</span>
      <b>Tap to open your sealed envelope</b>
      <span className="small">Make sure nobody is looking at your screen.</span>
    </button>
  );
  return killerBrief
    ? <Panel kicker="Top secret · tap to hide" title="You are the murderer" className="killer"><div onClick={() => setOpen(false)}><Paras text={killerBrief} /></div></Panel>
    : <Panel kicker="Top secret · tap to hide" title="You are innocent" className="innocent"><div onClick={() => setOpen(false)}><p>You did not kill anyone. You may dodge questions about your secret, but never lie about evidence. Help catch the real murderer.</p></div></Panel>;
}

// ---------- suspects ----------
function Suspects({ game }) {
  const key = `td_notes_${game.gameId}`;
  const [notes, setNotes] = useState(() => store.get(key, {}));
  const save = (id, v) => { const n = { ...notes, [id]: v }; setNotes(n); store.set(key, n); };
  const couples = useMemo(() => {
    const m = new Map();
    for (const c of game.cast) { if (!m.has(c.couple)) m.set(c.couple, []); m.get(c.couple).push(c); }
    return [...m];
  }, [game.cast]);
  return (
    <>
      <Panel kicker="Ten guests · five couples" title="The suspects"><p>Your notes save on this phone only. Nobody else sees them.</p></Panel>
      {couples.map(([couple, people]) => (
        <section key={couple} className="couple">
          <h3>{couple}</h3>
          {people.map(c => (
            <div key={c.id} className={`suspect ${c.id === game.me.roleId ? 'me' : ''}`}>
              <div className="who"><b>{c.name}</b>{!c.guestName && <span> · not joined yet</span>}{c.id === game.me.roleId && <span className="you">you</span>}</div>
              <p>{c.publicBio}</p>
              {c.id !== game.me.roleId && <textarea rows={2} placeholder={`Notes on ${c.name}…`} value={notes[c.id] || ''} onChange={e => save(c.id, e.target.value)} />}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

// ---------- clues ----------
function Clues({ game }) {
  const key = `td_notes_${game.gameId}`;
  const [notes, setNotes] = useState(() => store.get(key, {}));
  const seenKey = `td_seen_${game.gameId}`;
  const seenBefore = useRef(store.get(seenKey, 0));
  useEffect(() => { store.set(seenKey, game.rounds.length); }, [game.rounds.length]);
  const save = v => { const n = { ...store.get(key, {}), _general: v }; setNotes(n); store.set(key, n); };
  if (!game.rounds.length) return <Panel kicker="Evidence locker" title="Nothing yet"><p>Evidence unlocks when the host starts Round 1. In the meantime, read your card and get to know the suspects.</p></Panel>;
  return (
    <>
      {[...game.rounds].map((rd, i) => ({ rd, n: i + 1 })).reverse().map(({ rd, n }) => (
        <Panel key={n} kicker={n > seenBefore.current ? 'New evidence' : `Round ${n}`} title={rd.title} className={n > seenBefore.current ? 'fresh' : ''}>
          {rd.prompt && <p className="prompt">{rd.prompt}</p>}
          {rd.exhibits.map(x => (
            <article key={x.id} className="exhibit"><div className="exid">{x.id}</div><div><h3>{x.title}</h3><Paras text={x.body} /></div></article>
          ))}
        </Panel>
      ))}
      <Panel kicker="Only on this phone" title="My case notes">
        <textarea rows={8} placeholder="Timeline, contradictions, hunches…" value={notes._general || ''} onChange={e => save(e.target.value)} />
      </Panel>
    </>
  );
}

// ---------- accuse ----------
function Accuse({ game, code, refresh }) {
  const draftKey = `td_draft_${game.gameId}`;
  const [d, setD] = useState(() => store.get(draftKey, { suspect: '', motive: '', reasoning: '' }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const upd = (k, v) => { const n = { ...d, [k]: v }; setD(n); store.set(draftKey, n); };
  const name = id => game.cast.find(c => c.id === id)?.name;

  if (game.phase >= 5) return <Votes game={game} />;
  if (game.myBallot) return (
    <Panel kicker="Locked in ✓" title={`You accused ${name(game.myBallot.suspect)}`} className="locked">
      {game.myBallot.motive && <><h3>Motive</h3><Paras text={game.myBallot.motive} /></>}
      {game.myBallot.reasoning && <><h3>How you know</h3><Paras text={game.myBallot.reasoning} /></>}
      <p className="stat"><b>{game.voteCount}</b> of {game.playerCount} accusations received. The host will reveal the truth soon.</p>
    </Panel>
  );
  const submit = async () => {
    if (!confirm(`Accuse ${name(d.suspect)}? You can’t change it afterwards.`)) return;
    setBusy(true); setErr(null);
    try { await api.vote(code, d.suspect, d.motive, d.reasoning); store.del(draftKey); }
    catch (e) { setErr(e.message); }
    await refresh(true); setBusy(false);
  };
  const open = game.phase === 4;
  return (
    <Panel kicker={open ? 'Accusations are open' : 'Opens after Round 3'} title="Make your accusation">
      {!open && <p>You can draft your theory now. It saves on this phone. Sending unlocks when the host opens accusations.</p>}
      {err && <Banner kind="error">{err}</Banner>}
      <label>Who did it?</label>
      <div className="pick">
        {game.cast.map(c => <button key={c.id} className={d.suspect === c.id ? 'on' : ''} onClick={() => upd('suspect', c.id)}>{c.name}</button>)}
      </div>
      <label>Why did they do it?</label>
      <textarea rows={3} maxLength={1500} value={d.motive} onChange={e => upd('motive', e.target.value)} placeholder="The motive…" />
      <label>How do you know? Cite the clues.</label>
      <textarea rows={5} maxLength={2000} value={d.reasoning} onChange={e => upd('reasoning', e.target.value)} placeholder="e.g. Exhibit 2A shows… and Blair said…" />
      <button className="primary big" disabled={!open || busy || !d.suspect} onClick={submit}>{busy ? 'Sending…' : open ? 'Lock in my accusation' : 'Waiting for the host'}</button>
    </Panel>
  );
}

// ---------- reveal ----------
function Reveal({ game }) {
  const s = game.reveal.solution;
  const killer = game.cast.find(c => c.id === s.killer);
  const right = game.reveal.ballots.filter(b => b.suspect === s.killer);
  const name = id => game.cast.find(c => c.id === id);
  return (
    <>
      <Panel kicker="The truth" title={`It was ${killer.name}.`} className="reveal">
        <Paras text={s.reveal} />
      </Panel>
      <Panel kicker="Top detectives" title={right.length ? `${right.length} of ${game.reveal.ballots.length} solved it` : 'Nobody solved it!'}>
        {right.length ? <ul className="facts">{right.map(b => <li key={b.roleId}><b>{name(b.roleId)?.name}</b></li>)}</ul> : <p>{killer.name} got away with it… almost.</p>}
      </Panel>
      <Panel kicker="Motive & method" title="How it happened">
        <h3>Motive</h3><Paras text={s.motive} />
        <h3>Method</h3><Paras text={s.method} />
        {s.timeline?.length > 0 && <><h3>Timeline</h3><ul className="timeline">{s.timeline.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
      </Panel>
      {s.proof?.length > 0 && <Panel kicker="The deductions" title="How you could have known"><ul className="facts">{s.proof.map((t, i) => <li key={i}>{t}</li>)}</ul></Panel>}
      {s.redHerrings?.length > 0 && <Panel kicker="Innocent, but suspicious" title="Red herrings"><ul className="facts">{(Array.isArray(s.redHerrings) ? s.redHerrings : [s.redHerrings]).map((t, i) => <li key={i}>{t}</li>)}</ul></Panel>}
    </>
  );
}

function Votes({ game }) {
  const s = game.reveal.solution;
  const tally = {};
  for (const b of game.reveal.ballots) tally[b.suspect] = (tally[b.suspect] || 0) + 1;
  const max = Math.max(1, ...Object.values(tally));
  const c = id => game.cast.find(x => x.id === id);
  return (
    <>
      <Panel kicker="The verdicts" title="Who accused whom">
        <div className="bars">
          {game.cast.filter(x => tally[x.id]).sort((a, b) => tally[b.id] - tally[a.id]).map(x => (
            <div key={x.id} className={`bar ${x.id === s.killer ? 'right' : ''}`}>
              <span>{x.name}</span><i style={{ width: `${(tally[x.id] / max) * 100}%` }} /><b>{tally[x.id]}</b>
            </div>
          ))}
        </div>
      </Panel>
      {game.reveal.ballots.map(b => (
        <Panel key={b.roleId} kicker={`${c(b.roleId)?.name}’s verdict`} title={`Accused ${c(b.suspect)?.name} ${b.suspect === s.killer ? '✓' : '✗'}`} className={b.suspect === s.killer ? 'right' : ''}>
          {b.motive && <p><b>Motive:</b> {b.motive}</p>}
          {b.reasoning && <p><b>Reasoning:</b> {b.reasoning}</p>}
        </Panel>
      ))}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
