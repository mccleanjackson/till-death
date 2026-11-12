-- Till Death Do Us Part — Supabase schema.
-- Safe to publish: contains NO story content. Paste into Supabase > SQL Editor and run once.
-- Story + invite codes are loaded separately by the private seed file.
--
-- Design: all data lives in the non-exposed schema td_private. Browsers can only call the
-- public td_* functions below, which check the player's personal code and only ever return
-- what that player is allowed to see at the current phase.
-- Phases: 0 lobby · 1 opening story · 2 read your role · 3-5 evidence rounds · 6 accusations · 7 reveal

create schema if not exists td_private;
revoke all on schema td_private from public;

create table if not exists td_private.stories (
  id   text primary key,
  blob text not null              -- base64-encoded story JSON (keeps it unreadable at a glance)
);

create table if not exists td_private.games (
  id         text primary key,
  story_id   text not null references td_private.stories(id),
  phase      int  not null default 0 check (phase between 0 and 7),
  version    int  not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists td_private.players (
  code       text primary key,
  game_id    text not null references td_private.games(id) on delete cascade,
  role_id    text not null,
  is_host    boolean not null default false,
  guest_name text,
  joined_at  timestamptz,
  ready_at   timestamptz,
  unique (game_id, role_id)
);

create table if not exists td_private.ballots (
  game_id    text not null references td_private.games(id) on delete cascade,
  role_id    text not null,
  suspect    text not null,
  motive     text not null default '',
  reasoning  text not null default '',
  created_at timestamptz not null default now(),
  primary key (game_id, role_id)
);

-- Upgrades for databases created by an earlier version of this file (safe to re-run).
alter table td_private.players add column if not exists ready_at timestamptz;
alter table td_private.games drop constraint if exists games_phase_check;
alter table td_private.games add constraint games_phase_check check (phase between 0 and 7);

alter table td_private.stories enable row level security;
alter table td_private.games   enable row level security;
alter table td_private.players enable row level security;
alter table td_private.ballots enable row level security;

-- ---------- private helpers (not callable from the browser) ----------

create or replace function td_private.story(p_story_id text) returns jsonb
language sql stable as $$
  select convert_from(decode(blob, 'base64'), 'UTF8')::jsonb from td_private.stories where id = p_story_id
$$;

create or replace function td_private.player(p_code text) returns td_private.players
language plpgsql as $$
declare p td_private.players;
begin
  select * into p from td_private.players where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if not found then raise exception 'INVALID_CODE' using hint = 'That invitation code was not recognised.'; end if;
  return p;
end $$;

create or replace function td_private.bump(p_game text) returns void
language sql as $$
  update td_private.games set version = version + 1, updated_at = now() where id = p_game
$$;

-- ---------- public API ----------

-- Everything a player's phone needs. Pass the last version you saw; if nothing changed you get {unchanged:true}.
create or replace function public.td_state(p_code text, p_version int default null) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare
  p td_private.players; g td_private.games; s jsonb; r jsonb; rnd int; out jsonb; host_extra jsonb := null; reveal jsonb := null;
begin
  p := td_private.player(p_code);
  if p.joined_at is null then
    update td_private.players set joined_at = now() where code = p.code;
    perform td_private.bump(p.game_id);
  end if;
  select * into g from td_private.games where id = p.game_id;
  if p_version is not null and p_version = g.version then
    return jsonb_build_object('unchanged', true, 'version', g.version, 'phase', g.phase);
  end if;

  s := td_private.story(g.story_id);
  rnd := least(greatest(g.phase - 2, 0), 3);   -- evidence rounds start at phase 3
  select e into r from jsonb_array_elements(s->'roles') e where e->>'id' = p.role_id;

  out := jsonb_build_object(
    'version', g.version,
    'phase', g.phase,
    'gameId', g.id,
    'title', s->'title', 'tagline', s->'tagline', 'victim', s->'victim',
    'intro', s->'intro', 'howToPlay', s->'howToPlay',
    'me', jsonb_build_object('roleId', p.role_id, 'isHost', p.is_host, 'guestName', p.guest_name, 'ready', p.ready_at is not null),
    -- Character cards stay sealed until the host reaches "read your role" (phase 2).
    'role', case when g.phase < 2 then jsonb_build_object('id', r->'id', 'name', r->'name', 'couple', r->'couple', 'partner', r->'partner', 'publicBio', r->'publicBio', 'sealed', true)
      else (r - 'roundInfo') || jsonb_build_object(
        'roundInfo', coalesce((select jsonb_object_agg(k, v) from jsonb_each(r->'roundInfo') as x(k, v) where k ~ '^\d+$' and k::int between 1 and rnd and coalesce(v #>> '{}', '') <> ''), '{}'::jsonb),
        'coupleStory', s->'coupleStories'->(r->>'couple')) end,
    'cast', (select jsonb_agg(jsonb_build_object(
                'id', e->>'id', 'name', e->>'name', 'couple', e->>'couple', 'partner', e->>'partner', 'publicBio', e->>'publicBio',
                'guestName', pl.guest_name, 'joined', pl.joined_at is not null) order by i)
             from jsonb_array_elements(s->'roles') with ordinality t(e, i)
             left join td_private.players pl on pl.game_id = g.id and pl.role_id = e->>'id'),
    'rounds', coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(s->'rounds') with ordinality t(e, i) where i <= rnd), '[]'::jsonb),
    'joinedCount', (select count(*) from td_private.players where game_id = g.id and joined_at is not null),
    'readyCount', (select count(*) from td_private.players where game_id = g.id and ready_at is not null),
    'playerCount', (select count(*) from td_private.players where game_id = g.id),
    'voteCount', (select count(*) from td_private.ballots where game_id = g.id),
    'myBallot', (select jsonb_build_object('suspect', b.suspect, 'motive', b.motive, 'reasoning', b.reasoning)
                 from td_private.ballots b where b.game_id = g.id and b.role_id = p.role_id)
  );

  if p.is_host then
    host_extra := (select jsonb_agg(jsonb_build_object(
        'roleId', pl.role_id, 'code', pl.code, 'guestName', pl.guest_name, 'joined', pl.joined_at is not null, 'ready', pl.ready_at is not null,
        'voted', exists(select 1 from td_private.ballots b where b.game_id = g.id and b.role_id = pl.role_id)) order by pl.role_id)
      from td_private.players pl where pl.game_id = g.id);
    out := out || jsonb_build_object('hostPlayers', host_extra);
  end if;

  if g.phase >= 7 then
    reveal := jsonb_build_object(
      'solution', s->'solution',
      'ballots', coalesce((select jsonb_agg(jsonb_build_object('roleId', b.role_id, 'suspect', b.suspect, 'motive', b.motive, 'reasoning', b.reasoning) order by b.created_at)
                  from td_private.ballots b where b.game_id = g.id), '[]'::jsonb));
    out := out || jsonb_build_object('reveal', reveal);
  end if;
  return out;
end $$;

-- Host moves the game one step forward or back. p_from guards against double taps / two hosts racing.
create or replace function public.td_advance(p_code text, p_from int, p_to int) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare p td_private.players; g td_private.games;
begin
  p := td_private.player(p_code);
  if not p.is_host then raise exception 'NOT_HOST' using hint = 'Only the host can change rounds.'; end if;
  select * into g from td_private.games where id = p.game_id for update;
  if g.phase <> p_from then raise exception 'PHASE_CHANGED' using hint = 'The game already moved on. Refreshing.'; end if;
  if p_to not in (p_from + 1, p_from - 1) or p_to < 0 or p_to > 7 then raise exception 'BAD_PHASE'; end if;
  update td_private.games set phase = p_to, version = version + 1, updated_at = now() where id = g.id;
  return jsonb_build_object('phase', p_to);
end $$;

-- One accusation per player, only while accusations are open. Cannot be changed once sent.
create or replace function public.td_vote(p_code text, p_suspect text, p_motive text, p_reasoning text) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare p td_private.players; g td_private.games; n int;
begin
  p := td_private.player(p_code);
  select * into g from td_private.games where id = p.game_id;
  if g.phase <> 6 then raise exception 'VOTING_CLOSED' using hint = 'Accusations are not open right now.'; end if;
  if not exists (select 1 from jsonb_array_elements(td_private.story(g.story_id)->'roles') e where e->>'id' = p_suspect) then
    raise exception 'BAD_SUSPECT';
  end if;
  insert into td_private.ballots (game_id, role_id, suspect, motive, reasoning)
  values (g.id, p.role_id, p_suspect, left(coalesce(p_motive, ''), 1500), left(coalesce(p_reasoning, ''), 2000))
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'ALREADY_VOTED' using hint = 'Your accusation is already locked in.'; end if;
  perform td_private.bump(g.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.td_set_name(p_code text, p_name text) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare p td_private.players; v text := btrim(coalesce(p_name, ''));
begin
  p := td_private.player(p_code);
  if length(v) < 1 or length(v) > 40 then raise exception 'BAD_NAME' using hint = 'Use 1–40 characters.'; end if;
  update td_private.players set guest_name = v where code = p.code;
  perform td_private.bump(p.game_id);
  return jsonb_build_object('ok', true);
end $$;

-- Player confirms they've read their card (only once cards are unlocked).
create or replace function public.td_ready(p_code text) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare p td_private.players; g td_private.games;
begin
  p := td_private.player(p_code);
  select * into g from td_private.games where id = p.game_id;
  if g.phase < 2 then raise exception 'NOT_YET' using hint = 'Cards unlock after the opening story.'; end if;
  if p.ready_at is null then
    update td_private.players set ready_at = now() where code = p.code;
    perform td_private.bump(p.game_id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Host only: back to the lobby and wipe accusations (for the practice game, or a mis-tap).
create or replace function public.td_reset(p_code text, p_confirm text) returns jsonb
language plpgsql security definer set search_path = td_private, pg_temp as $$
declare p td_private.players;
begin
  p := td_private.player(p_code);
  if not p.is_host then raise exception 'NOT_HOST'; end if;
  if p_confirm <> 'RESET' then raise exception 'CONFIRM_REQUIRED'; end if;
  delete from td_private.ballots where game_id = p.game_id;
  update td_private.players set ready_at = null where game_id = p.game_id;
  update td_private.games set phase = 0, version = version + 1, updated_at = now() where id = p.game_id;
  return jsonb_build_object('ok', true);
end $$;

-- Lock down: only the six public functions are callable by browsers.
revoke all on all tables in schema td_private from public;
revoke all on all functions in schema td_private from public;
revoke execute on function public.td_state(text, int), public.td_advance(text, int, int), public.td_vote(text, text, text, text),
  public.td_set_name(text, text), public.td_reset(text, text), public.td_ready(text) from public;
grant execute on function public.td_state(text, int), public.td_advance(text, int, int), public.td_vote(text, text, text, text),
  public.td_set_name(text, text), public.td_reset(text, text), public.td_ready(text) to anon, authenticated;
