import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Square } from "chess.js";
import { forgetToken, login, savedToken } from "../../src/auth.ts";
import { position, render, squareAt, targets, uci } from "../../src/game.ts";
import { clean, lichess, type Lichess } from "../../src/lichess.ts";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// Lichess board for Pi. /chess resumes a game or starts one, /chess new starts
// one, /chess <user> challenges, /chess accept takes a challenge.
export default function chess(pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  // The board size holds for the session. Press b on the board to switch.
  let compact = true;
  // A finished game keeps its board until Escape, but it does not block the next /chess.
  let over = false;
  pi.on("session_shutdown", () => stop?.());

  const play = async (
    api: Lichess,
    game: { gameId: string; color: "white" | "black" },
    ctx: ExtensionCommandContext,
    abort: AbortController,
  ) => {
    const white = game.color === "white";
    let board = position("");
    let state = { moves: "", status: "created", wtime: 0, btime: 0, winner: undefined as string | undefined };
    let received = Date.now();
    let names = { white: "White", black: "Black" };
    let initialFen = "startpos";
    let col = 4;
    let row = 6;
    let selected: Square | undefined;
    let message = "";
    let confirmResign = false;
    let redraw = () => {};
    let rows = () => 0;
    let removeInput = () => {};

    // The board also decides the end itself, in case the final Lichess status is late or lost.
    const live = () => (state.status === "started" || state.status === "created") && !board.isGameOver();
    const result = () =>
      board.isCheckmate()
        ? `Checkmate. ${board.turn() === "w" ? "Black" : "White"} wins.`
        : board.isGameOver()
          ? "Draw."
          : `Game over: ${clean(state.status)}${state.winner ? `, ${clean(state.winner)} wins` : ""}.`;
    const myTurn = () => live() && (board.turn() === "w") === white;
    const lines = () => {
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
        // The large board needs 25 rows plus the text rows, the editor and the footer.
        ...render(board, { white, col, row, selected, last: moved.at(-1), big: !compact && rows() >= 34 }),
        ` ${message || status}`,
        " arrows move · Enter select/move · b board size · R resign · Esc close",
      ];
    };
    const fail = (error: unknown) => {
      if (!abort.signal.aborted) {
        message = clean(error instanceof Error ? error.message : String(error));
        redraw();
      }
    };
    const onKey = (data: string) => {
      const resign = data === "R";
      if (data === "b") compact = !compact;
      message = "";
      if (matchesKey(data, "escape")) return abort.abort();
      if (matchesKey(data, "left")) col = Math.max(0, col - 1);
      if (matchesKey(data, "right")) col = Math.min(7, col + 1);
      if (matchesKey(data, "up")) row = Math.max(0, row - 1);
      if (matchesKey(data, "down")) row = Math.min(7, row + 1);
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const square = squareAt(col, row, white);
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
      redraw();
    };

    ctx.ui.setWidget("chess", (tui) => {
      redraw = () => tui.requestRender();
      rows = () => tui.terminal.rows;
      removeInput = tui.addInputListener((data) => {
        if (!isKeyRelease(data)) onKey(data);
        return { consume: true };
      });
      return { render: lines, invalidate: () => {} };
    });
    const ticking = setInterval(() => redraw(), 1000);
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
          redraw();
        }
      }
      // The stream ends with the game. Keep the final board until Escape.
      if (!abort.signal.aborted) {
        await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
      }
    } finally {
      clearInterval(ticking);
      removeInput();
      ctx.ui.setWidget("chess", undefined);
    }
  };

  /** A Lichess username, "" for a public seek, or undefined when the picker is cancelled. */
  const pick = async (ctx: ExtensionCommandContext) => {
    const seek = "Any opponent (public seek)";
    const choice = await ctx.ui.select("Start a 3-day game", [seek, "Challenge a Lichess user"]);
    if (!choice) return undefined;
    if (choice === seek) return "";
    const user = (await ctx.ui.input("Lichess username"))?.trim();
    if (!user) return undefined;
    if (/^[a-z0-9_-]{2,30}$/i.test(user)) return user;
    ctx.ui.notify("That is not a valid Lichess username.", "warning");
    return undefined;
  };

  const run = async (arg: string, ctx: ExtensionCommandContext) => {
    const abort = new AbortController();
    const mine = () => abort.abort();
    stop = mine;
    over = false;
    try {
      let token = process.env.LICHESS_TOKEN ?? (await savedToken());
      if (!token) {
        ctx.ui.setStatus("chess", "Lichess: approve access in your browser. /chess stop cancels.");
        token = await login(abort.signal);
        ctx.ui.setStatus("chess", undefined);
      }
      const api = lichess(token, abort.signal);
      const [ongoing, pending] = await Promise.all([api.playing(), api.challenges()]);
      const accept = async (id: string) => {
        await api.accept(id);
        // Accepting starts the game at once: it is the one that was not ongoing before.
        const started = (await api.playing()).find((now) => !ongoing.some((old) => old.gameId === now.gameId));
        if (!started) ctx.ui.notify("Challenge accepted. Run /chess to open the game.", "info");
        return started;
      };
      // A correspondence challenge or seek can wait for days, so do not hold the command open.
      const start = async (opponent: string) => {
        if (opponent) {
          await api.challenge(opponent);
          ctx.ui.notify(`Challenge sent to ${clean(opponent)}. Run /chess after they accept.`, "info");
        } else {
          await api.seek();
          ctx.ui.notify("Seek posted on Lichess. Run /chess after someone accepts.", "info");
        }
      };
      let game: (typeof ongoing)[number] | undefined;
      if (arg === "accept") {
        const first = pending.in[0];
        if (!first) throw new Error("No incoming Lichess challenge.");
        game = await accept(first.id);
      } else if (arg && arg !== "new") {
        await start(arg);
      } else {
        const games = ongoing.map(
          (each, index) =>
            `${index + 1}. vs ${clean(each.opponent?.username ?? "unknown")}${each.isMyTurn ? " (your move)" : ""}`,
        );
        const requests = pending.in.map(
          (each, index) => `Accept challenge ${index + 1} from ${clean(each.challenger?.name ?? "unknown")}`,
        );
        const fresh = "New game";
        let choice: string | undefined = fresh;
        if (arg !== "new" && games.length + requests.length > 0) {
          const waiting = pending.out.map((each) => clean(each.destUser?.name ?? "unknown")).join(", ");
          choice =
            games.length === 1 && requests.length === 0
              ? games[0]
              : await ctx.ui.select(waiting ? `Lichess · waiting for ${waiting}` : "Lichess", [
                  ...games,
                  ...requests,
                  fresh,
                ]);
        }
        if (!choice) return;
        if (games.includes(choice)) game = ongoing[games.indexOf(choice)];
        else if (requests.includes(choice)) game = await accept(pending.in[requests.indexOf(choice)]?.id ?? "");
        else {
          const opponent = await pick(ctx);
          if (opponent !== undefined) await start(opponent);
        }
      }
      if (game) await play(api, game, ctx, abort);
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
    description: "Play Lichess: /chess (games, incoming challenges, new game), /chess new, /chess <user>, /chess accept, /chess stop, /chess logout",
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
