import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(url && key);
const supabase = configured ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const FRIENDLY = {
  INVALID_CODE: 'That invitation code wasn’t recognised. Check the link the host sent you.',
  NOT_HOST: 'Only the host can do that.',
  PHASE_CHANGED: 'The game already moved on — refreshing.',
  VOTING_CLOSED: 'Accusations aren’t open right now.',
  ALREADY_VOTED: 'Your accusation is already locked in.',
  BAD_NAME: 'Please enter a name (up to 40 characters).',
};

export class GameError extends Error {
  constructor(code, message, network = false) { super(message); this.code = code; this.network = network; }
}

export async function rpc(fn, args) {
  let res;
  try { res = await supabase.rpc(fn, args); }
  catch { throw new GameError('NETWORK', 'Connection problem — retrying…', true); }
  if (res.error) {
    const code = res.error.message;
    const network = !res.error.code || /fetch|network|Failed/i.test(code);
    throw new GameError(code, FRIENDLY[code] || res.error.hint || (network ? 'Connection problem — retrying…' : code), network);
  }
  return res.data;
}

export const api = {
  state: (code, version) => rpc('td_state', { p_code: code, p_version: version ?? null }),
  advance: (code, from, to) => rpc('td_advance', { p_code: code, p_from: from, p_to: to }),
  vote: (code, suspect, motive, reasoning) => rpc('td_vote', { p_code: code, p_suspect: suspect, p_motive: motive, p_reasoning: reasoning }),
  setName: (code, name) => rpc('td_set_name', { p_code: code, p_name: name }),
  ready: (code) => rpc('td_ready', { p_code: code }),
  reset: (code) => rpc('td_reset', { p_code: code, p_confirm: 'RESET' }),
};

// Tiny localStorage wrapper that never throws (private browsing, blocked storage, etc.)
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
