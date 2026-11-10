-- =============================================================================
-- hide&seek – Datenbank
--
-- Grundsatz: Clients lesen und schreiben NIE direkt in Tabellen. Alle Tabellen
-- haben RLS ohne Policies. Gelesen wird über get_state()/get_field(), die je
-- nach Rolle (Hider, Seeker, Zuschauer) filtern; geschrieben wird über RPCs,
-- die die Spielregeln prüfen. Dadurch sehen Seeker nie die Position der Hider.
--
-- Zeitabhängige Übergänge (Versteckzeit abgelaufen, Antwortzeit abgelaufen,
-- Blockade-Timer, Beginn des Endspiels) erledigt _tick(), das bei jedem
-- get_state()-Aufruf läuft. Die Clients fragen alle ~3 s ab.
-- =============================================================================

create extension if not exists postgis with schema extensions;

-- Interne Hilfsfunktionen liegen im Schema hs, das die API nicht anbietet.
create schema if not exists hs;

-- -----------------------------------------------------------------------------
-- Tabellen
-- -----------------------------------------------------------------------------

create table public.games (
  id             text primary key check (id ~ '^[0-9A-F]{5}$'),
  title          text not null check (char_length(title) between 1 and 60),
  admin_id       uuid not null,
  earliest_at    timestamptz,
  latest_at      timestamptz,
  min_players    int  not null default 3   check (min_players between 2 and 30),
  max_players    int  not null default 12  check (max_players between 2 and 30),
  hide_minutes   int  not null default 12  check (hide_minutes between 5 and 60),
  zone_radius_m  int  not null default 200 check (zone_radius_m between 50 and 1000),
  answer_minutes int  not null default 3   check (answer_minutes between 2 and 10),
  round_pot_minutes int not null default 60 check (round_pot_minutes between 20 and 180),  -- Minuten-Topf pro Runde
  places         jsonb not null default '[]',     -- [{name, lat, lng}], max. 4
  landmark       text check (char_length(landmark) <= 80),
  field          extensions.geometry(MultiPolygon, 4326) not null,
  team_mode      boolean,
  status         text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  check (max_players >= min_players),
  check (earliest_at is null or latest_at is null or latest_at > earliest_at)
);

create table public.districts (
  id      bigserial primary key,
  game_id text not null references public.games (id) on delete cascade,
  name    text not null,
  geom    extensions.geometry(MultiPolygon, 4326) not null
);
create index districts_game_idx on public.districts (game_id);
create index districts_geom_idx on public.districts using gist (geom);

create table public.parties (
  id        uuid primary key default gen_random_uuid(),
  game_id   text not null references public.games (id) on delete cascade,
  number    int  not null,
  name      text not null,
  minutes   int  not null default 0,
  was_hider boolean not null default false,
  unique (game_id, number)
);

create table public.players (
  id        uuid primary key default gen_random_uuid(),
  game_id   text not null references public.games (id) on delete cascade,
  user_id   uuid not null,
  name      text not null check (char_length(name) between 1 and 24),
  plays     boolean not null default true,      -- false = Spielleiter, der nur zuschaut
  party_id  uuid references public.parties (id) on delete set null,
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);
create index players_user_idx on public.players (user_id);
create unique index players_name_uq on public.players (game_id, lower(name));

create table public.positions (
  player_id  uuid primary key references public.players (id) on delete cascade,
  game_id    text not null references public.games (id) on delete cascade,
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  accuracy   double precision,
  updated_at timestamptz not null default now()
);
create index positions_game_idx on public.positions (game_id);

create table public.rounds (
  id                 uuid primary key default gen_random_uuid(),
  game_id            text not null references public.games (id) on delete cascade,
  number             int  not null,
  hider_party_id     uuid not null references public.parties (id),
  status             text not null default 'ready'
                     check (status in ('ready', 'hiding', 'seeking', 'found', 'cancelled')),
  created_at         timestamptz not null default now(),
  hiding_started_at  timestamptz,
  hide_deadline      timestamptz,
  hide_lat           double precision,
  hide_lng           double precision,
  seeking_started_at timestamptz,
  endgame_at         timestamptz,
  found_at           timestamptz,
  found_by_party_id  uuid references public.parties (id),
  proof_path         text,
  seek_minutes       int,
  penalty_minutes    int  not null default 0,   -- Strafzeit für falsche Fund-Meldungen
  hider_award        int,                       -- Minuten für die Hider in dieser Runde
  finder_award       int,                       -- Minuten für das Such-Team, das gefunden hat
  unique (game_id, number)
);

create table public.ready (
  round_id  uuid not null references public.rounds (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  primary key (round_id, player_id)
);

-- Münzen, die der Hider in einer Runde von einem Seeker-Team bekommen hat
create table public.round_coins (
  round_id        uuid not null references public.rounds (id) on delete cascade,
  party_id        uuid not null references public.parties (id) on delete cascade,
  coins           int  not null default 0 check (coins >= 0),
  choice_token    boolean not null default false,   -- Blockade 2 „Auswahl“ gilt für den nächsten Wurf
  last_endgame_at timestamptz,                     -- für 3 min Pause bei Endspiel-Fragen
  primary key (round_id, party_id)
);

create table public.questions (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references public.rounds (id) on delete cascade,
  game_id       text not null references public.games (id) on delete cascade,
  party_id      uuid not null references public.parties (id) on delete cascade,
  asked_by      uuid not null references public.players (id) on delete cascade,
  category      text not null check (category in ('relativ', 'entfernung', 'endspiel', 'foto')),
  qkey          text not null,
  cost          int  not null,
  seeker_lat    double precision,
  seeker_lng    double precision,
  seeker_street text,
  status        text not null default 'pending' check (status in ('pending', 'answered', 'expired')),
  asked_at      timestamptz not null default now(),
  deadline      timestamptz,
  suggestion    jsonb,          -- {text, info} – Vorschlag der App für Straßenfragen
  answer        text check (char_length(answer) <= 200),
  answer_path   text,           -- Foto-Antwort im Storage-Bucket „photos“
  auto          boolean not null default false,
  answered_at   timestamptz,
  unique (round_id, party_id, qkey)
);
create index questions_round_idx on public.questions (round_id, party_id);

create table public.blockades (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.rounds (id) on delete cascade,
  game_id    text not null references public.games (id) on delete cascade,
  party_id   uuid not null references public.parties (id) on delete cascade,  -- Team, gegen das sie gilt
  dice       int  not null check (dice in (1, 2)),
  rolls      int[] not null,          -- alle gewürfelten Augen (inkl. Bonus-Würfe)
  options    int[],                   -- Auswahl-Möglichkeiten bei „Auswahl“
  value      int check (value between 1 and 12),
  status     text not null check (status in ('choosing', 'held', 'active', 'done', 'void')),
  created_at timestamptz not null default now(),
  played_at  timestamptz,
  ends_at    timestamptz,
  note       text check (char_length(note) <= 200),
  done_at    timestamptz
);
create index blockades_round_idx on public.blockades (round_id, party_id);

-- -----------------------------------------------------------------------------
-- RLS: an, aber ohne Policies -> kein direkter Tabellenzugriff für Clients
-- (ohne Policy liefert eine Tabelle für anon/authenticated keine Zeilen)
-- -----------------------------------------------------------------------------

alter table public.games       enable row level security;
alter table public.districts   enable row level security;
alter table public.parties     enable row level security;
alter table public.players     enable row level security;
alter table public.positions   enable row level security;
alter table public.rounds      enable row level security;
alter table public.ready       enable row level security;
alter table public.round_coins enable row level security;
alter table public.questions   enable row level security;
alter table public.blockades   enable row level security;


-- -----------------------------------------------------------------------------
-- Hilfsfunktionen
-- -----------------------------------------------------------------------------

-- Entfernung in Metern (Haversine)
create or replace function hs._dist(lat1 double precision, lng1 double precision,
                                        lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

create or replace function hs._pt(p_lat double precision, p_lng double precision)
returns extensions.geometry language sql immutable set search_path = '' as $$
  select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);
$$;

create or replace function hs._geom(p jsonb)
returns extensions.geometry language sql immutable set search_path = '' as $$
  select extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
           extensions.st_setsrid(extensions.st_geomfromgeojson(p::text), 4326)), 3));
