// Lichess Board API client. Docs: https://lichess.org/api#tag/Board

/** Lichess text (names, errors) is external input: keep terminal controls out of the UI. */
export const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

export async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    // Blank lines are keep-alives.
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  // The last event can arrive without a newline when Lichess closes the stream.
  if (buffer.trim()) yield JSON.parse(buffer);
}

export function lichess(token: string, signal: AbortSignal, fetchFn: typeof fetch = fetch) {
  const call = async (path: string, form?: Record<string, string>) => {
    const res = await fetchFn(`https://lichess.org${path}`, {
      method: form ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}` },
      body: form && new URLSearchParams(form),
      signal,
    });
    if (!res.ok) throw new Error(`Lichess ${res.status}: ${clean(await res.text())}`);
    return res;
  };
  const stream = async (path: string) => ndjson((await call(path)).body as AsyncIterable<Uint8Array>);
  // Casual correspondence, 3 days per move.
  const terms = { rated: "false", days: "3" };
  return {
    playing: async (): Promise<
      { gameId: string; color: "white" | "black"; isMyTurn?: boolean; opponent?: { username?: string } }[]
    > =>
      (await (await call("/api/account/playing")).json()).nowPlaying,
    account: async (): Promise<string> => (await (await call("/api/account")).json()).id,
    game: (id: string) => stream(`/api/board/game/stream/${id}`),
    seek: async () => {
      // A correspondence seek stays in the Lichess lobby after this response ends.
      await (await call("/api/board/seek", terms)).body?.cancel();
    },
    challenge: (user: string) => call(`/api/challenge/${encodeURIComponent(user)}`, terms),
    challenges: async (): Promise<{ in: Challenge[]; out: Challenge[] }> => {
      const body = await (await call("/api/challenge")).json();
      return { in: body.in ?? [], out: body.out ?? [] };
    },
    accept: (id: string) => call(`/api/challenge/${encodeURIComponent(id)}/accept`, {}),
    move: (id: string, uci: string) => call(`/api/board/game/${id}/move/${uci}`, {}),
    resign: (id: string) => call(`/api/board/game/${id}/resign`, {}),
  };
}

export type Challenge = { id: string; challenger?: { name?: string }; destUser?: { name?: string } };
export type Lichess = ReturnType<typeof lichess>;
