-- Changement de pseudo : passe par une RPC pour valider le format et l'unicité
-- avec des erreurs exploitables côté client.
create or replace function public.set_username(p_username text)
returns public.profiles language plpgsql security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid();
  clean text := trim(p_username);
  row public.profiles;
begin
  if me is null then raise exception 'AUTH_REQUIRED'; end if;
  if clean !~ '^[A-Za-z0-9_-]{3,20}$' then raise exception 'USERNAME_FORMAT'; end if;
  if exists (select 1 from public.profiles p
              where lower(p.username) = lower(clean) and p.id <> me) then
    raise exception 'USERNAME_TAKEN';
  end if;

  update public.profiles set username = clean where id = me returning * into row;
  return row;
end $fn$;

revoke all on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated;

-- Le pseudo ne se modifie plus qu'à travers set_username : on retire l'accès
-- direct en écriture sur la table.
drop policy if exists "modifier son propre profil" on public.profiles;
