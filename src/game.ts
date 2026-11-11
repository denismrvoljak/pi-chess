import { Chess, type Square } from "chess.js";

/** Rebuilds the position from the Lichess move list ("e2e4 e7e5 ..."). */
export function position(moves: string, initialFen = "startpos") {
  const chess = initialFen === "startpos" ? new Chess() : new Chess(initialFen);
  for (const uci of moves.split(" ").filter(Boolean)) {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
  return chess;
}

export const targets = (chess: Chess, from: Square): Square[] =>
  chess.moves({ square: from, verbose: true }).map((move) => move.to);

/** The UCI string for a legal move, or undefined. */
export function uci(chess: Chess, from: Square, to: Square) {
  const move = chess.moves({ square: from, verbose: true }).find((m) => m.to === to);
  // shortcut: always promotes to a queen, add a picker if underpromotion matters.
  return move && `${from}${to}${move.promotion ? "q" : ""}`;
}

/** Display column/row (0-7, top-left origin) to a square, from the player's side. */
export const squareAt = (col: number, row: number, white: boolean) =>
  (white ? `${"abcdefgh"[col]}${8 - row}` : `${"hgfedcba"[col]}${row + 1}`) as Square;

const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(";");
// Both piece colours keep at least 2.4:1 contrast on every colour except the cursor.
const LIGHT = rgb("#949C97");
const DARK = rgb("#0A6448");
const CURSOR = rgb("#E2BF59");
const SELECTED = rgb("#8D6D0F");
const LAST = rgb("#426E73");
const PIECE = { w: rgb("#ffffff"), b: rgb("#022021") };

export function render(
  chess: Chess,
  view: { white: boolean; col: number; row: number; selected?: Square; last?: string; big?: boolean },
) {
  const marks = view.selected ? targets(chess, view.selected) : [];
  const pad = view.big ? "  " : " ";
  const background = (col: number, row: number) => {
    const square = squareAt(col, row, view.white);
    if (col === view.col && row === view.row) return CURSOR;
    if (square === view.selected) return SELECTED;
    if (view.last?.includes(square)) return LAST;
    return (square.charCodeAt(0) + Number(square[1])) % 2 === 1 ? LIGHT : DARK;
  };
  // A terminal cell is about twice as tall as wide. Big squares are 5 columns by 2 rows:
  // one row with the piece, plus half a row above and below drawn with half blocks.
  const edge = (row: number) => {
    let line = "   ";
    for (let col = 0; col < 8; col++) {
      const above = row > 0 ? `38;2;${background(col, row - 1)}` : undefined;
      const below = row < 8 ? background(col, row) : undefined;
      const colors = above && below ? `${above};48;2;${below}` : (above ?? `38;2;${below}`);
      line += `\x1b[${colors}m${(above ? "▀" : "▄").repeat(5)}\x1b[0m`;
    }
    return line;
  };
  const lines: string[] = [];
  for (let row = 0; row < 8; row++) {
    if (view.big) lines.push(edge(row));
    let line = ` ${squareAt(0, row, view.white)[1]} `;
    for (let col = 0; col < 8; col++) {
      const square = squareAt(col, row, view.white);
      const piece = chess.get(square);
      const glyph = piece ? GLYPH[piece.type] : marks.includes(square) ? "·" : " ";
      line += `\x1b[48;2;${background(col, row)};38;2;${PIECE[piece?.color ?? "b"]}m${pad}${glyph}${pad}\x1b[0m`;
    }
    lines.push(line);
  }
  if (view.big) lines.push(edge(8));
  const files = [...(view.white ? "abcdefgh" : "hgfedcba")];
  lines.push(`   ${files.map((file) => `${pad}${file}${pad}`).join("")}`);
  return lines;
}
