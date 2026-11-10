import { clean } from "./lichess.ts";

/**
 * Optional opponent roster. PI_CHESS_ROSTER holds a command that prints JSON:
 * a list of `{ "name": "...", "lichess": "..." }` entries.
 */
export const rosterCommand = (value = process.env.PI_CHESS_ROSTER) =>
  value?.trim() ? value.trim().split(/\s+/) : undefined;

/** Roster entries with a valid Lichess username. */
export function members(json: string) {
  const parsed = JSON.parse(json);
  const entries: unknown[] = Array.isArray(parsed) ? parsed : (parsed?.records ?? []);
  return entries.flatMap((entry: any) => {
    // Also accepts a record store's shape: { records: [{ data: { name, accounts: { lichess } } }] }.
    const profile = entry?.data ?? entry;
    const lichess = profile?.lichess ?? profile?.accounts?.lichess;
    // Roster text is typed by people: accept only a valid Lichess username.
    if (typeof lichess !== "string" || !/^[a-z0-9_-]{2,30}$/i.test(lichess)) return [];
    return [{ name: clean(String(profile.name ?? lichess)), lichess: lichess.toLowerCase() }];
  });
}
