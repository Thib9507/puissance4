-- =========================================================
-- Puissance 4 — schéma initial
-- Toute la logique de jeu est appliquée côté serveur (RPC
-- SECURITY DEFINER) : le client ne peut pas écrire le plateau.
-- Plateau : 42 caractères, index = ligne*7 + colonne,
-- ligne 0 = bas de la grille. '.' vide, 'y' jaune, 'r' rouge.
-- =========================================================

create type public.disc_color  as enum ('yellow','red');
create type public.game_status as enum ('waiting','playing','finished','cancelled');
create type public.game_result as enum ('win','draw','forfeit');

-- ---------- profils ----------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique check (char_length(username) between 3 and 20),
  created_at timestamptz not null default now()
);

-- ---------- parties ----------
create table public.games (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  host_id      uuid not null references public.profiles(id) on delete cascade,
  guest_id     uuid references public.profiles(id) on delete cascade,
  host_color   public.disc_color,
  status       public.game_status not null default 'waiting',
  board        text not null default repeat('.', 42) check (char_length(board) = 42),
  turn         public.disc_color not null default 'yellow',  -- les jaunes commencent toujours
  move_count   int not null default 0,
  winner_id    uuid references public.profiles(id),
  result       public.game_result,
  winning_line int[],
  rematch_id   uuid references public.games(id),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  last_move_at timestamptz,
  constraint guest_is_not_host check (guest_id is null or guest_id <> host_id)
);

create index games_host_idx     on public.games(host_id);
create index games_guest_idx    on public.games(guest_id);
create index games_code_idx     on public.games(code);
create index games_finished_idx on public.games(finished_at desc);
-- un code ne peut être actif que sur une seule partie à la fois
create unique index games_active_code_idx on public.games(code)
  where status in ('waiting','playing');

-- ---------- coups ----------
create table public.moves (
  id          bigserial primary key,
  game_id     uuid not null references public.games(id) on delete cascade,
  player_id   uuid not null references public.profiles(id) on delete cascade,
  move_number int not null,
  col         int not null check (col between 0 and 6),
  row         int not null check (row between 0 and 5),
  color       public.disc_color not null,
  created_at  timestamptz not null default now(),
  unique (game_id, move_number)
);
create index moves_game_idx on public.moves(game_id, move_number);

-- =========================================================
-- Helpers plateau
-- =========================================================
create or replace function public.cell_at(b text, r int, c int)
returns text language sql immutable parallel safe as $fn$
  select substr(b, r * 7 + c + 1, 1)
$fn$;

-- Index des cellules alignées (>= 4) passant par (r,c), sinon null
create or replace function public.winning_line(b text, r int, c int, ch text)
returns int[] language plpgsql immutable as $fn$
declare
  dirs int[] := array[[0,1],[1,0],[1,1],[1,-1]];
  d int; k int; rr int; cc int; line int[];
begin
  for d in 1..4 loop
    line := array[r * 7 + c];
    for k in 1..3 loop
      rr := r + dirs[d][1] * k; cc := c + dirs[d][2] * k;
      exit when rr < 0 or rr > 5 or cc < 0 or cc > 6 or public.cell_at(b, rr, cc) <> ch;
      line := line || (rr * 7 + cc);
    end loop;
    for k in 1..3 loop
      rr := r - dirs[d][1] * k; cc := c - dirs[d][2] * k;
      exit when rr < 0 or rr > 5 or cc < 0 or cc > 6 or public.cell_at(b, rr, cc) <> ch;
      line := line || (rr * 7 + cc);
    end loop;
    if coalesce(array_length(line, 1), 0) >= 4 then
      return line;
    end if;
  end loop;
  return null;
end $fn$;

-- Code de défi lisible (sans caractères ambigus).
-- Cette version comporte une ambiguïté entre la variable `code` et la colonne
-- `games.code` ; elle est corrigée par la migration 20260824123947 qui suit.
create or replace function public.new_game_code()
returns text language plpgsql volatile as $fn$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text; i int; tries int := 0;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * char_length(alphabet))::int, 1);
    end loop;
    exit when not exists (
      select 1 from public.games g where g.code = code and g.status in ('waiting','playing')
    );
    tries := tries + 1;
    if tries > 50 then raise exception 'CODE_GENERATION_FAILED'; end if;
  end loop;
  return code;
