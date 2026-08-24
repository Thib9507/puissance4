import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

// Messages d'erreur renvoyés par les fonctions Postgres
const ERRORS = {
  AUTH_REQUIRED: 'Il faut être connecté.',
  CODE_NOT_FOUND: 'Aucune partie ouverte avec ce code.',
  CANNOT_JOIN_OWN_GAME: 'Tu ne peux pas rejoindre ta propre partie.',
  GAME_ALREADY_STARTED: 'Cette partie a déjà commencé avec quelqu’un d’autre.',
  GAME_NOT_FOUND: 'Partie introuvable.',
  GAME_NOT_PLAYING: 'Cette partie n’est pas en cours.',
  GAME_NOT_FINISHED: 'La partie n’est pas terminée.',
  NOT_A_PLAYER: 'Tu ne participes pas à cette partie.',
  NOT_YOUR_TURN: 'Ce n’est pas ton tour.',
  COLUMN_FULL: 'Cette colonne est pleine.',
  BAD_COLUMN: 'Colonne invalide.',
};

export function humanError(error) {
  if (!error) return '';
  const raw = error.message || String(error);
  for (const [key, msg] of Object.entries(ERRORS)) {
    if (raw.includes(key)) return msg;
  }
  if (/Invalid login credentials/i.test(raw)) return 'E-mail ou mot de passe incorrect.';
  if (/User already registered/i.test(raw)) return 'Un compte existe déjà avec cet e-mail.';
  if (/Email address .* is invalid/i.test(raw)) return 'Cette adresse e-mail est refusée par le serveur.';
  if (/Password should be/i.test(raw)) return 'Mot de passe trop court (6 caractères minimum).';
  if (/Email not confirmed/i.test(raw)) return 'E-mail non confirmé : clique le lien reçu par mail.';
  return raw;
}

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

/* ---------------- auth ---------------- */
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signUp = (email, password, username) =>
  supabase.auth.signUp({ email, password, options: { data: { username } } });
export const signOut = () => supabase.auth.signOut();

export async function myProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles').select('id, username').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------------- parties ---------------- */
export const createGame = () => rpc('create_game');
export const joinGame = (code) => rpc('join_game', { p_code: code });
export const playMove = (gameId, col) => rpc('play_move', { p_game: gameId, p_col: col });
export const forfeitGame = (gameId) => rpc('forfeit_game', { p_game: gameId });
export const rematch = (gameId) => rpc('rematch', { p_game: gameId });

export async function getGame(id) {
  const { data, error } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function ongoingGames() {
  const { data, error } = await supabase
    .from('games').select('*')
    .in('status', ['waiting', 'playing'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function profilesByIds(ids) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return {};
  const { data, error } = await supabase.from('profiles').select('id, username').in('id', clean);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((p) => [p.id, p.username]));
}

/* ---------------- stats ---------------- */
export const statsOverview = () => rpc('stats_overview');
export const statsByColor = () => rpc('stats_by_color');
export const statsByOpponent = () => rpc('stats_by_opponent');
export const gameHistory = (limit = 25) => rpc('game_history', { p_limit: limit, p_offset: 0 });

/* ---------------- temps réel ---------------- */
export function subscribeToGame(gameId, onChange) {
  const channel = supabase
    .channel(`game:${gameId}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => onChange(payload.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
}
