import {
  supabase, humanError, signIn, signUp, signOut, myProfile, usernameAvailable,
  requestPasswordReset, checkCurrentPassword, updatePassword, updateEmail, setUsername,
  createGame, joinGame, playMove, forfeitGame, createSoloGame, timeoutMove,
  requestRematch, acceptRematch, declineRematch, TURN_SECONDS,
  getGame, ongoingGames, profilesByIds, subscribeToGame,
  statsOverview, statsByColor, statsByOpponent, statsVsAi, leaderboard, gameHistory,
} from './api.js';
import { Board, firstFreeRow } from './board.js';
import { chooseColumn, LEVELS } from './ai.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  me: null,          // { id, username }
  game: null,        // partie affichée
  names: {},         // id -> pseudo
  unsubscribe: null, // désabonnement temps réel
  poll: null,        // filet de sécurité si le websocket tombe
  busy: false,
  clock: null,       // intervalle de l'horloge du tour
  aiTimer: null,     // coup de l'ordinateur en attente
  timeoutAsked: null,// tour pour lequel l'expiration a déjà été signalée
};

const board = new Board($('#board'), (col) => onColumnClick(col));

/* =======================================================
   Navigation
   ======================================================= */
function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.navbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  if (name === 'stats') loadStats();
  if (name === 'history') loadHistory();
  if (name === 'home') loadOngoing();
  if (name === 'account') loadAccount();
}

$$('.navbtn').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view !== 'game') leaveGame();
  showView(b.dataset.view);
}));

function setMsg(el, text, ok = false) {
  const node = $(el);
  node.textContent = text ?? '';
  node.classList.toggle('ok', !!ok);
}

/* =======================================================
   Authentification
   ======================================================= */
let authMode = 'signin';

// Un champ caché reste soumis et validé : on le désactive pour le sortir du formulaire.
function field(id, visible) {
  const label = $(id);
  label.hidden = !visible;
  $('input', label).disabled = !visible;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $$('#auth-tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === mode));
  field('#field-identifier', !signup);
  field('#field-username', signup);
  field('#field-email', signup);
  $('#auth-submit').textContent = signup ? 'Créer mon compte' : 'Se connecter';
  $('input[name=password]').autocomplete = signup ? 'new-password' : 'current-password';
  setMsg('#auth-msg', '');
}

$$('#auth-tabs .tab').forEach((tab) =>
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));

const FORM_ERRORS = {
  CHAMPS_MANQUANTS: 'Renseigne ton pseudo (ou ton e-mail) et ton mot de passe.',
  PSEUDO_FORMAT: 'Pseudo : 3 à 20 caractères, lettres, chiffres, tiret ou souligné.',
  EMAIL_FORMAT: 'Adresse e-mail invalide.',
  MDP_COURT: 'Mot de passe : 6 caractères minimum.',
  PSEUDO_PRIS: 'Ce pseudo est déjà pris.',
};

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const password = form.get('password') ?? '';
  const submit = $('#auth-submit');
  setMsg('#auth-msg', '');
  try {
    if (authMode === 'signup') {
      const username = (form.get('username') ?? '').trim();
      const email = (form.get('email') ?? '').trim();
      if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) throw new Error('PSEUDO_FORMAT');
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('EMAIL_FORMAT');
      if (password.length < 6) throw new Error('MDP_COURT');

      submit.disabled = true;
      if (!(await usernameAvailable(username))) throw new Error('PSEUDO_PRIS');

      const { data, error } = await signUp(email, password, username);
      if (error) throw error;
      if (!data.session) {
        setMsg('#auth-msg', 'Compte créé. Confirme ton adresse via le mail reçu, puis connecte-toi.', true);
        setAuthMode('signin');
        $('input[name=identifier]').value = username;
        return;
      }
    } else {
      const identifier = (form.get('identifier') ?? '').trim();
      if (!identifier || !password) throw new Error('CHAMPS_MANQUANTS');
      submit.disabled = true;
      const { error } = await signIn(identifier, password);
      if (error) throw error;
    }
  } catch (err) {
    setMsg('#auth-msg', FORM_ERRORS[err?.message] ?? humanError(err));
  } finally {
    submit.disabled = false;
  }
});