end $fn$;

-- =========================================================
-- Création du profil à l'inscription
-- =========================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  base text; candidate text; n int := 0;
begin
  base := coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1));
  base := regexp_replace(base, '[^A-Za-z0-9_-]', '', 'g');
  if char_length(base) < 3 then base := base || 'joueur'; end if;
  base := substr(base, 1, 16);
  candidate := base;
  while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;
  insert into public.profiles (id, username) values (new.id, candidate);
  return new;
end $fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- RPC : créer une partie
-- =========================================================
create or replace function public.create_game()
returns public.games language plpgsql security definer set search_path = public as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  -- une seule partie en attente à la fois
  update public.games set status = 'cancelled'
   where host_id = me and status = 'waiting';
  insert into public.games (code, host_id) values (public.new_game_code(), me)
  returning * into g;
  return g;
end $fn$;

-- =========================================================
-- RPC : rejoindre une partie via un code
-- Couleurs tirées au sort, les jaunes commencent toujours
-- =========================================================
create or replace function public.join_game(p_code text)
returns public.games language plpgsql security definer set search_path = public as $fn$
declare me uuid := auth.uid(); g public.games;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games
   where code = upper(trim(p_code)) and status in ('waiting','playing')
   order by created_at desc limit 1
   for update;

  if not found then raise exception 'CODE_NOT_FOUND'; end if;

  -- reconnexion à une partie déjà lancée
  if g.status = 'playing' then
    if me = g.host_id or me = g.guest_id then return g; end if;
    raise exception 'GAME_ALREADY_STARTED';
  end if;
  if g.host_id = me then raise exception 'CANNOT_JOIN_OWN_GAME'; end if;

  update public.games set
    guest_id   = me,
    host_color = (case when random() < 0.5 then 'yellow' else 'red' end)::public.disc_color,
    status     = 'playing',
    turn       = 'yellow',
    started_at = now()
  where id = g.id
  returning * into g;
  return g;
end $fn$;

-- =========================================================
-- RPC : jouer un coup
-- =========================================================
create or replace function public.play_move(p_game uuid, p_col int)
returns public.games language plpgsql security definer set search_path = public as $fn$
declare
  me uuid := auth.uid();
  g public.games;
  my_color public.disc_color;
  ch text; r int := null; i int; nb text; line int[];
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into g from public.games where id = p_game for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if g.status <> 'playing' then raise exception 'GAME_NOT_PLAYING'; end if;
  if p_col < 0 or p_col > 6 then raise exception 'BAD_COLUMN'; end if;

  if me = g.host_id then
    my_color := g.host_color;
  elsif me = g.guest_id then
    my_color := (case when g.host_color = 'yellow' then 'red' else 'yellow' end)::public.disc_color;
  else
    raise exception 'NOT_A_PLAYER';
  end if;
  if my_color <> g.turn then raise exception 'NOT_YOUR_TURN'; end if;

  for i in 0..5 loop
    if public.cell_at(g.board, i, p_col) = '.' then r := i; exit; end if;
  end loop;
  if r is null then raise exception 'COLUMN_FULL'; end if;

  ch := case when my_color = 'yellow' then 'y' else 'r' end;
  nb := overlay(g.board placing ch from r * 7 + p_col + 1 for 1);
  line := public.winning_line(nb, r, p_col, ch);

  insert into public.moves (game_id, player_id, move_number, col, row, color)
  values (g.id, me, g.move_count + 1, p_col, r, my_color);

  update public.games set
    board        = nb,
    move_count   = g.move_count + 1,
    last_move_at = now(),
    turn         = case when line is not null then g.turn
                        else (case when g.turn = 'yellow' then 'red' else 'yellow' end)::public.disc_color end,
    status       = case when line is not null or g.move_count + 1 = 42
                        then 'finished'::public.game_status else 'playing'::public.game_status end,
    result       = case when line is not null then 'win'::public.game_result
                        when g.move_count + 1 = 42 then 'draw'::public.game_result end,
    winner_id    = case when line is not null then me end,
    winning_line = line,
    finished_at  = case when line is not null or g.move_count + 1 = 42 then now() end
  where id = g.id
  returning * into g;
  return g;
