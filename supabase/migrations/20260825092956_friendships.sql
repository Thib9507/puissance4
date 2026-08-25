create type public.friend_status as enum ('pending', 'accepted', 'declined');

create table public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.friend_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint pas_soi_meme check (requester_id <> addressee_id)
);

-- une seule relation par paire, quel que soit le sens de la demande
create unique index friendships_pair_idx on public.friendships
  (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_requester_idx on public.friendships (requester_id);
create index friendships_addressee_idx on public.friendships (addressee_id);

alter table public.friendships enable row level security;

create policy "voir ses relations"
  on public.friendships for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());
-- aucune écriture directe : tout passe par les RPC ci-dessous

-- ============ recherche de joueurs ============
create or replace function public.search_players(p_query text)
returns table (id uuid, username text, elo int, relation text)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.username, p.elo,
         coalesce((
           select case when f.status = 'accepted' then 'friend'
                       when f.status = 'pending' and f.requester_id = auth.uid() then 'sent'
                       when f.status = 'pending' then 'received'
                       else 'none' end
             from public.friendships f
            where (f.requester_id = auth.uid() and f.addressee_id = p.id)
               or (f.addressee_id = auth.uid() and f.requester_id = p.id)
            limit 1), 'none')
    from public.profiles p
   where p.id <> auth.uid()
     and char_length(trim(coalesce(p_query, ''))) >= 2
     and p.username ilike trim(p_query) || '%'
   order by p.username
   limit 10;
$fn$;

-- ============ demandes d'ami ============
create or replace function public.send_friend_request(p_user uuid)
returns public.friendships language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); f public.friendships;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_user is null or p_user = me then raise exception 'BAD_TARGET'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  select * into f from public.friendships
   where (requester_id = me and addressee_id = p_user)
      or (requester_id = p_user and addressee_id = me)
   for update;

  if found then
    if f.status = 'accepted' then return f; end if;
    if f.status = 'pending' then
      -- l'autre avait déjà demandé : la demande vaut acceptation
      if f.addressee_id = me then
        update public.friendships set status = 'accepted', responded_at = now()
         where id = f.id returning * into f;
      end if;
      return f;
    end if;
    -- relation refusée par le passé : on repart d'une demande neuve
    update public.friendships
       set requester_id = me, addressee_id = p_user, status = 'pending',
           created_at = now(), responded_at = null
     where id = f.id returning * into f;
    return f;
  end if;

  insert into public.friendships (requester_id, addressee_id)
  values (me, p_user) returning * into f;
  return f;
end $fn$;

create or replace function public.accept_friend_request(p_user uuid)
returns public.friendships language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); f public.friendships;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.friendships set status = 'accepted', responded_at = now()
   where requester_id = p_user and addressee_id = me and status = 'pending'
  returning * into f;
  if not found then raise exception 'NO_FRIEND_REQUEST'; end if;
  return f;
end $fn$;

create or replace function public.decline_friend_request(p_user uuid)
returns public.friendships language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); f public.friendships;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.friendships set status = 'declined', responded_at = now()
   where requester_id = p_user and addressee_id = me and status = 'pending'
  returning * into f;
  if not found then raise exception 'NO_FRIEND_REQUEST'; end if;
  return f;
end $fn$;