$$;

-- Wird von den Storage-Policies benutzt (Ordnername = Spiel-ID)
create or replace function public.is_member(p_game text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.players where game_id = p_game and user_id = auth.uid());
$$;

create or replace function hs._window_open(g public.games)
returns boolean language sql stable set search_path = '' as $$
  select (g.earliest_at is null or now() >= g.earliest_at)
     and (g.latest_at   is null or now() <= g.latest_at);
$$;

create or replace function hs._question_category(p_key text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_key in ('ns', 'ew', 'district', 'place1', 'place2', 'place3', 'place4') then 'relativ'
    when p_key in ('d1000', 'd500', 'd300', 'd150', 'd75', 'd30') then 'entfernung'
    when p_key in ('street_letters', 'selfie', 'photo_up', 'photo_down', 'same_street',
                   'street_dist', 'dist25', 'seen') then 'endspiel'
    when p_key in ('tallest', 'buildings5', 'trees5', 'stop', 'restaurant') then 'foto'
  end;
$$;

create or replace function hs._question_cost(p_category text)
returns int language sql immutable set search_path = '' as $$
  select case p_category when 'relativ' then 7 when 'entfernung' then 6
                         when 'endspiel' then 3 when 'foto' then 3 end;
$$;

create or replace function hs._is_photo_question(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select p_key in ('selfie', 'photo_up', 'photo_down', 'tallest', 'buildings5', 'trees5', 'stop', 'restaurant');
$$;

-- Aktuelle Position des Hider-Teams: jüngste Position eines Mitglieds, sonst Versteck
create or replace function hs._hider_pos(p_round uuid, out lat double precision, out lng double precision)
language plpgsql stable security definer set search_path = '' as $$
declare r public.rounds;
begin
  select * into r from public.rounds where id = p_round;
  select pos.lat, pos.lng into lat, lng
    from public.positions pos join public.players pl on pl.id = pos.player_id
   where pl.party_id = r.hider_party_id
   order by pos.updated_at desc limit 1;
  if lat is null then lat := r.hide_lat; lng := r.hide_lng; end if;
end $$;

create or replace function hs._district_at(p_game text, p_lat double precision, p_lng double precision)
returns text language sql stable security definer set search_path = '' as $$
  select name from public.districts
   where game_id = p_game and extensions.st_contains(geom, hs._pt(p_lat, p_lng))
   limit 1;
$$;

create or replace function hs._new_round(p_game text, p_hider uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_round uuid; v_num int;
begin
  select coalesce(max(number), 0) + 1 into v_num from public.rounds where game_id = p_game;
  insert into public.rounds (game_id, number, hider_party_id, status)
  values (p_game, v_num, p_hider, 'ready') returning id into v_round;
  update public.parties set was_hider = true where id = p_hider;
  insert into public.round_coins (round_id, party_id)
  select v_round, id from public.parties where game_id = p_game and id <> p_hider;
  return v_round;
end $$;

-- Zeitabhängige Übergänge
create or replace function hs._tick(p_game text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g     public.games;
  r     public.rounds;
  q     public.questions;
  v_lat double precision;
  v_lng double precision;
begin
  select * into g from public.games where id = p_game;
  if g.status is distinct from 'playing' then return; end if;
  select * into r from public.rounds where game_id = p_game order by number desc limit 1 for update;
  if r.id is null then return; end if;

  -- Versteckzeit abgelaufen: Position nach genau der Versteckzeit wird Versteck
  if r.status = 'hiding' and now() >= r.hide_deadline then
    select lat, lng into v_lat, v_lng from hs._hider_pos(r.id);
    if v_lat is not null then
      update public.rounds
         set hide_lat = v_lat, hide_lng = v_lng, status = 'seeking', seeking_started_at = r.hide_deadline
       where id = r.id
       returning * into r;
    end if;
  end if;

  if r.status <> 'seeking' then return; end if;

  -- Antwortzeit abgelaufen: Vorschlag senden (Straßenfragen) oder verfallen lassen
  for q in select * from public.questions
            where round_id = r.id and status = 'pending' and deadline <= now()
  loop
    if q.suggestion ? 'text' and coalesce(q.suggestion->>'text', '') <> '' then
      update public.questions
         set status = 'answered', answer = q.suggestion->>'text', answered_at = now(), auto = true
       where id = q.id;
      update public.round_coins set coins = coins + q.cost
       where round_id = r.id and party_id = q.party_id;
    else
      update public.questions set status = 'expired', answered_at = now() where id = q.id;
    end if;
    if q.category = 'endspiel' then
      update public.round_coins set last_endgame_at = now()
       where round_id = r.id and party_id = q.party_id;
    end if;
  end loop;

  -- Blockaden mit Timer beenden
  update public.blockades set status = 'done', done_at = now()
   where round_id = r.id and status = 'active' and value in (6, 7, 10, 12) and ends_at <= now();

  -- Endspiel: erstes Seeker-Team in der Zielzone
  if r.endgame_at is null and r.hide_lat is not null then
    if exists (
      select 1 from public.positions pos join public.players pl on pl.id = pos.player_id
       where pl.game_id = p_game and pl.party_id is not null and pl.party_id <> r.hider_party_id
         and pos.updated_at >= r.seeking_started_at
         and hs._dist(pos.lat, pos.lng, r.hide_lat, r.hide_lng) <= g.zone_radius_m)
    then
      update public.rounds set endgame_at = now() where id = r.id;
    end if;
  end if;
end $$;

-- Blockaden-Wert anwenden: 1 = nichts, 2 = Auswahl-Marke, 11 = Bonus-Wurf
create or replace function hs._apply_value(p_blockade uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.blockades; d1 int; d2 int;
begin
  select * into b from public.blockades where id = p_blockade;
  loop
    if b.value = 11 then
      d1 := 1 + floor(random() * 6)::int;
      d2 := 1 + floor(random() * 6)::int;
      update public.blockades
         set value = least(12, d1 + d2 + 2), rolls = rolls || array[d1, d2]
       where id = b.id returning * into b;
    elsif b.value = 2 then
      update public.round_coins set choice_token = true
       where round_id = b.round_id and party_id = b.party_id;
      update public.blockades set status = 'done', done_at = now() where id = b.id;
      exit;
    elsif b.value = 1 then
      update public.blockades set status = 'void', done_at = now() where id = b.id;
      exit;
    else
      exit;
    end if;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Lesen
-- -----------------------------------------------------------------------------

create or replace function public.check_game(p_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g public.games;
begin
  select * into g from public.games where id = upper(btrim(p_id));
  if g.id is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true, 'id', g.id, 'title', g.title, 'status', g.status,
    'earliest_at', g.earliest_at, 'latest_at', g.latest_at,
    'open', hs._window_open(g),
    'joined', public.is_member(g.id),
    'full', (select count(*) from public.players where game_id = g.id and plays) >= g.max_players);
end $$;

create or replace function public.get_field(p_game text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g public.games;
begin
  if not public.is_member(p_game) then raise exception 'Du bist in diesem Spiel nicht angemeldet'; end if;
  select * into g from public.games where id = p_game;
  return jsonb_build_object(
    'field', extensions.st_asgeojson(extensions.st_simplifypreservetopology(g.field, 0.00003), 6)::jsonb,
    'places', g.places);
end $$;

create or replace function public.get_state(p_game text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  g        public.games;
  me       public.players;
  r        public.rounds;
  v_role   text;
  v_full   boolean;   -- Hider oder Zuschauer: sieht alle Fragen, Münzen, Blockaden
  v_res    jsonb;
begin
  select * into me from public.players where game_id = p_game and user_id = auth.uid();
  if me.id is null then raise exception 'Du bist in diesem Spiel nicht angemeldet'; end if;

  perform hs._tick(p_game);

  select * into g from public.games where id = p_game;
  select * into r from public.rounds where game_id = p_game order by number desc limit 1;

  if not me.plays then
    v_role := 'spectator';
  elsif r.id is not null then
    v_role := case when me.party_id = r.hider_party_id then 'hider' else 'seeker' end;
  end if;
  v_full := v_role in ('hider', 'spectator');

  v_res := jsonb_build_object(
    'now', now(),
    'me', jsonb_build_object(
      'id', me.id, 'name', me.name, 'plays', me.plays, 'party_id', me.party_id,
      'is_admin', g.admin_id = auth.uid(), 'role', v_role),
    'game', jsonb_build_object(
      'id', g.id, 'title', g.title, 'status', g.status,
      'earliest_at', g.earliest_at, 'latest_at', g.latest_at,
      'min_players', g.min_players, 'max_players', g.max_players,
      'hide_minutes', g.hide_minutes, 'zone_radius_m', g.zone_radius_m,
      'answer_minutes', g.answer_minutes, 'round_pot_minutes', g.round_pot_minutes,
      'places', g.places, 'landmark', g.landmark,
      'team_mode', g.team_mode,
      'has_districts', exists (select 1 from public.districts where game_id = g.id)),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', id, 'name', name, 'plays', plays, 'party_id', party_id,
                  'is_admin', user_id = g.admin_id) order by joined_at), '[]'::jsonb)
                from public.players where game_id = p_game),
    'parties', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', id, 'number', number, 'name', name, 'minutes', minutes,
                  'was_hider', was_hider) order by number), '[]'::jsonb)
                from public.parties where game_id = p_game),
    'history', (select coalesce(jsonb_agg(jsonb_build_object(
                  'number', number, 'hider_party_id', hider_party_id, 'status', status,
                  'found_by_party_id', found_by_party_id, 'seek_minutes', seek_minutes,
                  'hider_award', hider_award, 'finder_award', finder_award,
                  'proof_path', proof_path) order by number), '[]'::jsonb)
                from public.rounds where game_id = p_game and status = 'found'));

  if r.id is null then return v_res; end if;

  v_res := v_res || jsonb_build_object(
    'round', jsonb_build_object(
      'id', r.id, 'number', r.number, 'status', r.status, 'hider_party_id', r.hider_party_id,
      'hiding_started_at', r.hiding_started_at, 'hide_deadline', r.hide_deadline,
      'seeking_started_at', r.seeking_started_at, 'endgame_at', r.endgame_at,
      'found_at', r.found_at, 'found_by_party_id', r.found_by_party_id,
      'seek_minutes', r.seek_minutes, 'proof_path', r.proof_path, 'penalty_minutes', r.penalty_minutes,
      'ready', (select coalesce(jsonb_agg(player_id), '[]'::jsonb) from public.ready where round_id = r.id),
      'hide', case when v_full and r.hide_lat is not null
                   then jsonb_build_object('lat', r.hide_lat, 'lng', r.hide_lng) end),
    'questions', (select coalesce(jsonb_agg(
                    to_jsonb(q) - 'seeker_lat' - 'seeker_lng' - 'seeker_street' - 'round_id' - 'game_id'
                    order by q.asked_at desc), '[]'::jsonb)
                  from public.questions q
                  where q.round_id = r.id and (v_full or q.party_id = me.party_id)),
    'blockades', (select coalesce(jsonb_agg(
                    to_jsonb(b) - 'round_id' - 'game_id' order by b.created_at desc), '[]'::jsonb)
                  from public.blockades b
                  where b.round_id = r.id
                    and (v_full or (b.party_id = me.party_id and b.status in ('active', 'done')
                                    and b.value not in (1, 2)))),
    'coins', case when v_full then
               (select coalesce(jsonb_agg(jsonb_build_object(
                  'party_id', party_id, 'coins', coins, 'choice_token', choice_token)), '[]'::jsonb)
                from public.round_coins where round_id = r.id) end,
    'endgame_ready_at', (select last_endgame_at + interval '3 minutes'
                         from public.round_coins where round_id = r.id and party_id = me.party_id),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object(
                    'player_id', pos.player_id, 'lat', pos.lat, 'lng', pos.lng,
                    'accuracy', pos.accuracy, 'updated_at', pos.updated_at)), '[]'::jsonb)
                  from public.positions pos join public.players pl on pl.id = pos.player_id
                  where pl.game_id = p_game
                    and (v_role = 'spectator' or (me.party_id is not null and pl.party_id = me.party_id))));
  return v_res;
