// Adversaire artificiel : minimax avec élagage alpha-bêta.
// Le plateau circule sous forme de chaîne de 42 caractères ('.', 'y', 'r') ;
// en interne on travaille sur un Uint8Array (0 vide, 1 moi, 2 l'adversaire),
// nettement plus rapide à copier et à parcourir.
import { COLS, ROWS, idx } from './board.js';

export const LEVELS = {
  1: { name: 'Facile', depth: 0 },   // ne regarde qu'un coup : gagne ou bloque, sinon au hasard
  2: { name: 'Moyen', depth: 4 },
  3: { name: 'Difficile', depth: 7 },   // ~250 ms par coup, gagne 10-0 contre le niveau facile
};

const ME = 1;
const OPP = 2;
const WIN = 1e6;

// Ordre d'exploration : le centre d'abord, ce qui fait couper l'alpha-bêta plus tôt
const ORDER = [3, 2, 4, 1, 5, 0, 6];

// Les 69 alignements de 4 cases possibles, calculés une fois pour toutes
const WINDOWS = (() => {
  const w = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 3 < COLS) w.push([idx(r, c), idx(r, c + 1), idx(r, c + 2), idx(r, c + 3)]);
      if (r + 3 < ROWS) w.push([idx(r, c), idx(r + 1, c), idx(r + 2, c), idx(r + 3, c)]);
      if (r + 3 < ROWS && c + 3 < COLS) w.push([idx(r, c), idx(r + 1, c + 1), idx(r + 2, c + 2), idx(r + 3, c + 3)]);
      if (r + 3 < ROWS && c - 3 >= 0) w.push([idx(r, c), idx(r + 1, c - 1), idx(r + 2, c - 2), idx(r + 3, c - 3)]);
    }
  }
  return w;
})();

/** Chaîne du plateau -> tableau vu depuis la couleur qui doit jouer. */
function toCells(board, myColor) {
  const mine = myColor === 'yellow' ? 'y' : 'r';
  const cells = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < cells.length; i++) {
    if (board[i] === '.') cells[i] = 0;
    else cells[i] = board[i] === mine ? ME : OPP;
  }
  return cells;
}

const freeRow = (cells, col) => {
  for (let r = 0; r < ROWS; r++) if (!cells[idx(r, col)]) return r;
  return -1;
};

const legalCols = (cells) => ORDER.filter((c) => cells[idx(ROWS - 1, c)] === 0);

/** Quatre alignés passant par (r, c) ? */
function wins(cells, r, c, p) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let n = 1;
    for (const sign of [1, -1]) {
      for (let k = 1; k <= 3; k++) {
        const rr = r + dr * k * sign;
        const cc = c + dc * k * sign;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || cells[idx(rr, cc)] !== p) break;
        n++;
      }
    }
    if (n >= 4) return true;
  }
  return false;
}

/** Évaluation statique, du point de vue de ME. */
function evaluate(cells) {
  let s = 0;
  for (const w of WINDOWS) {
    let mine = 0, his = 0;
    for (const i of w) {
      const v = cells[i];
      if (v === ME) mine++;
      else if (v === OPP) his++;
    }
    if (mine && his) continue;              // fenêtre bouchée, sans valeur
    if (mine === 3) s += 50;
    else if (mine === 2) s += 10;
    else if (mine === 1) s += 1;
    if (his === 3) s -= 60;                 // on se méfie un peu plus des menaces adverses
    else if (his === 2) s -= 12;
    else if (his === 1) s -= 1;
  }
  for (let r = 0; r < ROWS; r++) if (cells[idx(r, 3)] === ME) s += 6;
  return s;
}

function search(cells, depth, alpha, beta, turn) {
  const cols = legalCols(cells);
  if (!cols.length) return 0;                       // plateau plein : nul
  if (depth === 0) return evaluate(cells);

  let best = turn === ME ? -Infinity : Infinity;
  for (const c of cols) {
    const r = freeRow(cells, c);
    cells[idx(r, c)] = turn;
    let value;
    if (wins(cells, r, c, turn)) {
      // une victoire proche vaut mieux qu'une victoire lointaine
      value = turn === ME ? WIN + depth : -WIN - depth;
    } else {
      value = search(cells, depth - 1, alpha, beta, turn === ME ? OPP : ME);
    }
    cells[idx(r, c)] = 0;

    if (turn === ME) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  return best;
}

/** Coup immédiat gagnant pour `p`, sinon -1. */
function immediateWin(cells, p) {
  for (const c of legalCols(cells)) {
    const r = freeRow(cells, c);
    cells[idx(r, c)] = p;
    const gagne = wins(cells, r, c, p);
    cells[idx(r, c)] = 0;
    if (gagne) return c;
  }
  return -1;
}

/**
 * Colonne choisie par l'ordinateur.
 * @param {string} board  plateau (42 caractères)
 * @param {'yellow'|'red'} myColor  couleur de l'ordinateur
 * @param {1|2|3} level
 */
export function chooseColumn(board, myColor, level) {
  const cells = toCells(board, myColor);
  const cols = legalCols(cells);
  if (!cols.length) return -1;

  // Niveau facile : gagner si possible, sinon empêcher l'adversaire de gagner,
  // sinon au hasard. De quoi rester battable sans être absurde.
  if (level === 1) {
    const gagnant = immediateWin(cells, ME);
    if (gagnant >= 0) return gagnant;
    const menace = immediateWin(cells, OPP);
    if (menace >= 0) return menace;
    return cols[Math.floor(Math.random() * cols.length)];
  }

  const depth = (LEVELS[level] ?? LEVELS[2]).depth;
  let best = -Infinity;
  let choix = [];
  for (const c of cols) {
    const r = freeRow(cells, c);
    cells[idx(r, c)] = ME;
    const value = wins(cells, r, c, ME)
      ? WIN + depth
      : search(cells, depth - 1, -Infinity, Infinity, OPP);
    cells[idx(r, c)] = 0;

    if (value > best) { best = value; choix = [c]; }
    else if (value === best) choix.push(c);
  }
  // entre coups équivalents, on varie pour ne pas rejouer deux fois la même partie
  return choix[Math.floor(Math.random() * choix.length)];
}
