-- Durcissement suite au linter Supabase :
--  * search_path figé sur toutes les fonctions
--  * la fonction de trigger n'est pas exposée via l'API REST
alter function public.cell_at(text, int, int)            set search_path = '';
alter function public.winning_line(text, int, int, text)  set search_path = '';
alter function public.new_game_code()                     set search_path = '';
alter function public.handle_new_user()                   set search_path = '';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $fn$
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

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.cell_at(text, int, int) from anon;
revoke all on function public.winning_line(text, int, int, text) from anon;