end $fn$;

-- =========================================================
-- RPC : abandonner (ou annuler une partie en attente)
-- =========================================================
create or replace function public.forfeit_game(p_game uuid)
returns public.games language plpgsql security definer set search_path = public as $fn$
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
    winner_id   = case when me = g.host_id then g.guest_id else g.host_id end,
    finished_at = now()
  where id = g.id
  returning * into g;
  return g;
end $fn$;

-- =========================================================
-- RPC : revanche entre les deux mêmes joueurs
-- =========================================================
create or replace function public.rematch(p_game uuid)
returns public.games language plpgsql security definer set search_path = public as $fn$
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

  insert into public.games (code, host_id, guest_id, host_color, status, turn, started_at)
  values (public.new_game_code(), g.host_id, g.guest_id,
          (case when random() < 0.5 then 'yellow' else 'red' end)::public.disc_color,
          'playing', 'yellow', now())
  returning * into ng;

  update public.games set rematch_id = ng.id where id = g.id;
  return ng;
end $fn$;

-- =========================================================
-- Vue « une ligne par joueur et par partie terminée »
-- =========================================================
create or replace view public.player_games with (security_invoker = on) as
  select g.id as game_id, g.code, g.host_id as player_id, g.guest_id as opponent_id,
         g.host_color as color, g.result, g.move_count, g.finished_at,
         case when g.result = 'draw' then 'draw'
              when g.winner_id = g.host_id then 'win' else 'loss' end as outcome
    from public.games g
   where g.status = 'finished' and g.guest_id is not null
  union all
  select g.id, g.code, g.guest_id, g.host_id,
         (case when g.host_color = 'yellow' then 'red' else 'yellow' end)::public.disc_color,
         g.result, g.move_count, g.finished_at,
         case when g.result = 'draw' then 'draw'
              when g.winner_id = g.guest_id then 'win' else 'loss' end
    from public.games g
   where g.status = 'finished' and g.guest_id is not null;

-- =========================================================
-- Statistiques
-- =========================================================
create or replace function public.stats_overview()
returns jsonb language plpgsql stable security invoker set search_path = public as $fn$
declare
  me uuid := auth.uid();
  total int; wins int; losses int; draws int;
  cur_streak int := 0; cur_kind text := null; best_win int := 0; run int := 0;
  avg_moves numeric; fastest int; rec record;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;

  select count(*)::int,
         count(*) filter (where outcome = 'win')::int,
         count(*) filter (where outcome = 'loss')::int,
         count(*) filter (where outcome = 'draw')::int,
         round(avg(move_count), 1),
         min(move_count) filter (where outcome = 'win')
    into total, wins, losses, draws, avg_moves, fastest
    from public.player_games where player_id = me;

  -- série en cours
  for rec in select outcome from public.player_games
              where player_id = me order by finished_at desc loop
    if cur_kind is null then cur_kind := rec.outcome; end if;
    exit when rec.outcome <> cur_kind;
    cur_streak := cur_streak + 1;
  end loop;

  -- meilleure série de victoires
  for rec in select outcome from public.player_games
              where player_id = me order by finished_at asc loop
    if rec.outcome = 'win' then
      run := run + 1;
      if run > best_win then best_win := run; end if;
    else
      run := 0;
    end if;
  end loop;

  return jsonb_build_object(
    'total', coalesce(total, 0),
    'wins', coalesce(wins, 0),
    'losses', coalesce(losses, 0),
    'draws', coalesce(draws, 0),
    'win_rate', case when coalesce(total, 0) = 0 then null else round(100.0 * wins / total, 1) end,
    'ratio', case when coalesce(losses, 0) = 0 then null else round(wins::numeric / losses, 2) end,
    'avg_moves', avg_moves,
    'fastest_win', fastest,
    'streak_kind', cur_kind,
    'streak', cur_streak,
    'best_win_streak', best_win
  );
