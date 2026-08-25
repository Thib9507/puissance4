-- play_move transmettait g.host_id à apply_move au lieu de l'appelant : tous les
-- coups étaient enregistrés au nom de l'hôte, et une victoire de l'invité lui
-- était créditée à tort (avec l'Elo correspondant).
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

  return public.apply_move(g.id, me, my_color, p_col, src);
end $fn$;
