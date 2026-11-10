# pi-chess

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="pi-chess" src="assets/banner-dark.svg">
</picture>

```bash
pi install https://github.com/denismrvoljak/pi-chess
```

Lichess correspondence chess for pi.

`pi-chess` adds a `/chess` command to [pi](https://github.com/earendil-works/pi). It shows a chess board above the input box, and the agent keeps working while you play.

## What this is

`pi-chess` is a pi package for playing correspondence chess on [Lichess](https://lichess.org) without leaving the terminal. It is meant for slow games beside your work: make a move, close the board, and come back when it is your turn.

Every game lives on Lichess. The package saves no game state, makes no model calls, and puts no position or move into the conversation.

## What it does

- opens your ongoing Lichess games and shows whose move it is
- lists incoming challenges, so you can accept them from pi
- challenges a Lichess user, a person from your own roster, or anyone through a public seek
- starts every game as casual correspondence with 3 days per move
- draws the board in two sizes, the large one with block-art pieces
- logs in through the Lichess consent page in the browser, with no app registration

## Install

### From GitHub

```bash
pi install https://github.com/denismrvoljak/pi-chess
```

Then run `/reload`. pi installs the one dependency, `chess.js`.

### Local path install

Use this when developing on the package itself:

```bash
npm install
pi install /absolute/path/to/pi-chess
pi list
```

## Commands

| Command | What it does |
|---|---|
| `/chess` | Opens the only ongoing game. With several games or incoming challenges, it shows a menu: open a game, accept a challenge, or start a new game. |
| `/chess new` | Starts a game. Pick an opponent from your roster, or post a public Lichess seek. |
| `/chess <user>` | Challenges a Lichess user. |
| `/chess accept` | Accepts the first incoming challenge and opens the game. |
| `/chess stop` | Closes the board, or cancels a login that waits for the browser. |
| `/chess logout` | Deletes the saved token. |

A challenge or a seek returns at once, because the opponent can take days to answer. Run `/chess` again after they accept. The menu title names the opponents who have not yet answered a challenge that you sent.

## Playing

| Key | Action |
|---|---|
| Arrows | Move the cursor |
| Enter or Space | Select a piece, then move it |
| `b` | Switch the board size |
| `R` twice | Resign |
| Escape | Close the board. The game continues on Lichess. |

- The small board is 9 rows. The large board is 25 rows, draws each piece as block art, and needs a terminal with at least 34 rows.
- The board takes every key while it is open. Press Escape to type to the agent.
- A finished game shows its result and stays until Escape or the next `/chess`.
- A pawn always promotes to a queen.

## Login

The first `/chess` opens the Lichess consent page in the browser. It uses OAuth with PKCE, so there is no app registration and no client secret. The requested scopes are `board:play`, `challenge:read` and `challenge:write`.

The token is saved to `~/.config/pi-chess/token` with mode 600. When Lichess rejects the token, the package deletes it, and the next `/chess` logs in again.

On a machine without a browser, set `LICHESS_TOKEN` to a personal Lichess token with the same three scopes.

`/chess logout` deletes the local file only. Revoke the token at lichess.org/account/security.

## Opponent roster

`/chess new` can list people you play often, such as a chess club. Set `PI_CHESS_ROSTER` to a command that prints JSON:

```json
[
  { "name": "Ana", "lichess": "ana_plays" },
  { "name": "Karl", "lichess": "karl_k" }
]
```

```bash
export PI_CHESS_ROSTER="cat /absolute/path/to/roster.json"
```

The command runs each time the picker opens, so the list can come from a file or from a service. Entries without a valid Lichess username are skipped, and your own account is left out. Without `PI_CHESS_ROSTER`, the picker offers only the public seek.

## Local development workflow with `/reload`

```bash
cd /absolute/path/to/pi-chess
npm install
pi install /absolute/path/to/pi-chess
```

Edit a file, then run `/reload` in pi and `/chess` again.

## Development and verification commands

```bash
npm test
npm run check
```

The tests cover move replay, legal moves, board drawing, the game stream reader, the API client, the login against a local stand-in, and roster parsing.

## Known limitations

- **Standard chess only.** A variant game fails to open.
- **No reconnect.** A dropped game stream closes the board with an error. Run `/chess` again.
- **No draw offers, chat or move list.**
- **No cancel for a sent challenge.** Cancel it on lichess.org.
- **No automated test for the pi wiring.** The file that connects the parts to pi is checked by hand.
- **24-bit colour.** The board needs a terminal with true colour.

## Credits

The block-art pieces of the large board come from [chess-tui](https://github.com/thomas-mauran/chess-tui) by Thomas Mauran, under the MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