end $$;

-- -----------------------------------------------------------------------------
-- Spiel anlegen, beitreten, starten
-- -----------------------------------------------------------------------------

create or replace function public.create_game(p jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_id    text;
  v_field extensions.geometry;
  v_cut   extensions.geometry;
  v_place jsonb;
  v_name  text := btrim(coalesce(p->>'name', ''));
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if v_name = '' then raise exception 'Bitte gib deinen Namen ein'; end if;
  if btrim(coalesce(p->>'title', '')) = '' then raise exception 'Bitte gib dem Spiel einen Titel'; end if;
  if jsonb_typeof(p->'add') is distinct from 'array' or jsonb_array_length(p->'add') = 0 then
    raise exception 'Bitte lege ein Spielfeld fest';
  end if;
  if jsonb_array_length(coalesce(p->'places', '[]'::jsonb)) > 4 then
    raise exception 'Höchstens 4 Orte';
  end if;
  for v_place in select * from jsonb_array_elements(coalesce(p->'places', '[]'::jsonb)) loop
    if btrim(coalesce(v_place->>'name', '')) = ''
       or jsonb_typeof(v_place->'lat') <> 'number' or jsonb_typeof(v_place->'lng') <> 'number' then
      raise exception 'Jeder Ort braucht einen Namen und eine Position auf der Karte';
    end if;
  end loop;

  select extensions.st_union(hs._geom(e)) into v_field from jsonb_array_elements(p->'add') e;
  select extensions.st_union(hs._geom(e)) into v_cut
    from jsonb_array_elements(coalesce(p->'cut', '[]'::jsonb)) e;
  if v_cut is not null then v_field := extensions.st_difference(v_field, v_cut); end if;
  v_field := extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(v_field), 3));
  if v_field is null or extensions.st_isempty(v_field) then raise exception 'Das Spielfeld ist leer'; end if;
  if extensions.st_area(v_field::extensions.geography) > 400e6 then
    raise exception 'Das Spielfeld ist zu groß (höchstens 400 km²)';
  end if;

  loop
    v_id := upper(lpad(to_hex(floor(random() * 1048576)::int), 5, '0'));
    exit when not exists (select 1 from public.games where id = v_id);
  end loop;

  insert into public.games (id, title, admin_id, earliest_at, latest_at, min_players, max_players,
                            hide_minutes, zone_radius_m, answer_minutes, round_pot_minutes, places, landmark, field)
  values (v_id, btrim(p->>'title'), auth.uid(),
          nullif(p->>'earliest_at', '')::timestamptz, nullif(p->>'latest_at', '')::timestamptz,
          coalesce((p->>'min_players')::int, 3), coalesce((p->>'max_players')::int, 12),
          coalesce((p->>'hide_minutes')::int, 12), coalesce((p->>'zone_radius_m')::int, 200),
          coalesce((p->>'answer_minutes')::int, 3),
          coalesce((p->>'round_pot_minutes')::int, 60),
          coalesce((select jsonb_agg(jsonb_build_object('name', btrim(e->>'name'),
                                    'lat', (e->>'lat')::float8, 'lng', (e->>'lng')::float8))
                    from jsonb_array_elements(coalesce(p->'places', '[]'::jsonb)) e), '[]'::jsonb),
          nullif(btrim(coalesce(p->>'landmark', '')), ''),
          v_field);

  -- nur Stadtteile speichern, die das Spielfeld berühren
  insert into public.districts (game_id, name, geom)
  select v_id, x.name, x.geom
    from (select coalesce(nullif(btrim(d->>'name'), ''), 'Unbenannt') as name, hs._geom(d->'geometry') as geom
            from jsonb_array_elements(coalesce(p->'districts', '[]'::jsonb)) d
           where jsonb_typeof(d->'geometry') = 'object'
           limit 300) x
   where not extensions.st_isempty(x.geom) and extensions.st_intersects(x.geom, v_field);

  insert into public.players (game_id, user_id, name, plays)
  values (v_id, auth.uid(), v_name, coalesce((p->>'plays')::boolean, true));
  return v_id;
