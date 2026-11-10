// Lichess OAuth: authorization code with PKCE. Public clients need no registration.
// Docs: https://lichess.org/api#tag/OAuth
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clean } from "./lichess.ts";

const CLIENT = "pi-chess";
const TOKEN_FILE = join(homedir(), ".config", "pi-chess", "token");

export const savedToken = (file = TOKEN_FILE) =>
  readFile(file, "utf8").then(
    (text) => text.trim() || undefined,
    () => undefined,
  );

export const forgetToken = (file = TOKEN_FILE) => rm(file, { force: true });

const browser = (url: string) => {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
};

/** Opens the Lichess consent page, waits for the redirect, then saves and returns the token. */
export async function login(
  signal: AbortSignal,
  { open = browser, fetchFn = fetch as typeof fetch, file = TOKEN_FILE } = {},
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      server.on("request", (request, response) => {
        const query = new URL(request.url ?? "/", redirect).searchParams;
        // Ignore anything that is not our redirect (favicon, other local requests).
        if (query.get("state") !== state) return void response.writeHead(400).end();
        const granted = query.get("code");
        response.end(granted ? "Lichess is connected. Return to Pi." : "Lichess login failed.");
        if (granted) resolve(granted);
        else reject(new Error(`Lichess login failed: ${clean(query.get("error") ?? "no code")}`));
      });
      open(
        `https://lichess.org/oauth?${new URLSearchParams({
          response_type: "code",
          client_id: CLIENT,
          redirect_uri: redirect,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          scope: "board:play challenge:read challenge:write",
          state,
        })}`,
      );
    });
    const response = await fetchFn("https://lichess.org/api/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        client_id: CLIENT,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Lichess ${response.status}: ${clean(await response.text())}`);
    const token: string = (await response.json()).access_token;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, token, { mode: 0o600 });
    return token;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
