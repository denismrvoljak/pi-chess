import assert from "node:assert/strict";
import { test } from "node:test";
import { position, render, squareAt, targets, uci } from "../src/game.ts";
import { clean, lichess, ndjson } from "../src/lichess.ts";

test("replays Lichess moves, including castling and promotion", () => {
  const board = position("e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1");
  assert.equal(board.get("g1")?.type, "k");
  assert.equal(board.get("f1")?.type, "r");
  assert.equal(position("a7a8q", "8/P6k/8/8/8/8/8/K7 w - - 0 1").get("a8")?.type, "q");
});

test("knows a checkmate from the moves alone", () => {
  const mate = position("e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7");
  assert.ok(mate.isCheckmate() && mate.isGameOver());
  assert.equal(mate.turn(), "b");
});

test("builds UCI for legal moves only and promotes to a queen", () => {
  const start = position("");
  assert.equal(uci(start, "e2", "e4"), "e2e4");
  assert.equal(uci(start, "e2", "e5"), undefined);
  assert.deepEqual(targets(start, "g1").sort(), ["f3", "h3"]);
  assert.equal(uci(position("", "8/P6k/8/8/8/8/8/K7 w - - 0 1"), "a7", "a8"), "a7a8q");
});

test("draws coloured squares in two sizes with cursor, selection and last move", () => {
  assert.equal(squareAt(0, 7, true), "a1");
  assert.equal(squareAt(0, 7, false), "h8");
  const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  const flipped = render(position(""), { white: false, col: 7, row: 7 });
  assert.equal(flipped.length, 9);
  assert.ok(plain(flipped[0]).startsWith(" 1  ♜ "));
  assert.match(flipped[8], /h {2}g/);
  const big = render(position(""), { white: true, col: 0, row: 0, selected: "e2", big: true });
  assert.equal(big.length, 18);
  assert.match(big[17], /a {4}b/);
  // Every square is 5 columns wide: 3 for the rank label plus 8 squares.
  for (const line of big.slice(0, 17)) assert.equal(plain(line).length, 43);
  // a1 is a dark square, and h1 is a light square with a white rook.
  assert.ok(big[15].startsWith(" 1 \x1b[48;2;10;100;72;"));
  assert.ok(big[15].endsWith("\x1b[48;2;148;156;151;38;2;255;255;255m  ♜  \x1b[0m"));
  // The cursor is on a8. The next line holds its lower half above the upper half of a7.
  assert.ok(big[1].startsWith(" 8 \x1b[48;2;226;191;89;38;2;2;32;33m  ♜  "));
  assert.ok(big[2].startsWith("   \x1b[38;2;226;191;89;48;2;10;100;72m▀▀▀▀▀"));
  // e2 is selected, and e3 is marked as a legal target.
  assert.ok(big[13].includes("\x1b[48;2;141;109;15;38;2;255;255;255m  ♟  "));
  assert.ok(big[11].includes("m  ·  "));
  const moved = render(position("e2e4 f7f6 d1h5"), { white: true, col: 0, row: 0, last: "d1h5" });
  assert.ok(moved[3].endsWith("\x1b[48;2;66;110;115;38;2;255;255;255m ♛ \x1b[0m"));
});

test("parses NDJSON split across chunks and skips keep-alives", async () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const chunks = (async function* () {
    yield bytes('{"a":1}\n\n{"b"');
    yield bytes(":2}\n");
  })();
  const seen = [];
  for await (const value of ndjson(chunks)) seen.push(value);
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  const unterminated = [];
  for await (const value of ndjson((async function* () { yield bytes('{"a":1}\n{"status":"mate"}'); })())) {
    unterminated.push(value);
  }
  assert.deepEqual(unterminated, [{ a: 1 }, { status: "mate" }]);
});

