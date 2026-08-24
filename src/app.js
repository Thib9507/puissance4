import {
  supabase, humanError, signIn, signUp, signOut, myProfile,
  createGame, joinGame, playMove, forfeitGame, rematch,
  getGame, ongoingGames, profilesByIds, subscribeToGame,
  statsOverview, statsByColor, statsByOpponent, gameHistory,
} from './api.js';
import { Board, firstFreeRow } from './board.js';

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

$$('#auth-tabs .tab').forEach((tab) => tab.addEventListener('click', () => {
  authMode = tab.dataset.mode;
  $$('#auth-tabs .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
  $('#field-username').hidden = authMode !== 'signup';
  $('#auth-submit').textContent = authMode === 'signup' ? 'Créer mon compte' : 'Se connecter';
  $('input[name=password]').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  setMsg('#auth-msg', '');
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const email = form.get('email').trim();
  const password = form.get('password');
  const username = (form.get('username') || '').trim();
  const submit = $('#auth-submit');
  submit.disabled = true;
  setMsg('#auth-msg', '');
  try {
    if (authMode === 'signup') {
      const { data, error } = await signUp(email, password, username);
      if (error) throw error;
      if (!data.session) {
        setMsg('#auth-msg', 'Compte créé. Confirme ton adresse via le mail reçu, puis connecte-toi.', true);
        return;
      }
    } else {
      const { error } = await signIn(email, password);
      if (error) throw error;
    }
  } catch (err) {
    setMsg('#auth-msg', humanError(err));
  } finally {
    submit.disabled = false;
  }
});

$('#signout').addEventListener('click', async () => {
  leaveGame();
  await signOut();
});

supabase.auth.onAuthStateChange((_event, session) => { boot(session); });

let bootedFor = null;

async function boot(session) {
  if (!session) {
    bootedFor = null;
    state.me = null;
    $('#screen-auth').hidden = false;
    $('#screen-app').hidden = true;
    return;
  }
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
  $('#screen-app').hidden = false;
  showView('home');
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

function handleInviteHash() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) {
    history.replaceState(null, '', location.pathname);
    $('#join-code').value = code;
    doJoin(code);
  }
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
      li.innerHTML = `<span class="grow">${g.status === 'waiting'
        ? `Code <b>${esc(g.code)}</b> — en attente`
        : `Contre <b>${esc(names[oppId] ?? '?')}</b> — ${g.move_count} coup(s)`}</span>`;
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
  state.game = null;
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

async function onRemoteUpdate(g) {
  if (!state.game || g.id !== state.game.id) return;
  if (g.board === state.game.board && g.status === state.game.status
      && g.rematch_id === state.game.rematch_id) return;
  state.game = g;
  renderGame(g);
  // l'adversaire a lancé la revanche : on le suit
  if (g.rematch_id) {
    const next = await getGame(g.rematch_id);
    if (next) openGame(next);
  }
}

function myColor(g) {
  if (!g.host_color) return null;
  return g.host_id === state.me.id ? g.host_color : (g.host_color === 'yellow' ? 'red' : 'yellow');
}

function renderGame(g) {
  const mine = myColor(g);
  const oppId = g.host_id === state.me.id ? g.guest_id : g.host_id;
  const oppColor = mine === 'yellow' ? 'red' : 'yellow';

  const meEl = $('#player-me');
  meEl.className = `player ${mine ?? ''}`;
  $('.pname', meEl).textContent = `${state.me.username} (toi)`;

  const oppEl = $('#player-opp');
  oppEl.className = `player ${g.guest_id ? oppColor : ''}`;
  $('.pname', oppEl).textContent = state.names[oppId] ?? (g.status === 'waiting' ? 'en attente…' : '?');

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
      : `Au tour de <strong>${esc(state.names[oppId] ?? 'ton adversaire')}</strong> (${colorLabel(oppColor)})`;
  } else {
    const forfeit = g.result === 'forfeit' ? ' par abandon' : '';
    if (g.result === 'draw') status.innerHTML = '<strong>Match nul !</strong>';
    else if (g.winner_id === state.me.id) status.innerHTML = `<strong>Victoire${forfeit} !</strong> 🎉`;
    else status.innerHTML = `<strong>Défaite${forfeit}.</strong>`;
  }

  $('#btn-forfeit').hidden = g.status !== 'playing' && g.status !== 'waiting';
  $('#btn-rematch').hidden = g.status !== 'finished' || !g.guest_id;
  setMsg('#game-msg', '');
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

$('#btn-rematch').addEventListener('click', async () => {
  const g = state.game;
  if (!g) return;
  $('#btn-rematch').disabled = true;
  try {
    openGame(await rematch(g.id));
  } catch (err) {
    setMsg('#game-msg', humanError(err));
  } finally {
    $('#btn-rematch').disabled = false;
  }
});

/* =======================================================
   Statistiques
   ======================================================= */
const pct = (v) => v === null || v === undefined ? '—' : `${Number(v).toFixed(0)} %`;
const bar = (v) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(v) || 0))}%"></i></div>`;

async function loadStats() {
  try {
    const [o, colors, opps] = await Promise.all([statsOverview(), statsByColor(), statsByOpponent()]);

    const streak = o.streak
      ? `${o.streak} ${({ win: 'victoire', loss: 'défaite', draw: 'nul' })[o.streak_kind]}${o.streak > 1 ? 's' : ''}`
      : '—';
    $('#kpis').innerHTML = [
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
  } catch (err) {
    $('#kpis').innerHTML = `<p class="msg">${esc(humanError(err))}</p>`;
  }
}

async function loadHistory() {
  try {
    const rows = await gameHistory(50);
    $('#history').innerHTML = rows.length ? `
      <table><thead><tr><th>Date</th><th>Adversaire</th><th>Couleur</th>
        <th>Résultat</th><th class="num">Coups</th><th>Code</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${new Date(r.finished_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${esc(r.opponent)}</td>
        <td><span class="swatch ${r.color}"></span>${r.color === 'yellow' ? 'Jaune' : 'Rouge'}</td>
        <td><span class="tag ${r.outcome}">${({ win: 'Victoire', loss: 'Défaite', draw: 'Nul' })[r.outcome]}</span>
            ${r.result === 'forfeit' ? '<span class="muted"> (abandon)</span>' : ''}</td>
        <td class="num">${r.move_count}</td>
        <td class="muted">${esc(r.code)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Aucune partie terminée.</p>';
  } catch (err) {
    $('#history').innerHTML = `<p class="msg">${esc(humanError(err))}</p>`;
  }
}

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