end $fn$;

create or replace function public.stats_by_color()
returns table (color public.disc_color, games int, wins int, losses int, draws int, win_rate numeric)
language sql stable security invoker set search_path = public as $fn$
  select pg.color,
         count(*)::int,
         count(*) filter (where pg.outcome = 'win')::int,
         count(*) filter (where pg.outcome = 'loss')::int,
         count(*) filter (where pg.outcome = 'draw')::int,
         round(100.0 * count(*) filter (where pg.outcome = 'win') / nullif(count(*), 0), 1)
    from public.player_games pg
   where pg.player_id = auth.uid()
   group by pg.color
   order by pg.color;
$fn$;

create or replace function public.stats_by_opponent()
returns table (opponent_id uuid, username text, games int, wins int, losses int, draws int,
               win_rate numeric, ratio numeric, last_played timestamptz)
language sql stable security invoker set search_path = public as $fn$
  select pg.opponent_id, p.username,
         count(*)::int,
         count(*) filter (where pg.outcome = 'win')::int,
         count(*) filter (where pg.outcome = 'loss')::int,
         count(*) filter (where pg.outcome = 'draw')::int,
         round(100.0 * count(*) filter (where pg.outcome = 'win') / nullif(count(*), 0), 1),
         round(count(*) filter (where pg.outcome = 'win')::numeric
               / nullif(count(*) filter (where pg.outcome = 'loss'), 0), 2),
         max(pg.finished_at)
    from public.player_games pg
    join public.profiles p on p.id = pg.opponent_id
   where pg.player_id = auth.uid()
   group by pg.opponent_id, p.username
   order by count(*) desc, max(pg.finished_at) desc;
$fn$;

create or replace function public.game_history(p_limit int default 25, p_offset int default 0)
returns table (game_id uuid, code text, opponent text, color public.disc_color,
               outcome text, result public.game_result, move_count int, finished_at timestamptz)
language sql stable security invoker set search_path = public as $fn$
  select pg.game_id, pg.code, p.username, pg.color, pg.outcome, pg.result, pg.move_count, pg.finished_at
    from public.player_games pg
    join public.profiles p on p.id = pg.opponent_id
   where pg.player_id = auth.uid()
   order by pg.finished_at desc
   limit least(coalesce(p_limit, 25), 100) offset greatest(coalesce(p_offset, 0), 0);
$fn$;

-- =========================================================
-- RLS
-- =========================================================
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.moves    enable row level security;

create policy "profils lisibles par les connectes"
  on public.profiles for select to authenticated using (true);

create policy "modifier son propre profil"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "voir ses parties"
  on public.games for select to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid());

create policy "voir les coups de ses parties"
  on public.moves for select to authenticated
  using (exists (select 1 from public.games g
                  where g.id = moves.game_id
                    and (g.host_id = auth.uid() or g.guest_id = auth.uid())));

-- aucune policy insert/update/delete : tout passe par les RPC

-- =========================================================
-- Droits d'exécution
-- =========================================================
revoke execute on function
  public.create_game(), public.join_game(text), public.play_move(uuid, int),
  public.forfeit_game(uuid), public.rematch(uuid), public.stats_overview(),
  public.stats_by_color(), public.stats_by_opponent(), public.game_history(int, int),
  public.new_game_code()
  from public, anon;

grant execute on function
  public.create_game(), public.join_game(text), public.play_move(uuid, int),
  public.forfeit_game(uuid), public.rematch(uuid), public.stats_overview(),
  public.stats_by_color(), public.stats_by_opponent(), public.game_history(int, int)
  to authenticated;

-- =========================================================
-- Realtime
-- =========================================================
alter table public.games replica identity full;
alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.moves;
