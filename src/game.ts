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
// Block art for the large board: the "Compact" pieces from chess-tui
// (https://github.com/thomas-mauran/chess-tui, MIT, Copyright (c) 2023 Thomas Mauran).
const ART = {
  k: ["▗▂╋▂▖", " ▀█▀ ", " ▀▀▀ "],
  q: [" ▆▄▆ ", " ▗█▖ ", " ▀▀▀ "],
  r: [" ▅ ▅ ", " ███ ", "▝▀▀▀▘"],
  b: [" ▆▖▆ ", " ▐▙▌ ", " ▀▀▀ "],
  n: [" ▄▟▟▖", " ▂█▛▘", "▝▀▀▀▘"],
  p: ["  ▂  ", " ▆█▆ ", " ▔▔▔ "],
};
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
  // A terminal cell is about twice as tall as wide. Small squares are 3x1 with a glyph.
  // Big squares are 7x3 with block art, so the piece fills its square.
  const [pad, height] = view.big ? ["   ", 3] : [" ", 1];
  const lines: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let part = 0; part < height; part++) {
      const middle = part === (height - 1) / 2;
      let line = middle ? ` ${squareAt(0, row, view.white)[1]} ` : "   ";
      for (let col = 0; col < 8; col++) {
        const square = squareAt(col, row, view.white);
        const piece = chess.get(square);
        const background =
          col === view.col && row === view.row
            ? CURSOR
            : square === view.selected
              ? SELECTED
              : view.last?.includes(square)
                ? LAST
                : (square.charCodeAt(0) + Number(square[1])) % 2 === 1
                  ? LIGHT
                  : DARK;
        const mark = middle && marks.includes(square) ? "·" : " ";
        const content = !piece
          ? `${pad}${mark}${pad}`
          : view.big
            ? ` ${ART[piece.type][part]} `
            : ` ${GLYPH[piece.type]} `;
        line += `\x1b[48;2;${background};38;2;${PIECE[piece?.color ?? "b"]}m${content}\x1b[0m`;
      }
      lines.push(line);
    }
  }
  const files = [...(view.white ? "abcdefgh" : "hgfedcba")];
  lines.push(`   ${files.map((file) => `${pad}${file}${pad}`).join("")}`);
  return lines;
}