$('#signout').addEventListener('click', async () => {
  leaveGame();
  await signOut();
});

let bootedFor = null;

/* ---------- mot de passe oublié ---------- */
function showForgot(show) {
  $('#forgot-form').hidden = !show;
  $('#auth-form').hidden = show;
  $('#auth-tabs').hidden = show;
  $('#forgot-line').hidden = show;
  setMsg('#forgot-msg', '');
  setMsg('#auth-msg', '');
}

$('#btn-forgot').addEventListener('click', () => showForgot(true));
$('#btn-forgot-cancel').addEventListener('click', () => showForgot(false));

$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = (new FormData(e.target).get('identifier') ?? '').trim();
  if (!identifier) { setMsg('#forgot-msg', 'Indique ton pseudo ou ton e-mail.'); return; }
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  await requestPasswordReset(identifier);
  btn.disabled = false;
  // même message dans tous les cas : impossible de deviner qui est inscrit
  setMsg('#forgot-msg', 'Si un compte correspond, un lien vient d’être envoyé par e-mail.', true);
});

/* ---------- nouveau mot de passe après clic sur le lien reçu ---------- */
let recoveryMode = /type=recovery/.test(location.hash);

function showRecovery() {
  bootedFor = null;
  $('#screen-auth').hidden = true;
  $('#screen-app').hidden = true;
  $('#screen-recovery').hidden = false;
}

$('#recovery-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const password = form.get('password') ?? '';
  const confirm = form.get('confirm') ?? '';
  const btn = $('button[type=submit]', e.target);
  setMsg('#recovery-msg', '');
  if (password.length < 6) { setMsg('#recovery-msg', 'Mot de passe : 6 caractères minimum.'); return; }
  if (password !== confirm) { setMsg('#recovery-msg', 'Les deux mots de passe ne correspondent pas.'); return; }
  btn.disabled = true;
  try {
    const { error } = await updatePassword(password);
    if (error) throw error;
    recoveryMode = false;
    e.target.reset();
    history.replaceState(null, '', location.pathname);
    $('#screen-recovery').hidden = true;
    const { data } = await supabase.auth.getSession();
    await boot(data.session);
  } catch (err) {
    setMsg('#recovery-msg', humanError(err));
  } finally {
    btn.disabled = false;
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; showRecovery(); return; }
  if (recoveryMode && session) { showRecovery(); return; }
  boot(session);
});

async function boot(session) {
  if (!session) {
    bootedFor = null;
    state.me = null;
    showForgot(false);
    $('#screen-recovery').hidden = true;
    $('#screen-auth').hidden = false;
    $('#screen-app').hidden = true;
    return;
  }
  if (recoveryMode) { showRecovery(); return; }
  if (bootedFor === session.user.id) return; // évite un double démarrage
  bootedFor = session.user.id;
  // le profil est créé par un trigger : petite attente si la course est perdue
  let profile = await myProfile();
  for (let i = 0; !profile && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    profile = await myProfile();
  }
  state.me = profile ?? { id: session.user.id, username: session.user.email };
  state.names[state.me.id] = state.me.username;
  $('#me-name').textContent = state.me.username;
  $('#screen-auth').hidden = true;
  $('#screen-recovery').hidden = true;
  $('#screen-app').hidden = false;
  // ne pas renvoyer au lobby si une partie est déjà ouverte à l'écran
  if (!state.game) showView('home');
  handleInviteHash();
}

/* =======================================================
   Lobby
   ======================================================= */
let invite = null; // partie en attente créée par moi

$('#btn-create').addEventListener('click', async () => {
  setMsg('#home-msg', '');
  $('#btn-create').disabled = true;
  try {
    const game = await createGame();
    invite = game;
    $('#invite').hidden = false;
    $('#invite-code').textContent = game.code;
    watchGame(game.id, (g) => {
      if (g.status === 'playing') { invite = null; $('#invite').hidden = true; openGame(g); }
    });
    loadOngoing();
  } catch (err) {
    setMsg('#home-msg', humanError(err));
  } finally {
    $('#btn-create').disabled = false;
  }
});

