// Tests only: a small terminal that reads the escape sequences the full-screen chat writes and keeps
// the screen they leave, so a test can say what a person would see in a row or a column range. It
// knows only what screen.ts uses: the alternate screen, cursor moves, save and restore, line and
// screen erase, the scrolling region and newline scrolling within it. Each cell is one code point.
export class Terminal {
  rows: number;
  columns: number;
  grid: string[][] = [];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private top = 0;
  private bottom = 0;

  constructor(rows: number, columns: number) {
    this.rows = rows;
    this.columns = columns;
    this.resize(rows, columns);
  }

  resize(rows: number, columns: number) {
    this.rows = rows;
    this.columns = columns;
    this.grid = Array.from({ length: rows }, () => new Array<string>(columns).fill(' '));
    this.top = 0;
    this.bottom = rows - 1;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, columns - 1);
  }

  write = (data: string) => {
    for (let i = 0; i < data.length; ) {
      const ch = data[i];
      if (ch === '\x1b') {
        if (data[i + 1] === '7') { this.saved = { row: this.row, col: this.col }; i += 2; continue; }
        if (data[i + 1] === '8') { this.row = this.saved.row; this.col = this.saved.col; i += 2; continue; }
        const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(data.slice(i));
        if (!m) { i += 1; continue; }
        this.csi(m[1], m[2], m[3]);
        i += m[0].length;
        continue;
      }
      if (ch === '\n') { this.lineFeed(); i += 1; continue; }
      if (ch === '\r') { this.col = 0; i += 1; continue; }
      const cp = data.codePointAt(i)!;
      const text = String.fromCodePoint(cp);
      if (this.col >= this.columns) { this.col = 0; this.lineFeed(); }
      this.grid[this.row][this.col] = text;
      this.col += 1;
      i += text.length;
    }
  };

  private lineFeed() {
    if (this.row === this.bottom) {
      this.grid.splice(this.top, 1);
      this.grid.splice(this.bottom, 0, new Array<string>(this.columns).fill(' '));
    } else if (this.row < this.rows - 1) this.row += 1;
  }

  private csi(private_: string, params: string, final: string) {
    const n = params.split(';').map((x) => (x === '' ? NaN : Number(x)));
    if (private_) return; // ?1049h/l: the alternate screen; nothing to keep for it here.
    switch (final) {
      case 'H': this.row = Math.min(this.rows - 1, (n[0] || 1) - 1); this.col = Math.min(this.columns - 1, (n[1] || 1) - 1); break;
      case 'd': this.row = Math.min(this.rows - 1, (n[0] || 1) - 1); break;
      case 'K': this.grid[this.row].fill(' '); break;
      case 'J': for (const r of this.grid) r.fill(' '); break;
      case 'r':
        this.top = Number.isNaN(n[0]) ? 0 : n[0] - 1;
        this.bottom = Number.isNaN(n[1]) ? this.rows - 1 : n[1] - 1;
        this.row = 0;
        this.col = 0;
        break;
      default: break; // m (style) and anything else leave the cells as they are.
    }
  }

  /** Row `r` (1-based), or its columns `from` to `to` (1-based, inclusive), trailing blanks cut. */
  text(r: number, from = 1, to = this.columns): string {
    return this.grid[r - 1].slice(from - 1, to).join('').trimEnd();
  }

  /** Every row, for a failure message. */
  dump(): string {
    return this.grid.map((r, i) => `${String(i + 1).padStart(2)}|${r.join('')}`).join('\n');
  }
}