end $$;

create or replace function public.join_game(p_id text, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare g public.games; v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select * into g from public.games where id = upper(btrim(p_id)) for update;
  if g.id is null then raise exception 'Kein Spiel mit der ID % gefunden', upper(btrim(p_id)); end if;

  if public.is_member(g.id) then
    if g.status = 'lobby' and v_name <> '' then
      update public.players set name = v_name where game_id = g.id and user_id = auth.uid();
    end if;
    return g.id;
  end if;

  if g.status <> 'lobby' then raise exception 'Das Spiel hat schon begonnen'; end if;
  if not hs._window_open(g) then raise exception 'Das Spiel ist gerade nicht geöffnet'; end if;
  if (select count(*) from public.players where game_id = g.id and plays) >= g.max_players then
    raise exception 'Das Spiel ist schon voll';
  end if;
  if v_name = '' then raise exception 'Bitte gib deinen Namen ein'; end if;
  if exists (select 1 from public.players where game_id = g.id and lower(name) = lower(v_name)) then
    raise exception 'Den Namen „%“ gibt es in diesem Spiel schon', v_name;
  end if;

  insert into public.players (game_id, user_id, name) values (g.id, auth.uid(), v_name);
  return g.id;
end $$;

create or replace function public.leave_game(p_game text)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game;
  if g.admin_id = auth.uid() then raise exception 'Als Spielleiter kannst du das Spiel nur beenden'; end if;
  if g.status = 'playing' then raise exception 'Während des Spiels kann man nicht austreten'; end if;
  delete from public.players where game_id = p_game and user_id = auth.uid();
end $$;

-- p_teams: null = Einzelspieler, sonst {"<player_id>": <Teamnummer>, ...}
create or replace function public.start_game(p_game text, p_teams jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g        public.games;
  v_n      int;
  v_teams  boolean;
  v_k      int;
  v_cnt    int;
  v_min    int;
  v_miss   int;
  v_pl     record;
begin
  select * into g from public.games where id = p_game for update;
  if g.id is null or g.admin_id <> auth.uid() then raise exception 'Nur der Spielleiter kann das Spiel starten'; end if;
  if g.status <> 'lobby' then raise exception 'Das Spiel läuft schon'; end if;
  if not hs._window_open(g) then raise exception 'Das Spiel ist gerade nicht geöffnet'; end if;

  select count(*) into v_n from public.players where game_id = p_game and plays;
  if v_n < g.min_players then raise exception 'Es fehlen noch Spieler (mindestens %)', g.min_players; end if;
  if v_n > g.max_players then raise exception 'Zu viele Spieler (höchstens %)', g.max_players; end if;

  v_teams := coalesce(jsonb_typeof(p_teams) = 'object' and p_teams <> '{}'::jsonb, false);
  if v_n < 4 then v_teams := false; end if;
  if v_n > 6 and not v_teams then
    raise exception 'Bei mehr als 6 Spielern wird in Teams gespielt – bitte teile die Teams ein';
  end if;

  if v_teams then
    select count(*) into v_miss from public.players pl
     where pl.game_id = p_game and pl.plays
       and (jsonb_typeof(p_teams->(pl.id::text)) is distinct from 'number'
            or (p_teams->>(pl.id::text))::int < 1);
    if v_miss > 0 then raise exception 'Bitte ordne alle Spieler einem Team zu'; end if;

    select count(distinct (p_teams->>(pl.id::text))::int), max((p_teams->>(pl.id::text))::int),
           min((p_teams->>(pl.id::text))::int)
      into v_cnt, v_k, v_min
      from public.players pl where pl.game_id = p_game and pl.plays;
    if v_cnt < 2 then raise exception 'Es braucht mindestens 2 Teams'; end if;
    if v_min <> 1 or v_k <> v_cnt then raise exception 'Bitte nummeriere die Teams ohne Lücken (1, 2, 3 …)'; end if;

    insert into public.parties (game_id, number, name)
    select p_game, n, 'Team ' || n from generate_series(1, v_k) n;
    update public.players pl
       set party_id = (select id from public.parties pa
                        where pa.game_id = p_game and pa.number = (p_teams->>(pl.id::text))::int)
     where pl.game_id = p_game and pl.plays;
  else
    for v_pl in select id, name, row_number() over (order by joined_at) rn
                  from public.players where game_id = p_game and plays loop
      with ins as (
        insert into public.parties (game_id, number, name) values (p_game, v_pl.rn, v_pl.name) returning id)
      update public.players set party_id = (select id from ins) where id = v_pl.id;
    end loop;
  end if;

  update public.games set status = 'playing', team_mode = v_teams, started_at = now() where id = p_game;
  perform hs._new_round(p_game, (select id from public.parties where game_id = p_game order by random() limit 1));
end $$;

-- Einzige Stelle, an der Standorte gelöscht werden (Spielende, Datenschutz)
create or replace function hs._clear_positions(p_game text)
returns void language sql security definer set search_path = '' as $$
  delete from public.positions where game_id = p_game;
$$;

create or replace function public.end_game(p_game text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select admin_id from public.games where id = p_game) is distinct from auth.uid() then
    raise exception 'Nur der Spielleiter kann das Spiel beenden';
  end if;
  update public.rounds set status = 'cancelled'
   where game_id = p_game and status in ('ready', 'hiding', 'seeking');
  update public.games set status = 'finished', finished_at = now() where id = p_game;
  perform hs._clear_positions(p_game);
end $$;

-- -----------------------------------------------------------------------------
-- Runde: bereit, verstecken, Position
-- -----------------------------------------------------------------------------

create or replace function public.confirm_ready(p_round uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rounds; g public.games; me public.players;
begin
  select * into r from public.rounds where id = p_round for update;
  select * into g from public.games where id = r.game_id;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.id is null or not me.plays then raise exception 'Du spielst in diesem Spiel nicht mit'; end if;
  if r.status <> 'ready' then return; end if;

  insert into public.ready (round_id, player_id) values (r.id, me.id) on conflict do nothing;

  if (select count(*) from public.ready where round_id = r.id)
     >= (select count(*) from public.players where game_id = r.game_id and plays) then
    update public.rounds
       set status = 'hiding', hiding_started_at = now(),
           hide_deadline = now() + make_interval(mins => g.hide_minutes)
     where id = r.id;
  end if;
end $$;

create or replace function public.update_position(p_game text, p_lat double precision,
                                                  p_lng double precision, p_accuracy double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
declare me public.players;
begin
  select * into me from public.players where game_id = p_game and user_id = auth.uid();
  if me.id is null or not me.plays then return; end if;
  if (select status from public.games where id = p_game) <> 'playing' then return; end if;
  insert into public.positions (player_id, game_id, lat, lng, accuracy, updated_at)
  values (me.id, p_game, p_lat, p_lng, p_accuracy, now())
  on conflict (player_id) do update
    set lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = now();
end $$;

create or replace function public.confirm_hidden(p_round uuid, p_lat double precision, p_lng double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.rounds; g public.games; me public.players;
begin
  select * into r from public.rounds where id = p_round for update;
  select * into g from public.games where id = r.game_id;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Nur die Hider bestätigen ihr Versteck'; end if;
  if r.status <> 'hiding' then raise exception 'Die Versteckzeit ist schon vorbei'; end if;
  if p_lat is null or p_lng is null then raise exception 'Dein Standort ist unbekannt'; end if;
  if not extensions.st_dwithin(g.field::extensions.geography, hs._pt(p_lat, p_lng)::extensions.geography, 25) then
    raise exception 'Ihr seid außerhalb des Spielfelds';
  end if;

  perform public.update_position(r.game_id, p_lat, p_lng, null);
  update public.rounds
     set hide_lat = p_lat, hide_lng = p_lng, status = 'seeking', seeking_started_at = now()
   where id = r.id;
end $$;

-- -----------------------------------------------------------------------------
-- Fragen
-- -----------------------------------------------------------------------------

create or replace function public.ask_question(p_round uuid, p_key text, p_lat double precision,
                                               p_lng double precision, p_street text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r       public.rounds;
  g       public.games;
  me      public.players;
  v_cat   text := hs._question_category(p_key);
  v_cost  int;
  v_last  timestamptz;
  v_hlat  double precision;
  v_hlng  double precision;
  v_d     double precision;
  v_ans   text;
  v_place jsonb;
  v_a     text;
  v_b     text;
  q       public.questions;
begin
  perform hs._tick((select game_id from public.rounds where id = p_round));
  select * into r from public.rounds where id = p_round for update;
  select * into g from public.games where id = r.game_id;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();

  if me.party_id is null or me.party_id = r.hider_party_id then
    raise exception 'Nur Seeker können Fragen stellen';
  end if;
  if r.status <> 'seeking' then raise exception 'Gerade können keine Fragen gestellt werden'; end if;
  if v_cat is null then raise exception 'Unbekannte Frage'; end if;
  if p_lat is null or p_lng is null then raise exception 'Dein Standort ist unbekannt'; end if;
  v_cost := hs._question_cost(v_cat);

  if exists (select 1 from public.blockades
              where round_id = r.id and party_id = me.party_id and status = 'active') then
    raise exception 'Während einer Blockade könnt ihr keine Fragen stellen';
  end if;
  if exists (select 1 from public.questions
              where round_id = r.id and party_id = me.party_id and status = 'pending') then
    raise exception 'Wartet erst auf die Antwort auf eure letzte Frage';
  end if;
  if exists (select 1 from public.questions
              where round_id = r.id and party_id = me.party_id and qkey = p_key) then
    raise exception 'Diese Frage habt ihr in dieser Runde schon gestellt';
  end if;
  if v_cat = 'endspiel' then
    if r.endgame_at is null then raise exception 'Endspiel-Fragen gibt es erst im Endspiel'; end if;
    select last_endgame_at into v_last from public.round_coins
     where round_id = r.id and party_id = me.party_id;
    if v_last is not null and now() < v_last + interval '3 minutes' then
      raise exception 'Die nächste Endspiel-Frage geht in % s',
        ceil(extract(epoch from (v_last + interval '3 minutes' - now())))::int;
    end if;
  end if;
  if p_key like 'place_' then
    v_place := g.places -> (substr(p_key, 6)::int - 1);
    if v_place is null then raise exception 'Diesen Ort gibt es in diesem Spiel nicht'; end if;
  end if;
  if p_key = 'district' and not exists (select 1 from public.districts where game_id = g.id) then
    raise exception 'Für dieses Spielfeld sind keine Stadtteile hinterlegt';
  end if;

  -- Fragen, die die App selbst beantwortet
  if p_key in ('ns', 'ew', 'district', 'place1', 'place2', 'place3', 'place4',
               'd1000', 'd500', 'd300', 'd150', 'd75', 'd30', 'dist25') then
    select lat, lng into v_hlat, v_hlng from hs._hider_pos(r.id);
    if v_hlat is null then raise exception 'Die Position der Hider ist noch unbekannt'; end if;
    v_d := hs._dist(p_lat, p_lng, v_hlat, v_hlng);

    v_ans := case
      when p_key = 'ns' then case when v_hlat >= p_lat then 'Nördlich von euch' else 'Südlich von euch' end
      when p_key = 'ew' then case when v_hlng >= p_lng then 'Östlich von euch' else 'Westlich von euch' end
      when p_key in ('d1000', 'd500', 'd300', 'd150', 'd75', 'd30') then
        case when v_d <= substr(p_key, 2)::int then 'Ja' else 'Nein' end
      when p_key = 'dist25' then 'Etwa ' || (round(v_d / 25) * 25)::int || ' m'
    end;
    if p_key = 'district' then
      v_a := hs._district_at(g.id, p_lat, p_lng);
      v_b := hs._district_at(g.id, v_hlat, v_hlng);
      v_ans := case when v_a is not null and v_a = v_b then 'Ja' else 'Nein' end;
    elsif p_key like 'place_' then
      v_ans := case
        when hs._dist(p_lat, p_lng, (v_place->>'lat')::float8, (v_place->>'lng')::float8)
           < hs._dist(v_hlat, v_hlng, (v_place->>'lat')::float8, (v_place->>'lng')::float8)
        then 'Ja – ihr seid näher an ' || (v_place->>'name') || ' als wir'
        else 'Nein – wir sind näher an ' || (v_place->>'name') || ' als ihr'
      end;
    end if;

    insert into public.questions (round_id, game_id, party_id, asked_by, category, qkey, cost,
                                  seeker_lat, seeker_lng, status, answer, auto, answered_at)
    values (r.id, g.id, me.party_id, me.id, v_cat, p_key, v_cost,
            p_lat, p_lng, 'answered', v_ans, true, now())
    returning * into q;
    update public.round_coins set coins = coins + v_cost,
           last_endgame_at = case when v_cat = 'endspiel' then now() else last_endgame_at end
     where round_id = r.id and party_id = me.party_id;
  else
    insert into public.questions (round_id, game_id, party_id, asked_by, category, qkey, cost,
                                  seeker_lat, seeker_lng, seeker_street, deadline)
    values (r.id, g.id, me.party_id, me.id, v_cat, p_key, v_cost, p_lat, p_lng,
            nullif(btrim(coalesce(p_street, '')), ''),
            now() + make_interval(mins => g.answer_minutes))
    returning * into q;
  end if;

  return to_jsonb(q) - 'seeker_lat' - 'seeker_lng' - 'seeker_street';
end $$;

-- Vorschlag der Hider-App für Straßenfragen. Bei „selbe Straße“ vergleicht der
-- Server mit der Straße, die die Seeker-App beim Fragen mitgeschickt hat.
create or replace function public.set_suggestion(p_question uuid, p_text text, p_info text)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.questions; r public.rounds; me public.players; v_text text := p_text;
begin
  select * into q from public.questions where id = p_question for update;
  select * into r from public.rounds where id = q.round_id;
  select * into me from public.players where game_id = q.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Kein Zugriff'; end if;
  if q.status <> 'pending' or q.suggestion is not null then return; end if;
  if q.qkey not in ('street_letters', 'same_street', 'street_dist') then return; end if;
  if q.qkey = 'same_street' then
    v_text := case
      when q.seeker_street is null or coalesce(btrim(p_info), '') = '' then null
      when lower(btrim(q.seeker_street)) = lower(btrim(p_info)) then 'Ja'
      else 'Nein' end;
  end if;
  update public.questions
     set suggestion = jsonb_build_object('text', v_text, 'info', left(p_info, 100))
   where id = q.id;
end $$;

create or replace function public.answer_question(p_question uuid, p_text text, p_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.questions; r public.rounds; me public.players;
begin
  select * into q from public.questions where id = p_question for update;
  select * into r from public.rounds where id = q.round_id for update;
  select * into me from public.players where game_id = q.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Nur die Hider beantworten Fragen'; end if;
  if q.status <> 'pending' then raise exception 'Diese Frage ist schon erledigt'; end if;
  if r.status <> 'seeking' then raise exception 'Die Suchphase ist vorbei'; end if;
  if now() > q.deadline + interval '15 seconds' then raise exception 'Die Antwortzeit ist abgelaufen'; end if;

  if hs._is_photo_question(q.qkey) then
    if p_path is null or p_path not like q.game_id || '/%' then raise exception 'Bitte macht ein Foto'; end if;
  elsif coalesce(btrim(p_text), '') = '' then
    raise exception 'Bitte gebt eine Antwort ein';
  end if;

  update public.questions
     set status = 'answered', answer = nullif(left(btrim(coalesce(p_text, '')), 200), ''),
         answer_path = p_path, answered_at = now()
   where id = q.id;
  update public.round_coins set coins = coins + q.cost,
         last_endgame_at = case when q.category = 'endspiel' then now() else last_endgame_at end
   where round_id = r.id and party_id = q.party_id;
end $$;

-- -----------------------------------------------------------------------------
-- Würfeln und Blockaden
-- -----------------------------------------------------------------------------

create or replace function public.roll_dice(p_round uuid, p_party uuid, p_dice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r      public.rounds;
  me     public.players;
  rc     public.round_coins;
  v_rolls int[] := '{}';
  v_sum  int := 0;
  v_opts int[];
  b      public.blockades;
  i      int;
  d      int;
begin
  select * into r from public.rounds where id = p_round for update;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Nur die Hider würfeln'; end if;
  if r.status <> 'seeking' then raise exception 'Gewürfelt wird während der Suchphase'; end if;
  if p_dice not in (1, 2) then raise exception 'Ein oder zwei Würfel'; end if;
  if exists (select 1 from public.blockades where round_id = r.id and status = 'choosing') then
    raise exception 'Wählt erst eure Blockade aus dem letzten Wurf';
  end if;

  select * into rc from public.round_coins where round_id = r.id and party_id = p_party for update;
  if rc.round_id is null then raise exception 'Unbekanntes Team'; end if;
  if rc.coins < 10 * p_dice then raise exception 'Nicht genug Münzen von diesem Team'; end if;

  for i in 1..p_dice loop
    d := 1 + floor(random() * 6)::int;
    v_rolls := v_rolls || d;
    v_sum := v_sum + d;
  end loop;

  update public.round_coins set coins = coins - 10 * p_dice where round_id = r.id and party_id = p_party;

  if rc.choice_token then
    select array_agg(distinct x order by x) into v_opts
      from unnest(array[greatest(1, v_sum - 1), v_sum, least(12, v_sum + 1)]) x;
    update public.round_coins set choice_token = false where round_id = r.id and party_id = p_party;
    insert into public.blockades (round_id, game_id, party_id, dice, rolls, options, status)
    values (r.id, r.game_id, p_party, p_dice, v_rolls, v_opts, 'choosing')
    returning * into b;
  else
    insert into public.blockades (round_id, game_id, party_id, dice, rolls, value, status)
    values (r.id, r.game_id, p_party, p_dice, v_rolls, v_sum, 'held')
    returning * into b;
    perform hs._apply_value(b.id);
    select * into b from public.blockades where id = b.id;
  end if;

  return to_jsonb(b) - 'round_id' - 'game_id';
end $$;

create or replace function public.choose_blockade(p_blockade uuid, p_value int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.blockades; r public.rounds; me public.players;
begin
  select * into b from public.blockades where id = p_blockade for update;
  select * into r from public.rounds where id = b.round_id;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Kein Zugriff'; end if;
  if b.status <> 'choosing' then raise exception 'Hier gibt es nichts mehr zu wählen'; end if;
  if not (p_value = any (b.options)) then raise exception 'Diese Zahl steht nicht zur Wahl'; end if;
  update public.blockades set value = p_value, status = 'held' where id = b.id;
  perform hs._apply_value(b.id);
  select * into b from public.blockades where id = p_blockade;
  return to_jsonb(b) - 'round_id' - 'game_id';
end $$;

create or replace function public.play_blockade(p_blockade uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.blockades; r public.rounds; me public.players; v_min int;
begin
  select * into b from public.blockades where id = p_blockade for update;
  select * into r from public.rounds where id = b.round_id for update;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.party_id is distinct from r.hider_party_id then raise exception 'Nur die Hider setzen Blockaden ein'; end if;
  if r.status <> 'seeking' then raise exception 'Blockaden gibt es nur in der Suchphase'; end if;
  if b.status <> 'held' then raise exception 'Diese Blockade kann nicht mehr eingesetzt werden'; end if;
  if b.value = 12 and r.endgame_at is null then raise exception 'Flucht geht erst im Endspiel'; end if;
  if exists (select 1 from public.blockades
              where round_id = r.id and party_id = b.party_id and status = 'active') then
    raise exception 'Gegen dieses Team läuft schon eine Blockade';
  end if;
  v_min := case b.value when 5 then 2 when 6 then 2 when 7 then 5 when 10 then 5 when 12 then 2 end;
  update public.blockades
     set status = 'active', played_at = now(),
         ends_at = case when v_min is not null then now() + make_interval(mins => v_min) end
   where id = b.id;
end $$;

-- Seeker melden eine Blockade ohne Timer als erledigt (3, 4, 5, 8, 9)
create or replace function public.complete_blockade(p_blockade uuid, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.blockades; me public.players;
begin
  select * into b from public.blockades where id = p_blockade for update;
  select * into me from public.players where game_id = b.game_id and user_id = auth.uid();
  if me.party_id is distinct from b.party_id then raise exception 'Kein Zugriff'; end if;
  if b.status <> 'active' then return; end if;
  if b.value not in (3, 4, 5, 8, 9) then raise exception 'Diese Blockade endet von selbst'; end if;
  if b.value = 5 then
    if now() < b.ends_at then
      raise exception 'Noch % s an der Blume riechen', ceil(extract(epoch from (b.ends_at - now())))::int;
    end if;
    if coalesce(btrim(p_note), '') = '' then raise exception 'Schreibt den Hidern eure Erkenntnis'; end if;
  end if;
  update public.blockades
     set status = 'done', done_at = now(), note = nullif(left(btrim(coalesce(p_note, '')), 200), '')
   where id = b.id;
end $$;

-- -----------------------------------------------------------------------------
-- Gefunden
-- -----------------------------------------------------------------------------

-- Seeker melden einen Fund. Geprüft wird über die Position: Ist niemand aus der
-- Hider-Partei im Umkreis von 40 m, zählt die Suchzeit 8 Minuten mehr.
-- Wertung „Minuten-Topf“: Die Hider bekommen die Suchzeit (höchstens den Topf),
-- das Such-Team, das findet, den Rest – mindestens 10 Minuten Fundprämie.
create or replace function public.report_found(p_round uuid, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_radius constant int := 40;
  c_bonus  constant int := 10;
  r       public.rounds;
  g       public.games;
  v_hider int;
  v_finder int;
  me      public.players;
  v_d     double precision;
  v_min   int;
  v_was   boolean;
  v_next  uuid;
begin
  perform hs._tick((select game_id from public.rounds where id = p_round));
  select * into r from public.rounds where id = p_round for update;
  select * into g from public.games where id = r.game_id;
  select * into me from public.players where game_id = r.game_id and user_id = auth.uid();
  if me.party_id is null or me.party_id = r.hider_party_id then raise exception 'Nur Seeker melden einen Fund'; end if;
  if r.status <> 'seeking' then raise exception 'Gerade wird nicht gesucht'; end if;
  if p_lat is null or p_lng is null then raise exception 'Dein Standort ist unbekannt'; end if;

  -- kleinster Abstand zu einem Mitglied der Hider-Partei, sonst zum Versteck
  select min(hs._dist(p_lat, p_lng, pos.lat, pos.lng)) into v_d
    from public.positions pos join public.players pl on pl.id = pos.player_id
   where pl.party_id = r.hider_party_id;
  if v_d is null and r.hide_lat is not null then v_d := hs._dist(p_lat, p_lng, r.hide_lat, r.hide_lng); end if;
  if v_d is null then raise exception 'Die Position der Hider ist noch unbekannt'; end if;

  if v_d > c_radius then
    update public.rounds
       set seeking_started_at = seeking_started_at - interval '8 minutes',
           penalty_minutes = penalty_minutes + 8
     where id = r.id;
    return jsonb_build_object('found', false, 'penalty_minutes', 8);
  end if;

  v_min := floor(extract(epoch from (now() - r.seeking_started_at)) / 60)::int;
  v_hider := least(v_min, g.round_pot_minutes);
  v_finder := greatest(c_bonus, g.round_pot_minutes - v_min);

  update public.rounds
     set status = 'found', found_at = now(), found_by_party_id = me.party_id, seek_minutes = v_min,
         hider_award = v_hider, finder_award = v_finder
   where id = r.id;
  update public.parties set minutes = minutes + v_hider where id = r.hider_party_id;
  update public.parties set minutes = minutes + v_finder where id = me.party_id;
  update public.blockades set status = 'void' where round_id = r.id and status in ('choosing', 'held', 'active');
  update public.questions set status = 'expired', answered_at = now() where round_id = r.id and status = 'pending';

  if not exists (select 1 from public.parties where game_id = r.game_id and not was_hider) then
    update public.games set status = 'finished', finished_at = now() where id = r.game_id;
    perform hs._clear_positions(r.game_id);
    return jsonb_build_object('found', true, 'finished', true);
  end if;

  select was_hider into v_was from public.parties where id = me.party_id;
  if v_was then
    select id into v_next from public.parties
     where game_id = r.game_id and not was_hider order by random() limit 1;
  else
    v_next := me.party_id;
  end if;
  perform hs._new_round(r.game_id, v_next);
  return jsonb_build_object('found', true);
end $$;

-- -----------------------------------------------------------------------------
-- Fotos (Storage-Bucket „photos“, Ordner = Spiel-ID)
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 6291456, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "hideseek photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member((storage.foldername(name))[1]));
create policy "hideseek photos select" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member((storage.foldername(name))[1]));

-- -----------------------------------------------------------------------------
-- Rechte: die öffentlichen RPCs für angemeldete (auch anonyme) Nutzer.
-- Interne Funktionen liegen in hs und sind über die API nicht erreichbar.
-- -----------------------------------------------------------------------------

grant execute on function
  public.is_member(text),
  public.check_game(text),
  public.get_field(text),
  public.get_state(text),
  public.create_game(jsonb),
  public.join_game(text, text),
  public.leave_game(text),
  public.start_game(text, jsonb),
  public.end_game(text),
  public.confirm_ready(uuid),
  public.update_position(text, double precision, double precision, double precision),
  public.confirm_hidden(uuid, double precision, double precision),
  public.ask_question(uuid, text, double precision, double precision, text),
  public.set_suggestion(uuid, text, text),
  public.answer_question(uuid, text, text),
  public.roll_dice(uuid, uuid, int),
  public.choose_blockade(uuid, int),
  public.play_blockade(uuid),
  public.complete_blockade(uuid, text),
  public.report_found(uuid, double precision, double precision)
to authenticated;

-- Nicht angemeldete Aufrufer (anon) brauchen die Spiel-Funktionen nicht.
-- Angemeldete Spieler – auch anonyme – behalten den Zugriff über die Grants.
revoke execute on function
  public.is_member(text), public.check_game(text), public.get_field(text), public.get_state(text),
  public.create_game(jsonb), public.join_game(text, text), public.leave_game(text),
  public.start_game(text, jsonb), public.end_game(text), public.confirm_ready(uuid),
  public.update_position(text, double precision, double precision, double precision),
  public.confirm_hidden(uuid, double precision, double precision),
  public.ask_question(uuid, text, double precision, double precision, text),
  public.set_suggestion(uuid, text, text), public.answer_question(uuid, text, text),
  public.roll_dice(uuid, uuid, int), public.choose_blockade(uuid, int),
  public.play_blockade(uuid), public.complete_blockade(uuid, text), public.report_found(uuid, double precision, double precision)
from public, anon;