$('#btn-copy').addEventListener('click', () => copy(invite?.code, '#home-msg', 'Code copié.'));
$('#btn-copy-link').addEventListener('click', () =>
  copy(inviteLink(invite?.code), '#home-msg', 'Lien d’invitation copié.'));

$('#btn-cancel-invite').addEventListener('click', async () => {
  if (!invite) return;
  try { await forfeitGame(invite.id); } catch { /* déjà annulée */ }
  invite = null;
  stopWatching();
  $('#invite').hidden = true;
  loadOngoing();
});

const inviteLink = (code) => code ? `${location.origin}${location.pathname}#${code}` : '';

async function copy(text, msgEl, okMsg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setMsg(msgEl, okMsg, true);
  } catch {
    setMsg(msgEl, `Copie impossible, voici la valeur : ${text}`);
  }
}

$('#join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await doJoin($('#join-code').value.trim());
});

async function doJoin(code) {
  if (!code) return;
  setMsg('#home-msg', '');
  try {
    const game = await joinGame(code);
    $('#join-code').value = '';
    openGame(game);
  } catch (err) {
    setMsg('#home-msg', humanError(err));
  }
}

// Le code d'invitation est retenu dès le chargement du module : il ne dépend
// plus du moment où la session est prête, et le hash est retiré tout de suite
// pour ne pas être rejoué à chaque passage dans boot().
let pendingInvite = readInviteHash();

function readInviteHash() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return null;
  history.replaceState(null, '', location.pathname);
  return code;
}

function handleInviteHash() {
  pendingInvite = readInviteHash() ?? pendingInvite;
  if (!pendingInvite) return;
  const code = pendingInvite;
  pendingInvite = null;
  $('#join-code').value = code;
  doJoin(code);
}

