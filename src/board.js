// Rendu du plateau.
// Le plateau est une chaîne de 42 caractères : index = ligne * 7 + colonne,
// ligne 0 = bas de la grille. '.' vide, 'y' jaune, 'r' rouge.
export const COLS = 7;
export const ROWS = 6;
export const EMPTY_BOARD = '.'.repeat(COLS * ROWS);

export const idx = (row, col) => row * COLS + col;

/** Première ligne libre d'une colonne, ou -1 si pleine. */
export function firstFreeRow(board, col) {
  for (let r = 0; r < ROWS; r++) if (board[idx(r, col)] === '.') return r;
  return -1;
}

export class Board {
  constructor(el, onPlay) {
    this.el = el;
    this.onPlay = onPlay;
    this.state = EMPTY_BOARD;
    this.playable = false;
    this.cells = [];
    this.#build();
  }

  #build() {
    this.el.innerHTML = '';
    // affichage du haut vers le bas
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.col = c;
        cell.dataset.row = r;
        cell.innerHTML = '<span class="disc"></span>';
        this.cells[idx(r, c)] = cell;
        this.el.append(cell);
      }
    }

    this.el.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !this.playable) return;
      this.onPlay(Number(cell.dataset.col));
    });
    this.el.addEventListener('mousemove', (e) => {
      const cell = e.target.closest('.cell');
      this.#hover(this.playable && cell ? Number(cell.dataset.col) : null);
    });
    this.el.addEventListener('mouseleave', () => this.#hover(null));
  }

  #hover(col) {
    if (col === this.hovered) return;
    this.hovered = col;
    for (const cell of this.cells) cell.classList.remove('col-hover');
    if (col === null) return;
    const r = firstFreeRow(this.state, col);
    if (r >= 0) this.cells[idx(r, col)].classList.add('col-hover');
  }

  setPlayable(playable) {
    this.playable = playable;
    this.el.classList.toggle('playable', playable);
    if (!playable) this.#hover(null);
  }

  /** Met à jour la grille ; anime les jetons qui viennent d'apparaître. */
  render(board, winningLine = null, { animate = true } = {}) {
    const previous = this.state;
    this.state = board;

    for (let i = 0; i < board.length; i++) {
      const cell = this.cells[i];
      const ch = board[i];
      cell.classList.toggle('y', ch === 'y');
      cell.classList.toggle('r', ch === 'r');
      cell.classList.remove('win');

      const isNew = ch !== '.' && previous[i] !== ch;
      cell.classList.remove('dropped');
      if (isNew && animate) {
        // le jeton tombe depuis au-dessus du plateau
        cell.style.setProperty('--from', `-${cell.offsetTop + cell.offsetHeight}px`);
        void cell.offsetWidth; // relance l'animation
        cell.classList.add('dropped');
      }
    }

    for (const i of winningLine ?? []) this.cells[i]?.classList.add('win');
    this.#hover(null);
  }
}
