-- ============ nouvelles colonnes ============
alter table public.profiles
  add column elo       int not null default 1000,
  add column elo_games int not null default 0;

create index profiles_elo_idx on public.profiles (elo desc);

create type public.game_mode as enum ('duel', 'solo');

alter table public.games
  add column mode                 public.game_mode not null default 'duel',
  add column ai_level             smallint check (ai_level between 1 and 3),
  add column turn_started_at      timestamptz,
  add column host_elo_delta       int,
  add column guest_elo_delta      int,
  add column rematch_requested_by uuid references public.profiles(id) on delete set null,
  add column rematch_declined     boolean not null default false;

-- 'human' = coup joué par la personne, 'timeout' = coup automatique après 30 s,
-- 'ai' = coup de l'ordinateur en mode solo
alter table public.moves
  add column source text not null default 'human'
    check (source in ('human', 'timeout', 'ai'));

update public.games set turn_started_at = coalesce(last_move_at, started_at) where status = 'playing';

-- ============ Elo ============
create or replace function public.settle_elo(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  g public.games;
  ra int; rb int; ka int; kb int; ea numeric; sa numeric; da int; db int;
begin
  select * into g from public.games where id = p_game;
  if g.mode <> 'duel' or g.guest_id is null or g.status <> 'finished' then return; end if;
  if g.host_elo_delta is not null then return; end if;   -- déjà réglé

  select elo, case when elo_games < 10 then 40 else 24 end into ra, ka
    from public.profiles where id = g.host_id;
  select elo, case when elo_games < 10 then 40 else 24 end into rb, kb
    from public.profiles where id = g.guest_id;

  ea := 1.0 / (1.0 + power(10.0, (rb - ra) / 400.0));
  sa := case when g.result = 'draw' then 0.5
             when g.winner_id = g.host_id then 1.0 else 0.0 end;
  da := round(ka * (sa - ea));
  db := round(kb * ((1.0 - sa) - (1.0 - ea)));

  update public.profiles set elo = elo + da, elo_games = elo_games + 1 where id = g.host_id;
  update public.profiles set elo = elo + db, elo_games = elo_games + 1 where id = g.guest_id;
  update public.games set host_elo_delta = da, guest_elo_delta = db where id = g.id;
end $fn$;

-- ============ pose d'un jeton (cœur commun) ============
create or replace function public.apply_move(p_game uuid, p_player uuid,
                                             p_color public.disc_color, p_col int, p_source text)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare
  g public.games; ch text; r int := null; i int; nb text; line int[]; fini boolean;
begin
  select * into g from public.games where id = p_game for update;
  if g.status <> 'playing' then raise exception 'GAME_NOT_PLAYING'; end if;
  if p_col < 0 or p_col > 6 then raise exception 'BAD_COLUMN'; end if;
  if p_color <> g.turn then raise exception 'NOT_YOUR_TURN'; end if;

  for i in 0..5 loop
    if public.cell_at(g.board, i, p_col) = '.' then r := i; exit; end if;
  end loop;
  if r is null then raise exception 'COLUMN_FULL'; end if;

  ch := case when p_color = 'yellow' then 'y' else 'r' end;
  nb := overlay(g.board placing ch from r * 7 + p_col + 1 for 1);
  line := public.winning_line(nb, r, p_col, ch);
  fini := line is not null or g.move_count + 1 = 42;

  insert into public.moves (game_id, player_id, move_number, col, row, color, source)
  values (g.id, p_player, g.move_count + 1, p_col, r, p_color, p_source);

  update public.games set
    board           = nb,
    move_count      = g.move_count + 1,
    last_move_at    = now(),
    turn_started_at = now(),
    turn            = case when line is not null then g.turn
                           else (case when g.turn = 'yellow' then 'red' else 'yellow' end)::public.disc_color end,
    status          = case when fini then 'finished'::public.game_status else 'playing'::public.game_status end,
    result          = case when line is not null then 'win'::public.game_result
                           when fini then 'draw'::public.game_result end,
    -- en solo, une victoire de l'ordinateur ne crédite personne
    winner_id       = case when line is not null and p_source <> 'ai' then p_player end,
    winning_line    = line,
    finished_at     = case when fini then now() end
  where id = g.id
  returning * into g;

  if fini then
    perform public.settle_elo(g.id);
    select * into g from public.games where id = g.id;
  end if;
  return g;
end $fn$;

-- ============ jouer un coup ============
create or replace function public.play_move(p_game uuid, p_col int)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid(); g public.games; my_color public.disc_color; src text := 'human';
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;

  if g.mode = 'solo' then
    if me <> g.host_id then raise exception 'NOT_A_PLAYER'; end if;
    -- le navigateur joue les deux couleurs : la sienne et celle de l'ordinateur
    my_color := g.turn;
    if g.turn <> g.host_color then src := 'ai'; end if;
  elsif me = g.host_id then
    my_color := g.host_color;
  elsif me = g.guest_id then
    my_color := (case when g.host_color = 'yellow' then 'red' else 'yellow' end)::public.disc_color;
  else
    raise exception 'NOT_A_PLAYER';
  end if;

  return public.apply_move(g.id, g.host_id, my_color, p_col,
                           case when g.mode = 'solo' then src else 'human' end);
end $fn$;

-- ============ horloge : 30 s par coup ============
-- Appelable par les deux joueurs ; c'est le serveur qui juge du délai écoulé.
-- Passé le délai, un coup est joué au hasard parmi les colonnes libres.
create or replace function public.timeout_move(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid(); g public.games; cols int[]; c int; joueur uuid;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if me <> g.host_id and me is distinct from g.guest_id then raise exception 'NOT_A_PLAYER'; end if;
  if g.status <> 'playing' then return g; end if;
  if now() < coalesce(g.turn_started_at, g.started_at) + interval '30 seconds' then
    return g;                       -- pas encore expiré : rien à faire
  end if;

  select array_agg(i) into cols from generate_series(0, 6) i
   where public.cell_at(g.board, 5, i) = '.';
  if cols is null then return g; end if;
  c := cols[1 + floor(random() * array_length(cols, 1))::int];

  joueur := case when g.mode = 'solo' then g.host_id
                 when g.turn = g.host_color then g.host_id else g.guest_id end;
  return public.apply_move(g.id, joueur, g.turn, c,
                           case when g.mode = 'solo' and g.turn <> g.host_color then 'ai' else 'timeout' end);
end $fn$;

-- ============ partie solo ============
create or replace function public.create_solo_game(p_level int)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_level is null or p_level < 1 or p_level > 3 then raise exception 'BAD_LEVEL'; end if;

  insert into public.games (code, host_id, host_color, status, turn, mode, ai_level,
                            started_at, turn_started_at)
  values (public.new_game_code(), me,
          (case when random() < 0.5 then 'yellow' else 'red' end)::public.disc_color,
          'playing', 'yellow', 'solo', p_level, now(), now())
  returning * into g;
  return g;
end $fn$;

-- ============ démarrage d'une partie : armer l'horloge ============
create or replace function public.join_game(p_code text)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games
   where code = upper(trim(p_code)) and status in ('waiting','playing') and mode = 'duel'
   order by created_at desc limit 1
   for update;

  if not found then raise exception 'CODE_NOT_FOUND'; end if;
  if g.status = 'playing' then
    if me = g.host_id or me = g.guest_id then return g; end if;
    raise exception 'GAME_ALREADY_STARTED';
  end if;
  if g.host_id = me then raise exception 'CANNOT_JOIN_OWN_GAME'; end if;

  update public.games set
    guest_id        = me,
    host_color      = (case when random() < 0.5 then 'yellow' else 'red' end)::public.disc_color,
    status          = 'playing',
    turn            = 'yellow',
    started_at      = now(),
    turn_started_at = now()
  where id = g.id
  returning * into g;
  return g;
end $fn$;

-- ============ abandon : régler l'Elo aussi ============
create or replace function public.forfeit_game(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if me <> g.host_id and me is distinct from g.guest_id then raise exception 'NOT_A_PLAYER'; end if;

  if g.status = 'waiting' then
    update public.games set status = 'cancelled' where id = g.id returning * into g;
    return g;
  end if;
  if g.status <> 'playing' then raise exception 'GAME_NOT_PLAYING'; end if;

  update public.games set
    status      = 'finished',
    result      = 'forfeit',
    winner_id   = case when g.mode = 'solo' then null
                       when me = g.host_id then g.guest_id else g.host_id end,
    finished_at = now()
  where id = g.id
  returning * into g;

  perform public.settle_elo(g.id);
  select * into g from public.games where id = g.id;
  return g;
end $fn$;

-- ============ revanche : demande, acceptation, refus ============
create or replace function public.request_rematch(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games; ng public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if g.status <> 'finished' then raise exception 'GAME_NOT_FINISHED'; end if;
  if me <> g.host_id and me is distinct from g.guest_id then raise exception 'NOT_A_PLAYER'; end if;
  if g.rematch_id is not null then
    select * into ng from public.games where id = g.rematch_id;
    return ng;
  end if;

  -- en solo, personne à consulter : on relance directement
  if g.mode = 'solo' then
    ng := public.create_solo_game(g.ai_level);
    update public.games set rematch_id = ng.id where id = g.id;
    return ng;
  end if;

  -- si l'adversaire avait déjà demandé, la demande vaut acceptation
  if g.rematch_requested_by is not null and g.rematch_requested_by <> me then
    return public.accept_rematch(g.id);
  end if;

  update public.games set rematch_requested_by = me, rematch_declined = false
   where id = g.id returning * into g;
  return g;
end $fn$;

create or replace function public.accept_rematch(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games; ng public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if me <> g.host_id and me is distinct from g.guest_id then raise exception 'NOT_A_PLAYER'; end if;
  if g.rematch_id is not null then
    select * into ng from public.games where id = g.rematch_id;
    return ng;
  end if;
  if g.rematch_requested_by is null then raise exception 'NO_REMATCH_REQUEST'; end if;

  insert into public.games (code, host_id, guest_id, host_color, status, turn,
                            started_at, turn_started_at)
  values (public.new_game_code(), g.host_id, g.guest_id,
          (case when random() < 0.5 then 'yellow' else 'red' end)::public.disc_color,
          'playing', 'yellow', now(), now())
  returning * into ng;

  update public.games set rematch_id = ng.id where id = g.id;
  return ng;
end $fn$;

create or replace function public.decline_rematch(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if me <> g.host_id and me is distinct from g.guest_id then raise exception 'NOT_A_PLAYER'; end if;
  if g.rematch_requested_by is null or g.rematch_requested_by = me then
    raise exception 'NO_REMATCH_REQUEST';
  end if;

  update public.games set rematch_requested_by = null, rematch_declined = true
   where id = g.id returning * into g;
  return g;
end $fn$;

-- conservée pour ne pas casser un onglet resté ouvert sur l'ancienne version
create or replace function public.rematch(p_game uuid)
returns public.games language plpgsql security definer set search_path = '' as $fn$
begin
  return public.request_rematch(p_game);
end $fn$;

-- ============ vue et statistiques ============
drop view if exists public.player_games;
create view public.player_games with (security_invoker = on) as
  select g.id as game_id, g.code, g.host_id as player_id, g.guest_id as opponent_id,
         g.host_color as color, g.result, g.move_count, g.finished_at,
         g.mode, g.ai_level, g.host_elo_delta as elo_delta,
         case when g.result = 'draw' then 'draw'
              when g.winner_id = g.host_id then 'win' else 'loss' end as outcome
    from public.games g
   where g.status = 'finished'
  union all
  select g.id, g.code, g.guest_id, g.host_id,
         (case when g.host_color = 'yellow' then 'red' else 'yellow' end)::public.disc_color,
         g.result, g.move_count, g.finished_at,
         g.mode, g.ai_level, g.guest_elo_delta,
         case when g.result = 'draw' then 'draw'
              when g.winner_id = g.guest_id then 'win' else 'loss' end
    from public.games g
   where g.status = 'finished' and g.guest_id is not null;

create or replace function public.stats_overview()
returns jsonb language plpgsql stable security invoker set search_path = public as $fn$
declare
  me uuid := auth.uid();
  total int; wins int; losses int; draws int;
  cur_streak int := 0; cur_kind text := null; best_win int := 0; run int := 0;
  avg_moves numeric; fastest int; rec record; mon_elo int; mon_rang int;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;

  select count(*)::int,
         count(*) filter (where outcome = 'win')::int,
         count(*) filter (where outcome = 'loss')::int,
         count(*) filter (where outcome = 'draw')::int,
         round(avg(move_count), 1),
         min(move_count) filter (where outcome = 'win')
    into total, wins, losses, draws, avg_moves, fastest
    from public.player_games where player_id = me and mode = 'duel';

  for rec in select outcome from public.player_games
              where player_id = me and mode = 'duel' order by finished_at desc loop
    if cur_kind is null then cur_kind := rec.outcome; end if;
    exit when rec.outcome <> cur_kind;
    cur_streak := cur_streak + 1;
  end loop;

  for rec in select outcome from public.player_games
              where player_id = me and mode = 'duel' order by finished_at asc loop
    if rec.outcome = 'win' then
      run := run + 1;
      if run > best_win then best_win := run; end if;
    else run := 0; end if;
  end loop;

  select elo into mon_elo from public.profiles where id = me;
  select count(*)::int + 1 into mon_rang from public.profiles
   where elo > mon_elo and elo_games > 0;

  return jsonb_build_object(
    'total', coalesce(total, 0), 'wins', coalesce(wins, 0),
    'losses', coalesce(losses, 0), 'draws', coalesce(draws, 0),
    'win_rate', case when coalesce(total, 0) = 0 then null else round(100.0 * wins / total, 1) end,
    'ratio', case when coalesce(losses, 0) = 0 then null else round(wins::numeric / losses, 2) end,
    'avg_moves', avg_moves, 'fastest_win', fastest,
    'streak_kind', cur_kind, 'streak', cur_streak, 'best_win_streak', best_win,
    'elo', mon_elo, 'rank', mon_rang
  );
end $fn$;

create or replace function public.stats_by_color()
returns table (color public.disc_color, games int, wins int, losses int, draws int, win_rate numeric)
language sql stable security invoker set search_path = public as $fn$
  select pg.color, count(*)::int,
         count(*) filter (where pg.outcome = 'win')::int,
         count(*) filter (where pg.outcome = 'loss')::int,
         count(*) filter (where pg.outcome = 'draw')::int,
         round(100.0 * count(*) filter (where pg.outcome = 'win') / nullif(count(*), 0), 1)
    from public.player_games pg
   where pg.player_id = auth.uid() and pg.mode = 'duel'
   group by pg.color order by pg.color;
$fn$;

create or replace function public.stats_by_opponent()
returns table (opponent_id uuid, username text, games int, wins int, losses int, draws int,
               win_rate numeric, ratio numeric, last_played timestamptz)
language sql stable security invoker set search_path = public as $fn$
  select pg.opponent_id, p.username, count(*)::int,
         count(*) filter (where pg.outcome = 'win')::int,
         count(*) filter (where pg.outcome = 'loss')::int,
         count(*) filter (where pg.outcome = 'draw')::int,
         round(100.0 * count(*) filter (where pg.outcome = 'win') / nullif(count(*), 0), 1),
         round(count(*) filter (where pg.outcome = 'win')::numeric
               / nullif(count(*) filter (where pg.outcome = 'loss'), 0), 2),
         max(pg.finished_at)
    from public.player_games pg
    join public.profiles p on p.id = pg.opponent_id
   where pg.player_id = auth.uid() and pg.mode = 'duel'
   group by pg.opponent_id, p.username
   order by count(*) desc, max(pg.finished_at) desc;
$fn$;

create or replace function public.stats_vs_ai()
returns table (level smallint, games int, wins int, losses int, draws int, win_rate numeric)
language sql stable security invoker set search_path = public as $fn$
  select pg.ai_level, count(*)::int,
         count(*) filter (where pg.outcome = 'win')::int,
         count(*) filter (where pg.outcome = 'loss')::int,
         count(*) filter (where pg.outcome = 'draw')::int,
         round(100.0 * count(*) filter (where pg.outcome = 'win') / nullif(count(*), 0), 1)
    from public.player_games pg
   where pg.player_id = auth.uid() and pg.mode = 'solo'
   group by pg.ai_level order by pg.ai_level;
$fn$;

drop function if exists public.game_history(int, int);
create or replace function public.game_history(p_limit int default 25, p_offset int default 0)
returns table (game_id uuid, code text, opponent text, color public.disc_color,
               outcome text, result public.game_result, move_count int,
               finished_at timestamptz, mode public.game_mode, ai_level smallint, elo_delta int)
language sql stable security invoker set search_path = public as $fn$
  select pg.game_id, pg.code,
         coalesce(p.username, 'Ordinateur'), pg.color, pg.outcome, pg.result,
         pg.move_count, pg.finished_at, pg.mode, pg.ai_level, pg.elo_delta
    from public.player_games pg
    left join public.profiles p on p.id = pg.opponent_id
   where pg.player_id = auth.uid()
   order by pg.finished_at desc
   limit least(coalesce(p_limit, 25), 100) offset greatest(coalesce(p_offset, 0), 0);
$fn$;

-- ============ classement ============
create or replace function public.leaderboard(p_limit int default 20)
returns table (rank int, player_id uuid, username text, elo int, played int, wins int, is_me boolean)
language sql stable security definer set search_path = '' as $fn$
  select (row_number() over (order by p.elo desc, p.username))::int,
         p.id, p.username, p.elo, p.elo_games,
         (select count(*)::int from public.games g
           where g.status = 'finished' and g.mode = 'duel' and g.winner_id = p.id),
         p.id = auth.uid()
    from public.profiles p
   where p.elo_games > 0 or p.id = auth.uid()
   order by p.elo desc, p.username
   limit least(coalesce(p_limit, 20), 100);
$fn$;

-- ============ droits ============
revoke all on function public.apply_move(uuid, uuid, public.disc_color, int, text) from public, anon, authenticated;
revoke all on function public.settle_elo(uuid) from public, anon, authenticated;

revoke all on function public.timeout_move(uuid), public.create_solo_game(int),
  public.request_rematch(uuid), public.accept_rematch(uuid), public.decline_rematch(uuid),
  public.stats_vs_ai(), public.leaderboard(int), public.game_history(int, int)
  from public, anon;

grant execute on function public.timeout_move(uuid), public.create_solo_game(int),
  public.request_rematch(uuid), public.accept_rematch(uuid), public.decline_rematch(uuid),
  public.stats_vs_ai(), public.leaderboard(int), public.game_history(int, int)
  to authenticated;