async function loadOngoing() {
  try {
    const games = (await ongoingGames()).filter((g) => g.id !== invite?.id);
    const list = $('#ongoing-list');
    $('#ongoing-card').hidden = games.length === 0;
    if (!games.length) { list.innerHTML = ''; return; }

    const names = await profilesByIds(games.flatMap((g) => [g.host_id, g.guest_id]));
    Object.assign(state.names, names);
    list.innerHTML = '';
    for (const g of games) {
      const oppId = g.host_id === state.me.id ? g.guest_id : g.host_id;
      const li = document.createElement('li');
      const adversaire = g.mode === 'solo'
        ? `l'ordinateur <b>(${esc(LEVELS[g.ai_level]?.name ?? '?')})</b>`
        : `<b>${esc(names[oppId] ?? '?')}</b>`;
      li.innerHTML = `<span class="grow">${g.status === 'waiting'
        ? `Code <b>${esc(g.code)}</b> — en attente`
        : `Contre ${adversaire} — ${g.move_count} coup(s)`}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = g.status === 'waiting' ? 'Voir le code' : 'Reprendre';
      btn.addEventListener('click', () => {
        if (g.status === 'waiting') {
          invite = g;
          $('#invite').hidden = false;
          $('#invite-code').textContent = g.code;
          watchGame(g.id, (ng) => {
            if (ng.status === 'playing') { invite = null; $('#invite').hidden = true; openGame(ng); }
          });
          loadOngoing();
        } else {
          openGame(g);
        }
      });
      li.append(btn);
      list.append(li);
    }
  } catch (err) {
    setMsg('#home-msg', humanError(err));
  }
}

/* =======================================================
   Partie
   ======================================================= */
function watchGame(gameId, onChange) {
  stopWatching();
  state.unsubscribe = subscribeToGame(gameId, onChange);
  state.poll = setInterval(async () => {
    try {
      const g = await getGame(gameId);
      if (g) onChange(g);
    } catch { /* hors ligne : on réessaiera */ }
  }, 5000);
}

function stopWatching() {
  state.unsubscribe?.();
  state.unsubscribe = null;
  clearInterval(state.poll);
  state.poll = null;
}

function leaveGame() {
  stopWatching();
  stopClock();
  clearTimeout(state.aiTimer);
  state.aiTimer = null;
  state.game = null;
}

/* ---------- horloge du tour ---------- */
function stopClock() {
  clearInterval(state.clock);
  state.clock = null;
  $('#clock').hidden = true;
}

// Le compte à rebours n'est qu'un affichage : c'est le serveur qui décide si le
// délai est écoulé. Les deux navigateurs peuvent le signaler, celui dont c'est le
// tour en premier, l'autre après un délai de grâce s'il ne l'a pas fait (onglet
// fermé, connexion coupée).
function startClock(g) {
  stopClock();
  const mine = g.turn === myColor(g);
  if (g.status !== 'playing' || (isSolo(g) && !mine)) return;

  const el = $('#clock');
  const debut = Date.parse(g.turn_started_at ?? g.started_at ?? Date.now());
  const cle = `${g.id}:${g.turn_started_at}`;
  el.hidden = false;
  el.classList.toggle('mine', mine);

  const tick = async () => {
    // borne haute : l'horloge du navigateur peut être en retard sur celle du
    // serveur, sans quoi on afficherait 32 s au début d'un tour
    const reste = Math.min(TURN_SECONDS * 1000, debut + TURN_SECONDS * 1000 - Date.now());
    const secondes = Math.max(0, Math.ceil(reste / 1000));
    $('#clock-fill').style.width = `${Math.max(0, Math.min(100, (reste / (TURN_SECONDS * 1000)) * 100))}%`;
    $('#clock-left').textContent = secondes;
    el.classList.toggle('urgent', secondes <= 10);

    const grace = mine ? 0 : 3000;
    if (reste < -grace && state.timeoutAsked !== cle && state.game?.id === g.id) {
      state.timeoutAsked = cle;
      try {
        const next = await timeoutMove(g.id);
        if (next && state.game?.id === next.id) { state.game = next; renderGame(next); }
      } catch { /* la partie a avancé entre-temps */ }
    }
  };
  tick();
  state.clock = setInterval(tick, 200);
}

/* ---------- coup de l'ordinateur ---------- */
function scheduleAi(g) {
  clearTimeout(state.aiTimer);
  if (!isSolo(g) || g.status !== 'playing' || g.turn === myColor(g)) return;
  state.aiTimer = setTimeout(async () => {
    const cur = state.game;
    if (!cur || cur.id !== g.id || cur.status !== 'playing' || cur.turn === myColor(cur)) return;
    const col = chooseColumn(cur.board, cur.turn, cur.ai_level);
    if (col < 0) return;
    try {
      const next = await playMove(cur.id, col);
      state.game = next;
      renderGame(next);
    } catch (err) {
      setMsg('#game-msg', humanError(err));
    }
  }, 550);
}

async function openGame(game) {
  state.game = game;
  const ids = [game.host_id, game.guest_id].filter(Boolean);
  Object.assign(state.names, await profilesByIds(ids));
  showView('game');
  board.render(game.board, game.winning_line, { animate: false });
  renderGame(game);
  watchGame(game.id, (g) => onRemoteUpdate(g));
}

// Signature des champs qui changent l'affichage : évite de tout redessiner
// (et de relancer l'horloge) sur un événement qui n'apporte rien.
const signature = (g) => [g.board, g.status, g.turn_started_at, g.rematch_id,
  g.rematch_requested_by, g.rematch_declined].join('|');

async function onRemoteUpdate(g) {
  if (!state.game || g.id !== state.game.id) return;
  if (signature(g) === signature(state.game)) return;
  state.game = g;
  renderGame(g);
  // la revanche a été acceptée : on suit vers la nouvelle partie
  if (g.rematch_id) {
    const next = await getGame(g.rematch_id);
    if (next) openGame(next);
  }
}

const isSolo = (g) => g.mode === 'solo';
const aiName = (g) => `Ordinateur (${LEVELS[g.ai_level]?.name ?? '?'})`;

function myColor(g) {
  if (!g.host_color) return null;
  return g.host_id === state.me.id ? g.host_color : (g.host_color === 'yellow' ? 'red' : 'yellow');
}

function opponentOf(g) {
  if (isSolo(g)) return { id: null, name: aiName(g) };
  const id = g.host_id === state.me.id ? g.guest_id : g.host_id;
  return { id, name: state.names[id] ?? (g.status === 'waiting' ? 'en attente…' : '?') };
}

function renderGame(g) {
  const mine = myColor(g);
  const opp = opponentOf(g);
  const oppColor = mine === 'yellow' ? 'red' : 'yellow';

  const meEl = $('#player-me');
  meEl.className = `player ${mine ?? ''}`;
  $('.pname', meEl).textContent = `${state.me.username} (toi)`;

  const oppEl = $('#player-opp');
  oppEl.className = `player ${g.guest_id || isSolo(g) ? oppColor : ''}`;
  $('.pname', oppEl).textContent = opp.name;

  const myTurn = g.status === 'playing' && g.turn === mine;
  meEl.classList.toggle('turn', myTurn);
  oppEl.classList.toggle('turn', g.status === 'playing' && !myTurn);

  board.render(g.board, g.status === 'finished' ? g.winning_line : null);
  board.setPlayable(myTurn && !state.busy);

  const status = $('#game-status');
  if (g.status === 'waiting') {
    status.innerHTML = `Envoie le code <b>${esc(g.code)}</b> à ton adversaire…`;
  } else if (g.status === 'cancelled') {
    status.textContent = 'Partie annulée.';
  } else if (g.status === 'playing') {
    status.innerHTML = myTurn
      ? `<strong>À toi de jouer</strong> — tu es ${colorLabel(mine)}`
      : `Au tour de <strong>${esc(opp.name)}</strong> (${colorLabel(oppColor)})`;
  } else {
    const forfeit = g.result === 'forfeit' ? ' par abandon' : '';
    const delta = g.host_id === state.me.id ? g.host_elo_delta : g.guest_elo_delta;
    const elo = delta === null || delta === undefined ? ''
      : ` <span class="${delta >= 0 ? 'delta-plus' : 'delta-minus'}">${delta >= 0 ? '+' : ''}${delta} Elo</span>`;
    if (g.result === 'draw') status.innerHTML = `<strong>Match nul !</strong>${elo}`;
    else if (g.winner_id === state.me.id) status.innerHTML = `<strong>Victoire${forfeit} !</strong> 🎉${elo}`;
    else status.innerHTML = `<strong>Défaite${forfeit}.</strong>${elo}`;
  }

  $('#btn-forfeit').hidden = g.status !== 'playing' && g.status !== 'waiting';
  setMsg('#game-msg', '');
  renderRematch(g, opp);
  startClock(g);
  scheduleAi(g);
}

function renderRematch(g, opp) {
  const box = $('#rematch-box');
  const btn = $('#btn-rematch');
  const actions = $('.rematch-actions', box);
  btn.hidden = true;
  box.hidden = true;

  if (g.status !== 'finished') return;

  if (isSolo(g)) {
    btn.hidden = false;
    btn.textContent = 'Rejouer';
    return;
  }
  if (!g.guest_id) return;

  if (g.rematch_requested_by === state.me.id) {
    box.hidden = false;
    actions.hidden = true;
    $('#rematch-text').textContent = `Revanche demandée — en attente de la réponse de ${opp.name}.`;
  } else if (g.rematch_requested_by) {
    box.hidden = false;
    actions.hidden = false;
    $('#rematch-text').textContent = `${opp.name} demande une revanche.`;
  } else {
    btn.hidden = false;
    btn.textContent = 'Revanche';
    if (g.rematch_declined) setMsg('#game-msg', `${opp.name} a refusé la revanche.`);
  }
}

const colorLabel = (c) => c === 'yellow'
  ? '<span class="swatch yellow"></span>jaune'
  : '<span class="swatch red"></span>rouge';

async function onColumnClick(col) {
  const g = state.game;
  if (!g || state.busy) return;
  if (firstFreeRow(g.board, col) < 0) { setMsg('#game-msg', 'Cette colonne est pleine.'); return; }
  state.busy = true;
  board.setPlayable(false);
  try {
    const next = await playMove(g.id, col);
    state.game = next;
    renderGame(next);
  } catch (err) {
    setMsg('#game-msg', humanError(err));
    const fresh = await getGame(g.id);
    if (fresh) { state.game = fresh; renderGame(fresh); }
  } finally {
    state.busy = false;
    if (state.game) board.setPlayable(state.game.status === 'playing' && state.game.turn === myColor(state.game));
  }
}

$('#btn-back').addEventListener('click', () => { leaveGame(); showView('home'); });

$('#btn-forfeit').addEventListener('click', async () => {
  const g = state.game;
  if (!g) return;
  const question = g.status === 'waiting' ? 'Annuler cette partie ?' : 'Abandonner la partie ?';
  if (!confirm(question)) return;
  try {
    const next = await forfeitGame(g.id);
    state.game = next;
    if (next.status === 'cancelled') { leaveGame(); showView('home'); }
    else renderGame(next);
  } catch (err) {
    setMsg('#game-msg', humanError(err));
  }
});

// Demande de revanche : en duel elle attend l'accord de l'adversaire, en solo
// une nouvelle partie démarre directement.
$('#btn-rematch').addEventListener('click', async () => {
  const g = state.game;
  if (!g) return;
  $('#btn-rematch').disabled = true;
  try {
    const res = await requestRematch(g.id);
    if (res.id !== g.id) openGame(res);       // solo : partie créée aussitôt
    else { state.game = res; renderGame(res); }
  } catch (err) {
    setMsg('#game-msg', humanError(err));
  } finally {
    $('#btn-rematch').disabled = false;
  }
});

$('#btn-rematch-accept').addEventListener('click', async () => {
  const g = state.game;
  if (!g) return;
  $('#btn-rematch-accept').disabled = true;
  try {
    openGame(await acceptRematch(g.id));
  } catch (err) {
    setMsg('#game-msg', humanError(err));
  } finally {
    $('#btn-rematch-accept').disabled = false;
  }
});

$('#btn-rematch-decline').addEventListener('click', async () => {
  const g = state.game;
  if (!g) return;
  try {
    const next = await declineRematch(g.id);
    state.game = next;
    renderGame(next);
    setMsg('#game-msg', 'Revanche refusée.');
  } catch (err) {
    setMsg('#game-msg', humanError(err));
  }
});

/* ---------- partie contre l'ordinateur ---------- */
$$('.levels .btn').forEach((btn) => btn.addEventListener('click', async () => {
  setMsg('#home-msg', '');
  $$('.levels .btn').forEach((b) => { b.disabled = true; });
  try {
    openGame(await createSoloGame(Number(btn.dataset.level)));
  } catch (err) {
    setMsg('#home-msg', humanError(err));
  } finally {
    $$('.levels .btn').forEach((b) => { b.disabled = false; });
  }
}));

/* =======================================================
   Statistiques
   ======================================================= */
const pct = (v) => v === null || v === undefined ? '—' : `${Number(v).toFixed(0)} %`;
const bar = (v) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(v) || 0))}%"></i></div>`;

async function loadStats() {
  try {
    const [o, colors, opps, ai, top] = await Promise.all([
      statsOverview(), statsByColor(), statsByOpponent(), statsVsAi(), leaderboard(20),
    ]);

    const streak = o.streak
      ? `${o.streak} ${({ win: 'victoire', loss: 'défaite', draw: 'nul' })[o.streak_kind]}${o.streak > 1 ? 's' : ''}`
      : '—';
    $('#kpis').innerHTML = [
      ['Elo', o.elo ?? '—'],
      ['Rang', o.rank ? `#${o.rank}` : '—'],
      ['Parties', o.total],
      ['Victoires', o.wins],
      ['Défaites', o.losses],
      ['Nuls', o.draws],
      ['Taux de victoire', pct(o.win_rate)],
      ['Ratio V/D', o.ratio ?? (o.wins ? '∞' : '—')],
      ['Série en cours', streak],
      ['Meilleure série', o.best_win_streak],
      ['Coups / partie', o.avg_moves ?? '—'],
      ['Victoire la + rapide', o.fastest_win ? `${o.fastest_win} coups` : '—'],
    ].map(([k, v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join('');

    $('#stats-color').innerHTML = colors.length ? `
      <table><thead><tr><th>Couleur</th><th class="num">J</th><th class="num">V</th>
        <th class="num">D</th><th class="num">N</th><th class="num">%V</th><th></th></tr></thead>
      <tbody>${colors.map((c) => `<tr>
        <td><span class="swatch ${c.color}"></span>${c.color === 'yellow' ? 'Jaune' : 'Rouge'}</td>
        <td class="num">${c.games}</td><td class="num">${c.wins}</td>
        <td class="num">${c.losses}</td><td class="num">${c.draws}</td>
        <td class="num">${pct(c.win_rate)}</td><td>${bar(c.win_rate)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Pas encore de partie terminée.</p>';

    $('#stats-opp').innerHTML = opps.length ? `
      <table><thead><tr><th>Adversaire</th><th class="num">J</th><th class="num">V</th>
        <th class="num">D</th><th class="num">N</th><th class="num">Ratio</th><th class="num">%V</th><th></th></tr></thead>
      <tbody>${opps.map((o2) => `<tr>
        <td>${esc(o2.username)}</td>
        <td class="num">${o2.games}</td><td class="num">${o2.wins}</td>
        <td class="num">${o2.losses}</td><td class="num">${o2.draws}</td>
        <td class="num">${o2.ratio ?? (o2.wins ? '∞' : '—')}</td>
        <td class="num">${pct(o2.win_rate)}</td><td>${bar(o2.win_rate)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Aucun adversaire affronté pour l’instant.</p>';

    $('#leaderboard').innerHTML = top.length ? `
      <table><thead><tr><th>#</th><th>Joueur</th><th class="num">Elo</th>
        <th class="num">Parties</th><th class="num">Victoires</th></tr></thead>
      <tbody>${top.map((l) => `<tr class="${l.is_me ? 'me' : ''}">
        <td>${l.rank}</td><td>${esc(l.username)}${l.is_me ? ' (toi)' : ''}</td>
        <td class="num">${l.elo}</td><td class="num">${l.played}</td>
        <td class="num">${l.wins}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Le classement se remplira après la première partie.</p>';

    $('#stats-ai').innerHTML = ai.length ? `
      <table><thead><tr><th>Niveau</th><th class="num">J</th><th class="num">V</th>
        <th class="num">D</th><th class="num">N</th><th class="num">%V</th><th></th></tr></thead>
      <tbody>${ai.map((n) => `<tr>
        <td>${esc(LEVELS[n.level]?.name ?? n.level)}</td>
        <td class="num">${n.games}</td><td class="num">${n.wins}</td>
        <td class="num">${n.losses}</td><td class="num">${n.draws}</td>
        <td class="num">${pct(n.win_rate)}</td><td>${bar(n.win_rate)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Aucune partie contre l’ordinateur.</p>';
  } catch (err) {
    $('#kpis').innerHTML = `<p class="msg">${esc(humanError(err))}</p>`;
  }
}

async function loadHistory() {
  try {
    const rows = await gameHistory(50);
    $('#history').innerHTML = rows.length ? `
      <table><thead><tr><th>Date</th><th>Adversaire</th><th>Couleur</th>
        <th>Résultat</th><th class="num">Coups</th><th class="num">Elo</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${new Date(r.finished_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${r.mode === 'solo'
              ? `<span class="muted">Ordinateur (${esc(LEVELS[r.ai_level]?.name ?? '?')})</span>`
              : esc(r.opponent)}</td>
        <td><span class="swatch ${r.color}"></span>${r.color === 'yellow' ? 'Jaune' : 'Rouge'}</td>
        <td><span class="tag ${r.outcome}">${({ win: 'Victoire', loss: 'Défaite', draw: 'Nul' })[r.outcome]}</span>
            ${r.result === 'forfeit' ? '<span class="muted"> (abandon)</span>' : ''}</td>
        <td class="num">${r.move_count}</td>
        <td class="num">${r.elo_delta === null || r.elo_delta === undefined ? '—'
          : `<span class="${r.elo_delta >= 0 ? 'delta-plus' : 'delta-minus'}">${r.elo_delta >= 0 ? '+' : ''}${r.elo_delta}</span>`}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Aucune partie terminée.</p>';
  } catch (err) {
    $('#history').innerHTML = `<p class="msg">${esc(humanError(err))}</p>`;
  }
}

/* =======================================================
   Compte
   ======================================================= */
async function loadAccount() {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  $('#acc-username').textContent = state.me?.username ?? '—';
  $('#acc-email').textContent = user?.email ?? '—';
  $('#acc-since').textContent = state.me?.created_at
    ? new Date(state.me.created_at).toLocaleDateString('fr-FR', { dateStyle: 'long' })
    : '—';
  $('#form-username input[name=username]').value = state.me?.username ?? '';
  ['#username-msg', '#email-msg', '#password-msg'].forEach((m) => setMsg(m, ''));
}

$('#form-username').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = (new FormData(e.target).get('username') ?? '').trim();
  const btn = $('button[type=submit]', e.target);
  setMsg('#username-msg', '');
  if (value === state.me?.username) { setMsg('#username-msg', 'C’est déjà ton pseudo.'); return; }
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(value)) {
    setMsg('#username-msg', FORM_ERRORS.PSEUDO_FORMAT); return;
  }
  btn.disabled = true;
  try {
    const profile = await setUsername(value);
    state.me = { ...state.me, ...profile };
    state.names[state.me.id] = profile.username;
    $('#me-name').textContent = profile.username;
    $('#acc-username').textContent = profile.username;
    setMsg('#username-msg', 'Pseudo mis à jour.', true);
  } catch (err) {
    setMsg('#username-msg', humanError(err));
  } finally {
    btn.disabled = false;
  }
});

$('#form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = (new FormData(e.target).get('email') ?? '').trim();
  const btn = $('button[type=submit]', e.target);
  setMsg('#email-msg', '');
  if (!/^\S+@\S+\.\S+$/.test(email)) { setMsg('#email-msg', FORM_ERRORS.EMAIL_FORMAT); return; }
  btn.disabled = true;
  try {
    const { error } = await updateEmail(email);
    if (error) throw error;
    e.target.reset();
    setMsg('#email-msg', `Lien de confirmation envoyé à ${email}. L’adresse changera une fois le lien cliqué.`, true);
  } catch (err) {
    setMsg('#email-msg', humanError(err));
  } finally {
    btn.disabled = false;
  }
});

$('#form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const current = form.get('current') ?? '';
  const password = form.get('password') ?? '';
  const confirm = form.get('confirm') ?? '';
  const btn = $('button[type=submit]', e.target);
  setMsg('#password-msg', '');
  if (password.length < 6) { setMsg('#password-msg', FORM_ERRORS.MDP_COURT); return; }
  if (password !== confirm) { setMsg('#password-msg', 'Les deux mots de passe ne correspondent pas.'); return; }
  btn.disabled = true;
  try {
    // on revérifie le mot de passe actuel : une session ouverte ne suffit pas
    if (!(await checkCurrentPassword(current))) {
      setMsg('#password-msg', 'Mot de passe actuel incorrect.');
      return;
    }
    const { error } = await updatePassword(password);
    if (error) throw error;
    e.target.reset();
    setMsg('#password-msg', 'Mot de passe mis à jour.', true);
  } catch (err) {
    setMsg('#password-msg', humanError(err));
  } finally {
    btn.disabled = false;
  }
});

/* =======================================================
   Démarrage
   ======================================================= */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.game) {
    const g = await getGame(state.game.id);
    if (g) onRemoteUpdate(g);
  }
});

window.addEventListener('hashchange', () => { if (state.me) handleInviteHash(); });

supabase.auth.getSession().then(({ data }) => boot(data.session));
