import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Square } from "chess.js";
import { forgetToken, login, savedToken } from "../../src/auth.ts";
import { position, render, squareAt, targets, uci } from "../../src/game.ts";
import { clean, lichess, type Lichess } from "../../src/lichess.ts";
import { attempt, dailyPuzzle } from "../../src/puzzle.ts";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// Lichess board for Pi. /chess resumes a game or starts one, /chess new starts
// one, /chess <user> challenges, /chess accept takes a challenge, /chess puzzle
// opens the Lichess daily puzzle.
export default function chess(pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  // The board size holds for the session. Press b on the board to switch.
  let compact = true;
  // A finished game keeps its board until Escape, but it does not block the next /chess.
  let over = false;
  pi.on("session_shutdown", () => stop?.());

  const USERNAME = /^[a-z0-9_-]{2,30}$/i;
  const mount = (ctx: ExtensionCommandContext, draw: (rows: number) => string[], onKey: (data: string) => void) => {
    let redraw = () => {};
    let removeInput = () => {};
    ctx.ui.setWidget("chess", (tui) => {
      redraw = () => tui.requestRender();
      removeInput = tui.addInputListener((data) => {
        if (!isKeyRelease(data)) {
          onKey(data);
          redraw();
        }
        return { consume: true };
      });
      return { render: () => draw(tui.terminal.rows), invalidate: () => {} };
    });
    return {
      redraw: () => redraw(),
      unmount: () => {
        removeInput();
        ctx.ui.setWidget("chess", undefined);
      },
    };
  };
  const arrows = (data: string, at: { col: number; row: number }) => {
    if (matchesKey(data, "left")) at.col = Math.max(0, at.col - 1);
    if (matchesKey(data, "right")) at.col = Math.min(7, at.col + 1);
    if (matchesKey(data, "up")) at.row = Math.max(0, at.row - 1);
    if (matchesKey(data, "down")) at.row = Math.min(7, at.row + 1);
  };
  const closed = (abort: AbortController) =>
    abort.signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  // The large board needs 18 rows plus the text rows, the editor and the footer.
  const big = (rows: number) => !compact && rows >= 28;

  const solve = async (ctx: ExtensionCommandContext, abort: AbortController, quit: () => void) => {
    let back = false;
    const puzzle = await dailyPuzzle(abort.signal);
    const board = position("", puzzle.fen);
    const white = board.turn() === "w";
    const at = { col: 4, row: 6 };
    let selected: Square | undefined;
    let step = 0;
    let last = puzzle.lastMove;
    let solved = false;
    let message = "";
    const view = mount(
      ctx,
      (rows) => [
        ` Lichess daily puzzle · rating ${puzzle.rating} · ${white ? "White" : "Black"} to move`,
        ...render(board, { white, ...at, selected, last, big: big(rows) }),
        ` ${message || (solved ? "Solved. Esc closes." : "Find the best move")}`,
        " arrows move · Enter select/move · b board size · g games · Esc close",
      ],
      (data) => {
        message = "";
        if (data === "b") compact = !compact;
        if (matchesKey(data, "escape")) return quit();
        if (data === "g") {
          back = true;
          return abort.abort();
        }
        arrows(data, at);
        if (matchesKey(data, "enter") || matchesKey(data, "space")) {
          const square = squareAt(at.col, at.row, white);
          const move = selected && !solved ? uci(board, selected, square) : undefined;
          if (move) {
            selected = undefined;
            const right = attempt(board, puzzle.solution, step, move);
            if (right) ({ step, last, solved } = right);
            else message = "Not the best move. Try again.";
            over = solved;
          } else {
            const own = board.get(square)?.color === (white ? "w" : "b");
            selected = own && square !== selected ? square : undefined;
          }
        }
      },
    );
    try {
      await closed(abort);
    } finally {
      view.unmount();
    }
    return back;
  };

  const play = async (
    api: Lichess,
    game: { gameId: string; color: "white" | "black" },
    ctx: ExtensionCommandContext,
    abort: AbortController,
    quit: () => void,
  ) => {
    // Resolves true when the player pressed g to go back to the game menu.
    let switching = false;
    const white = game.color === "white";
    let board = position("");
    let state = { moves: "", status: "created", wtime: 0, btime: 0, winner: undefined as string | undefined };
    let received = Date.now();
    let names = { white: "White", black: "Black" };
    let initialFen = "startpos";
    const at = { col: 4, row: 6 };
    let selected: Square | undefined;
    let message = "";
    let confirmResign = false;

    // The board also decides the end itself, in case the final Lichess status is late or lost.
    const live = () => (state.status === "started" || state.status === "created") && !board.isGameOver();
    const result = () =>
      board.isCheckmate()
        ? `Checkmate. ${board.turn() === "w" ? "Black" : "White"} wins.`
        : board.isGameOver()
          ? "Draw."
          : `Game over: ${clean(state.status)}${state.winner ? `, ${clean(state.winner)} wins` : ""}.`;
    const myTurn = () => live() && (board.turn() === "w") === white;
    const lines = (rows: number) => {
      const moved = state.moves ? state.moves.split(" ") : [];
      // Lichess starts the clocks after each side has moved once.
      const elapsed = live() && moved.length >= 2 ? Date.now() - received : 0;
      const time = (side: "w" | "b") =>
        clock((side === "w" ? state.wtime : state.btime) - (board.turn() === side ? elapsed : 0));
      const status = live()
        ? myTurn()
          ? "Your move"
          : "Waiting for opponent"
        : `${result()} Esc closes.`;
      return [
        ` ${names.white} ${time("w")}  vs  ${names.black} ${time("b")}`,
        ...render(board, { white, ...at, selected, last: moved.at(-1), big: big(rows) }),
        ` ${message || status}`,
        " arrows move · Enter select/move · b board size · g games · R resign · Esc close",
      ];
    };
    const fail = (error: unknown) => {
      if (!abort.signal.aborted) {
        message = clean(error instanceof Error ? error.message : String(error));
        view.redraw();
      }
    };
    const onKey = (data: string) => {
      const resign = data === "R";
      if (data === "b") compact = !compact;
      message = "";
      if (matchesKey(data, "escape")) return quit();
      if (data === "g") {
        switching = true;
        return abort.abort();
      }
      arrows(data, at);
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const square = squareAt(at.col, at.row, white);
        const move = selected && myTurn() ? uci(board, selected, square) : undefined;
        if (move) {
          api.move(game.gameId, move).catch(fail);
          selected = undefined;
        } else {
          const own = board.get(square)?.color === (white ? "w" : "b");
          selected = own && square !== selected ? square : undefined;
        }
      }
      if (resign && live()) {
        if (confirmResign) api.resign(game.gameId).catch(fail);
        else message = "Press R again to resign";
      }
      confirmResign = resign && !confirmResign;
    };

    const view = mount(ctx, lines, onKey);
    const ticking = setInterval(() => view.redraw(), 1000);
    try {
      for await (const event of await api.game(game.gameId)) {
        if (event.type === "gameFull") {
          names = {
            white: clean(event.white?.name ?? "Computer"),
            black: clean(event.black?.name ?? "Computer"),
          };
          initialFen = event.initialFen ?? "startpos";
        }
        const next = event.type === "gameFull" ? event.state : event.type === "gameState" ? event : undefined;
        if (next) {
          board = position(next.moves, initialFen);
          state = next;
          received = Date.now();
          selected = undefined;
          over = !live();
          view.redraw();
        }
      }
      // The stream ends with the game. Keep the final board until Escape.
      await closed(abort);
    } catch (error) {
      // Switching or closing cancels the game stream; that is not an error.
      if (!abort.signal.aborted) throw error;
    } finally {
      clearInterval(ticking);
      view.unmount();
    }
    return switching;
  };

  /** A Lichess username, "" for a public seek, or undefined when the picker is cancelled. */
  const pick = async (api: Lichess, ctx: ExtensionCommandContext) => {
    const seek = "Any opponent (public seek)";
    const other = "Another Lichess user";
    let friends: string[] = [];
    let title = "Start a 3-day game";
    try {
      friends = (await api.following()).filter((name) => USERNAME.test(name));
    } catch (error) {
      // A token from before the friends list has no follow:read scope.
      if (!(error instanceof Error) || !/^Lichess 40[13]/.test(error.message)) throw error;
      title += " · /chess logout, then /chess, to list your friends";
    }
    const choice = await ctx.ui.select(title, [seek, ...friends, other]);
    if (!choice) return undefined;
    if (choice === seek) return "";
    if (choice !== other) return choice;
    const user = (await ctx.ui.input("Lichess username"))?.trim();
    if (!user) return undefined;
    if (USERNAME.test(user)) return user;
    ctx.ui.notify("That is not a valid Lichess username.", "warning");
    return undefined;
  };

  const run = async (arg: string, ctx: ExtensionCommandContext) => {
    const abort = new AbortController();
    const mine = () => abort.abort();
    const quit = () => abort.abort();
    stop = mine;
    over = false;
    try {
      let token = process.env.LICHESS_TOKEN ?? (await savedToken());
      const api = async () => {
        if (!token) {
          ctx.ui.setStatus("chess", "Lichess: approve access in your browser. /chess stop cancels.");
          token = await login(abort.signal);
          ctx.ui.setStatus("chess", undefined);
        }
        return lichess(token, abort.signal);
      };
      // A correspondence challenge or seek can wait for days, so do not hold the command open.
      const start = async (opponent: string) => {
        if (opponent) {
          await (await api()).challenge(opponent);
          ctx.ui.notify(`Challenge sent to ${clean(opponent)}. Run /chess after they accept.`, "info");
        } else {
          await (await api()).seek();
          ctx.ui.notify("Seek posted on Lichess. Run /chess after someone accepts.", "info");
        }
      };
      type Game = Awaited<ReturnType<Lichess["playing"]>>[number];
      /** What to open next: a game, the daily puzzle, or nothing. */
      const choose = async (request: string, menu: boolean): Promise<Game | "puzzle" | undefined> => {
        if (request === "puzzle") return "puzzle";
        const client = await api();
        const [ongoing, pending] = await Promise.all([client.playing(), client.challenges()]);
        const accept = async (id: string) => {
          await client.accept(id);
          // Accepting starts the game at once: it is the one that was not ongoing before.
          const started = (await client.playing()).find((now) => !ongoing.some((old) => old.gameId === now.gameId));
          if (!started) ctx.ui.notify("Challenge accepted. Run /chess to open the game.", "info");
          return started;
        };
        if (request === "accept") {
          const first = pending.in[0];
          if (!first) throw new Error("No incoming Lichess challenge.");
          return accept(first.id);
        }
        if (request && request !== "new") {
          await start(request);
          return undefined;
        }
        const games = ongoing.map(
          (each, index) =>
            `${index + 1}. vs ${clean(each.opponent?.username ?? "unknown")}${each.isMyTurn ? " (your move)" : ""}`,
        );
        const requests = pending.in.map(
          (each, index) => `Accept challenge ${index + 1} from ${clean(each.challenger?.name ?? "unknown")}`,
        );
        const fresh = "New game";
        const daily = "Daily puzzle";
        let choice: string | undefined = fresh;
        if (request !== "new") {
          const waiting = pending.out.map((each) => clean(each.destUser?.name ?? "unknown")).join(", ");
          // A bare /chess opens a single game directly; g on the board always shows the menu.
          choice =
            !menu && games.length === 1 && requests.length === 0
              ? games[0]
              : await ctx.ui.select(waiting ? `Lichess · waiting for ${waiting}` : "Lichess", [
                  ...games,
                  ...requests,
                  fresh,
                  daily,
                ]);
        }
        if (!choice) return undefined;
        if (games.includes(choice)) return ongoing[games.indexOf(choice)];
        if (requests.includes(choice)) return accept(pending.in[requests.indexOf(choice)]?.id ?? "");
        if (choice === daily) return "puzzle";
        const opponent = await pick(client, ctx);
        if (opponent !== undefined) await start(opponent);
        return undefined;
      };
      // g on a board goes back to the menu; Escape or a cancelled menu ends the command.
      let request = arg;
      let menu = false;
      while (!abort.signal.aborted) {
        const next = await choose(request, menu);
        if (!next) break;
        const board = new AbortController();
        const follow = () => board.abort();
        abort.signal.addEventListener("abort", follow, { once: true });
        const back =
          next === "puzzle"
            ? await solve(ctx, board, quit)
            : await play(lichess(token ?? "", board.signal), next, ctx, board, quit);
        abort.signal.removeEventListener("abort", follow);
        if (!back) break;
        over = false;
        request = "";
        menu = true;
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const text = clean(error instanceof Error ? error.message : String(error));
        // A rejected token is expired or revoked: drop it so the next /chess logs in again.
        if (text.startsWith("Lichess 401")) await forgetToken();
        ctx.ui.notify(text, "error");
      }
    } finally {
      // A newer /chess may already own the command.
      if (stop === mine) {
        ctx.ui.setStatus("chess", undefined);
        stop = undefined;
      }
    }
  };

  pi.registerCommand("chess", {
    description: "Play Lichess: /chess (games, incoming challenges, new game), /chess new, /chess <user>, /chess accept, /chess puzzle, /chess stop, /chess logout",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "stop") stop?.();
      else if (arg === "logout") await forgetToken();
      else if (ctx.mode !== "tui") ctx.ui.notify("/chess needs the interactive terminal UI.", "info");
      else if (stop && !over) ctx.ui.notify("Chess is already open. Use /chess stop first.", "info");
      else {
        stop?.();
        // Not awaited: a game outlives the command, and the agent keeps working.
        void run(arg, ctx);
      }
    },
  });
}