-- annule une demande que j'ai envoyée, ou supprime une amitié existante
create or replace function public.remove_friend(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  delete from public.friendships
   where (requester_id = me and addressee_id = p_user)
      or (requester_id = p_user and addressee_id = me);
end $fn$;

-- ============ listes ============
create or replace function public.my_friends()
returns table (id uuid, username text, elo int, friends_since timestamptz,
               games int, wins int, losses int, draws int)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.username, p.elo, f.responded_at,
         count(g.*)::int,
         count(g.*) filter (where g.result <> 'draw' and g.winner_id = auth.uid())::int,
         count(g.*) filter (where g.result <> 'draw' and g.winner_id is distinct from auth.uid())::int,
         count(g.*) filter (where g.result = 'draw')::int
    from public.friendships f
    join public.profiles p
      on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
    left join public.games g
      on g.status = 'finished' and g.mode = 'duel'
     and ((g.host_id = auth.uid() and g.guest_id = p.id)
       or (g.host_id = p.id and g.guest_id = auth.uid()))
   where f.status = 'accepted'
     and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
   group by p.id, p.username, p.elo, f.responded_at
   order by p.username;
$fn$;

create or replace function public.friend_requests()
returns table (user_id uuid, username text, elo int, direction text, created_at timestamptz)
language sql stable security definer set search_path = '' as $fn$
  select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end,
         p.username, p.elo,
         case when f.requester_id = auth.uid() then 'sent' else 'received' end,
         f.created_at
    from public.friendships f
    join public.profiles p
      on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
   where f.status = 'pending'
     and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
   order by f.created_at desc;
$fn$;

-- ============ fiche détaillée d'un ami ============
-- Réservée aux amis acceptés : c'est la contrepartie du fait d'accepter
-- quelqu'un, personne d'autre ne voit ces chiffres.
create or replace function public.friend_profile(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid();
  prof record; total int; wins int; losses int; draws int; avg_moves numeric;
  rang int; couleurs jsonb; face jsonb; recentes jsonb; best int := 0; run int := 0; rec record;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_user <> me and not exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = me and f.addressee_id = p_user)
            or (f.requester_id = p_user and f.addressee_id = me))) then
    raise exception 'NOT_A_FRIEND';
  end if;

  select p.username, p.elo, p.elo_games, p.created_at into prof
    from public.profiles p where p.id = p_user;
  if prof is null then raise exception 'PLAYER_NOT_FOUND'; end if;

  select count(*)::int + 1 into rang from public.profiles
   where elo > prof.elo and elo_games > 0;

  select count(*)::int,
         count(*) filter (where g.result <> 'draw' and g.winner_id = p_user)::int,
         count(*) filter (where g.result <> 'draw' and g.winner_id is distinct from p_user)::int,
         count(*) filter (where g.result = 'draw')::int,
         round(avg(g.move_count), 1)
    into total, wins, losses, draws, avg_moves
    from public.games g
   where g.status = 'finished' and g.mode = 'duel'
     and (g.host_id = p_user or g.guest_id = p_user);

  select jsonb_agg(jsonb_build_object('color', c.color, 'games', c.n, 'wins', c.v,
                                      'win_rate', round(100.0 * c.v / nullif(c.n, 0), 1))
                   order by c.color)
    into couleurs
    from (
      select case when g.host_id = p_user then g.host_color
                  else (case when g.host_color = 'yellow' then 'red' else 'yellow' end)::public.disc_color
             end as color,
             count(*) as n,
             count(*) filter (where g.result <> 'draw' and g.winner_id = p_user) as v
        from public.games g
       where g.status = 'finished' and g.mode = 'duel'
         and (g.host_id = p_user or g.guest_id = p_user)
       group by 1) c;

  -- meilleure série de victoires
  for rec in select case when g.result <> 'draw' and g.winner_id = p_user then 1 else 0 end as gagne
               from public.games g
              where g.status = 'finished' and g.mode = 'duel'
                and (g.host_id = p_user or g.guest_id = p_user)
              order by g.finished_at loop
    if rec.gagne = 1 then
      run := run + 1;
      if run > best then best := run; end if;
    else run := 0; end if;
  end loop;

  -- face à face avec moi
  select jsonb_build_object(
           'games', count(*)::int,
           'wins', count(*) filter (where g.result <> 'draw' and g.winner_id = me)::int,
           'losses', count(*) filter (where g.result <> 'draw' and g.winner_id = p_user)::int,
           'draws', count(*) filter (where g.result = 'draw')::int)
    into face
    from public.games g
   where g.status = 'finished' and g.mode = 'duel'
     and ((g.host_id = me and g.guest_id = p_user) or (g.host_id = p_user and g.guest_id = me));

  select jsonb_agg(jsonb_build_object(
           'finished_at', t.finished_at, 'move_count', t.move_count,
           'outcome', case when t.result = 'draw' then 'draw'
                           when t.winner_id = me then 'win' else 'loss' end)
         order by t.finished_at desc)
    into recentes
    from (select g.finished_at, g.move_count, g.result, g.winner_id
            from public.games g
           where g.status = 'finished' and g.mode = 'duel'
             and ((g.host_id = me and g.guest_id = p_user) or (g.host_id = p_user and g.guest_id = me))
           order by g.finished_at desc limit 5) t;

  return jsonb_build_object(
    'id', p_user, 'username', prof.username, 'elo', prof.elo,
    'ranked_games', prof.elo_games, 'member_since', prof.created_at, 'rank', rang,
    'total', coalesce(total, 0), 'wins', coalesce(wins, 0),
    'losses', coalesce(losses, 0), 'draws', coalesce(draws, 0),
    'win_rate', case when coalesce(total, 0) = 0 then null else round(100.0 * wins / total, 1) end,
    'avg_moves', avg_moves, 'best_win_streak', best,
    'by_color', coalesce(couleurs, '[]'::jsonb),
    'head_to_head', face, 'recent', coalesce(recentes, '[]'::jsonb));
end $fn$;

-- ============ droits ============
revoke all on function public.search_players(text), public.send_friend_request(uuid),
  public.accept_friend_request(uuid), public.decline_friend_request(uuid),
  public.remove_friend(uuid), public.my_friends(), public.friend_requests(),
  public.friend_profile(uuid)
  from public, anon;

grant execute on function public.search_players(text), public.send_friend_request(uuid),
  public.accept_friend_request(uuid), public.decline_friend_request(uuid),
  public.remove_friend(uuid), public.my_friends(), public.friend_requests(),
  public.friend_profile(uuid)
  to authenticated;
