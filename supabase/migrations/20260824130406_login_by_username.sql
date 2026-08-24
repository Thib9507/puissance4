-- Le pseudo devient un identifiant de connexion : il doit être unique sans
-- tenir compte de la casse.
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

-- Disponibilité d'un pseudo : appelée avant l'inscription, donc ouverte à anon.
-- Ne renvoie qu'un booléen.
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select not exists (
    select 1 from public.profiles p where lower(p.username) = lower(trim(p_username))
  );
$fn$;
revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- Résolution pseudo -> e-mail : réservée au service_role, utilisée uniquement par
-- l'edge function « signin ». Jamais exposée aux clients, pour ne pas divulguer
-- les adresses e-mail des joueurs.
create or replace function public.email_for_username(p_username text)
returns text language sql stable security definer set search_path = '' as $fn$
  select u.email::text
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(p.username) = lower(trim(p_username))
   limit 1;
$fn$;
revoke all on function public.email_for_username(text) from public, anon, authenticated;
grant execute on function public.email_for_username(text) to service_role;
