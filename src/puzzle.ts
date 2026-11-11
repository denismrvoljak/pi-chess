import type { Chess } from "chess.js";

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export interface Puzzle {
  id: string;
  rating: number;
  fen: string;
  lastMove?: string;
  solution: string[];
}

/** Reads the Lichess daily puzzle response. Throws when the puzzle cannot be played. */
export function parsePuzzle(body: any): Puzzle {
  const puzzle = body?.puzzle;
  const solution = puzzle?.solution;
  if (
    typeof puzzle?.fen !== "string" ||
    !Array.isArray(solution) ||
    solution.length === 0 ||
    !solution.every((move: unknown) => typeof move === "string" && UCI.test(move))
  ) {
    throw new Error("Lichess sent a puzzle that cannot be read.");
  }
  return {
    id: String(puzzle.id ?? ""),
    rating: Number(puzzle.rating) || 0,
    fen: puzzle.fen,
    lastMove: typeof puzzle.lastMove === "string" && UCI.test(puzzle.lastMove) ? puzzle.lastMove : undefined,
    solution,
  };
}

export async function dailyPuzzle(signal: AbortSignal, fetchFn: typeof fetch = fetch) {
  const res = await fetchFn("https://lichess.org/api/puzzle/daily", { signal });
  if (!res.ok) throw new Error(`Lichess ${res.status}: the daily puzzle is unavailable.`);
  return parsePuzzle(await res.json());
}

const play = (board: Chess, move: string) =>
  board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });

/**
 * Tries a legal move at solution step `step`. A wrong move leaves the board unchanged and
 * returns undefined. A right move is played together with the opponent's reply.
 * As on Lichess, any checkmate counts as right.
 */
export function attempt(board: Chess, solution: string[], step: number, move: string) {
  play(board, move);
  if (move !== solution[step] && !board.isCheckmate()) {
    board.undo();
    return undefined;
  }
  const reply = solution[step + 1];
  if (!reply || board.isCheckmate()) return { step: solution.length, last: move, solved: true };
  play(board, reply);
  return { step: step + 2, last: reply, solved: step + 2 >= solution.length };
}
