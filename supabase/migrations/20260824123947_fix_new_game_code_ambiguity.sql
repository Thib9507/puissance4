-- La variable locale `code` entrait en conflit avec la colonne `games.code`
-- dans le `not exists` de la boucle : « column reference "code" is ambiguous ».
-- Renommée en `v_code`.
--
-- La migration initiale porte déjà la version corrigée : rejouer ce fichier sur
-- une base neuve est donc sans effet, il n'est conservé que pour que l'historique
-- du dépôt corresponde à celui enregistré dans la base.
create or replace function public.new_game_code()
returns text language plpgsql volatile as $fn$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text; i int; tries int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * char_length(alphabet))::int, 1);
    end loop;
    exit when not exists (
      select 1 from public.games g where g.code = v_code and g.status in ('waiting','playing')
    );
    tries := tries + 1;
    if tries > 50 then raise exception 'CODE_GENERATION_FAILED'; end if;
  end loop;
  return v_code;
end $fn$;

revoke execute on function public.new_game_code() from public, anon;
