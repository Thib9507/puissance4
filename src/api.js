import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // detectSessionInUrl : nécessaire pour récupérer la session portée par le lien
  // de réinitialisation de mot de passe reçu par mail.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
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
  USERNAME_TAKEN: 'Ce pseudo est déjà pris.',
  NO_REMATCH_REQUEST: 'Aucune demande de revanche en cours.',
  BAD_LEVEL: 'Niveau de difficulté invalide.',
  USERNAME_FORMAT: 'Pseudo : 3 à 20 caractères, lettres, chiffres, tiret ou souligné.',
};

export function humanError(error) {
  if (!error) return '';
  const raw = error.message || String(error);
  for (const [key, msg] of Object.entries(ERRORS)) {
    if (raw.includes(key)) return msg;
  }
  if (/Invalid login credentials/i.test(raw)) return 'Pseudo, e-mail ou mot de passe incorrect.';
  if (/User already registered/i.test(raw)) return 'Un compte existe déjà avec cet e-mail.';
  if (/Email address .* is invalid/i.test(raw)) return 'Cette adresse e-mail est refusée par le serveur.';
  if (/Password should be/i.test(raw)) return 'Mot de passe trop court (6 caractères minimum).';
  if (/Email not confirmed/i.test(raw)) return 'E-mail non confirmé : clique le lien reçu par mail.';
  if (/should be different from the old/i.test(raw)) return 'Le nouveau mot de passe doit être différent de l’ancien.';
  if (/email address is already|already been registered/i.test(raw)) return 'Cette adresse e-mail est déjà utilisée.';
  if (/same as the current|already in use/i.test(raw)) return 'Cette adresse est déjà celle de ton compte.';
  if (/session|jwt|token/i.test(raw) && /expired|invalid/i.test(raw)) return 'Lien expiré : redemande un lien de réinitialisation.';
  if (/email rate limit|over_email_send_rate_limit/i.test(raw)) {
    return 'Quota d’envoi d’e-mails atteint (le SMTP par défaut de Supabase est très limité). Réessaie plus tard.';
  }
  if (/For security purposes|rate limit|too many/i.test(raw)) return 'Trop de tentatives, réessaie dans une minute.';
  return raw;
}

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

/* ---------------- auth ---------------- */

/**
 * Connexion par pseudo OU e-mail.
 * Avec un e-mail on parle directement à GoTrue ; avec un pseudo on passe par
 * l'edge function « signin », seule habilitée à retrouver l'e-mail associé.
 */
export async function signIn(identifier, password) {
  const id = (identifier ?? '').trim();
  if (id.includes('@')) return supabase.auth.signInWithPassword({ email: id, password });

  let data;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ identifier: id, password }),
    });
    data = await res.json();
    if (!res.ok || !data?.access_token) {
      return { data: null, error: new Error(data?.error_description || data?.msg || 'Invalid login credentials') };
    }
  } catch (err) {
    return { data: null, error: err };
  }
  return supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
}

export const signUp = (email, password, username) =>
  supabase.auth.signUp({ email, password, options: { data: { username } } });
export const signOut = () => supabase.auth.signOut();
export const usernameAvailable = (username) => rpc('username_available', { p_username: username });

export async function myProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles').select('id, username, created_at').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------------- compte ---------------- */

/** Demande d'un lien de réinitialisation, à partir d'un pseudo ou d'un e-mail. */
export async function requestPasswordReset(identifier) {
  await fetch(`${SUPABASE_URL}/functions/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({
      identifier: (identifier ?? '').trim(),
      redirect_to: `${location.origin}${location.pathname}`,
    }),
  });
  // Réponse volontairement identique que le compte existe ou non.
}

/** Vérifie le mot de passe actuel en rejouant une connexion sur le même compte. */
export async function checkCurrentPassword(password) {
  const { data: { session } } = await supabase.auth.getSession();
  const email = session?.user?.email;
  if (!email) return false;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return !error;
}

export const updatePassword = (password) => supabase.auth.updateUser({ password });
export const updateEmail = (email) => supabase.auth.updateUser({ email });
export const setUsername = (username) => rpc('set_username', { p_username: username });

/* ---------------- parties ---------------- */
export const createGame = () => rpc('create_game');
export const joinGame = (code) => rpc('join_game', { p_code: code });
export const playMove = (gameId, col) => rpc('play_move', { p_game: gameId, p_col: col });
export const forfeitGame = (gameId) => rpc('forfeit_game', { p_game: gameId });
export const timeoutMove = (gameId) => rpc('timeout_move', { p_game: gameId });
export const createSoloGame = (level) => rpc('create_solo_game', { p_level: level });
export const requestRematch = (gameId) => rpc('request_rematch', { p_game: gameId });
export const acceptRematch = (gameId) => rpc('accept_rematch', { p_game: gameId });
export const declineRematch = (gameId) => rpc('decline_rematch', { p_game: gameId });

/** Durée d'un tour, en secondes. Le serveur applique la même valeur. */
export const TURN_SECONDS = 30;

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
export const statsVsAi = () => rpc('stats_vs_ai');
export const leaderboard = (limit = 20) => rpc('leaderboard', { p_limit: limit });
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