test("sends the token, posts moves and reports cleaned errors", async () => {
  const calls: [string, RequestInit][] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return url.endsWith("bad1") ? new Response("no\x1b[2J", { status: 400 }) : new Response("{}");
  }) as typeof fetch;
  const api = lichess("secret", new AbortController().signal, fake);
  await api.move("game", "e2e4");
  assert.equal(calls[0][0], "https://lichess.org/api/board/game/game/move/e2e4");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(calls[0][1].headers, { Authorization: "Bearer secret" });
  await assert.rejects(api.move("game", "bad1"), /Lichess 400: no\?\[2J/);
  assert.equal(clean("a\nb"), "a?b");
  await api.seek();
  assert.equal(String(calls.at(-1)?.[1].body), "rated=false&days=3");
});

test("logs in with PKCE and saves the token privately", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdtemp, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { login, savedToken } = await import("../src/auth.ts");
  const file = join(await mkdtemp(join(tmpdir(), "pi-chess-")), "nested", "token");
  let challenge = "";
  const token = await login(new AbortController().signal, {
    file,
    // Stands in for the browser: Lichess redirects back with the code and our state.
    open: (url) => {
      const query = new URL(url).searchParams;
      challenge = query.get("code_challenge") ?? "";
      assert.equal(query.get("scope"), "board:play challenge:read challenge:write follow:read");
      const back = query.get("redirect_uri");
      void fetch(`${back}?code=wrong&state=forged`).then(() =>
        fetch(`${back}?code=abc&state=${query.get("state")}`),
      );
    },
    fetchFn: (async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      assert.equal(body.get("code"), "abc");
      const verifier = body.get("code_verifier") ?? "";
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
      return Response.json({ access_token: "tok" });
    }) as typeof fetch,
  });
  assert.equal(token, "tok");
  assert.equal(await savedToken(file), "tok");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("solves the daily puzzle move by move and rejects a wrong move", async () => {
  const { attempt, parsePuzzle } = await import("../src/puzzle.ts");
  const puzzle = parsePuzzle({
    puzzle: {
      id: "BngAa",
      rating: 1898,
      fen: "8/6pp/4P3/1k6/8/p3K3/4RPPP/4r3 b - - 1 1",
      lastMove: "d2e2",
      solution: ["e1e2", "e3e2", "b5c6"],
    },
  });
  const board = position("", puzzle.fen);
  assert.equal(attempt(board, puzzle.solution, 0, "b5c6"), undefined);
  assert.equal(board.fen(), puzzle.fen);
  // The right move is played together with the opponent's reply.
  assert.deepEqual(attempt(board, puzzle.solution, 0, "e1e2"), { step: 2, last: "e3e2", solved: false });
  assert.equal(board.get("e2")?.type, "k");
  assert.deepEqual(attempt(board, puzzle.solution, 2, "b5c6"), { step: 3, last: "b5c6", solved: true });
});

test("accepts any checkmate in a puzzle and refuses an unreadable puzzle", async () => {
  const { attempt, parsePuzzle } = await import("../src/puzzle.ts");
  const board = position("", "6k1/8/6K1/8/8/8/8/RR6 w - - 0 1");
  assert.deepEqual(attempt(board, ["a1a8"], 0, "b1b8"), { step: 1, last: "b1b8", solved: true });
  assert.throws(() => parsePuzzle({ puzzle: { fen: "x", solution: [] } }), /cannot be read/);
  assert.throws(() => parsePuzzle({ puzzle: { fen: "x", solution: ["e2e4; rm"] } }), /cannot be read/);
  assert.throws(() => parsePuzzle({}), /cannot be read/);
});

test("lists the usernames this account follows", async () => {
  const fake = (async (url: string) => {
    assert.equal(url, "https://lichess.org/api/rel/following");
    return new Response('{"id":"ana","username":"Ana"}\n{"id":"x"}\n{"username":"karl_k"}\n');
  }) as typeof fetch;
  const api = lichess("secret", new AbortController().signal, fake);
  assert.deepEqual(await api.following(), ["Ana", "karl_k"]);
});
