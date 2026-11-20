# wildcard-server

Game server for **WILDCARD // 2077** (our Uno, the 8th Night Lab // Arcade 2077 cabinet, game id `wildcard`).
Colyseus 0.17, `@colyseus/schema` 4, TypeScript, adapted from
[colyseus/turnbased-cards-demo](https://github.com/colyseus/turnbased-cards-demo) (MIT, see
[`LICENSE-turnbased-cards-demo`](LICENSE-turnbased-cards-demo)).

It is **not** a static file: it runs in its own container (CT 113, step D) and must never be copied to CT 112.
`../deploy.ps1` excludes this folder and aborts if it finds it in the archive.

Step A of TODO 14: server only. The phone client (`wildcard/`, step B) and the dashboard endpoint (step C) come next.

## Layout

```
src/rules/uno.ts      pure rules: 108-card deck, deal, skip/reverse/+2/wild/+4, stacking, draw, win, standings
src/rules/bot.ts      bot strategy (pure)
src/match/Match.ts    the match engine: seats, lobby, timer, bot takeover, reconnection hold, host, results
src/rooms/            Colyseus adapter: WildcardRoom + schema (StateView hidden hands)
src/auth/session.ts   homelab_session cookie -> dashboard GET /api/game/me
src/reporting/        results -> dashboard (stub interface, step C builds the endpoint)
src/storage/          Mongo `uno_hub` match log + per-user stats
src/lib/              room options, 5-letter room codes, display names
```

Everything except `rooms/` is dependency-free and unit-tested with `node --test` (no install needed, Node >= 22.18).
`rooms/` is a thin adapter over `Match`; it needs the Colyseus packages.

```sh
cd wildcard-server
npm test                 # node --test "src/**/*.test.ts"
npm install && npm run typecheck && npm start     # needs the Colyseus packages
```

Environment variable names are in [`.env.example`](.env.example) (values live on the server, never in the repo).

## Rules

Standard 108-card deck, 7 cards each, first non-wild card starts the pile.

- **skip** skips the next seat. **reverse** flips direction; **with 2 seats it acts as skip** (you go again).
- **+2 / wild +4**: the next seat owes 2 / 4 cards and its turn is spent drawing them.
- **Stacking toggle** (off by default): with it on, a +2 can be answered with another +2 (any colour) and a +4
  with another +4; the total is drawn by whoever cannot or will not stack. **Same kind only** (no +4 on a +2).
- **Draw when stuck**: no legal card means draw one and the turn passes (as in the demo the drawn card is not
  played the same turn). A human who has nothing playable is drawn for automatically after ~0.7 s.
  Drawing voluntarily while holding a playable card is allowed (as in the demo).
- A wild +4 is always playable (no "only if you hold no card of the colour" rule, no challenge: same as the demo).
- First card effects: skip starts seat 1; reverse reverses and starts the last seat; +2 makes seat 0 owe 2.
- Winner: first to empty their hand. Standings rank the others by points left in hand (number = face value,
  skip/reverse/+2 = 20, wild/+4 = 50); the winner's `score` is the sum of the other hands.
- No UNO call, no scoring across rounds.

## Room options

| option | values | default | when |
|---|---|---|---|
| `seats` | 2, 3, 4 | 4 | at creation only; seats nobody takes are played by bots |
| `stacking` | true / false | false | creation, or host `set_options` outside a running game |
| `turnSeconds` | 15, 30, 0 (off) | 30 | creation, or host `set_options` outside a running game |

- **Timer**: a human who does not move in time gets a bot move made for them. After **2 timeouts in a row** a bot
  takes the seat over (`autopilot`, reason `timeout`) but the seat stays theirs. Acting, or sending `resume`, takes
  it back. A manual move resets the count.
- **Reconnection**: a dropped connection is held for **30 s** (`allowReconnection`). A bot plays the seat during the
  hold (reason `disconnect`); coming back hands it back. When the hold runs out, or the player leaves, the seat
  becomes a normal bot seat that a newcomer can take (they get that seat's current hand).
- **Room code**: the 5-letter `roomId` (consonants only: no accidental words). Rooms are private: they never
  auto-match, people join with `joinById(code)`.
- One seat per signed-in account per room (stops farming XP against yourself).

## Client contract (for step B)

Create: `client.create("wildcard", { name, seats, stacking, turnSeconds })`. Join: `client.joinById("BCDFG", { name })`.
Authenticated players are identified by the `homelab_session` cookie sent with the WebSocket handshake (the client
must connect through the same origin as the hub); `name` is only used for guests.

Messages, client -> server:

| type | payload | notes |
|---|---|---|
| `play_card` | `{ cardId, chosenColor? }` | `chosenColor` (`red\|yellow\|green\|blue`) is required for wilds |
| `draw_card` | `{}` | draws 1 card, or the pending penalty; ends the turn |
| `resume` | `{}` | take the seat back from the bot |
| `set_options` | `{ stacking?, turnSeconds? }` | host only, not while playing |
| `start` / `restart` | `{}` | host only: deal from the lobby, or deal again after a game |

Server -> client: `welcome { seat, roomCode, kind, name }` once after joining; `event` play-by-play
(`play {seat, card, chosenColor}`, `draw {seat, count, forced}`, `skip {seat}`, `reverse {direction}`,
`win {seat}`, each with `bot: boolean`; never reveals drawn cards); `rejected { action, reason }` when a message is
refused (`not_your_turn`, `not_playable`, `must_draw`, `color_required`, `unknown_card`, `not_host`, ...).
Join errors: `4101 room_full`, `4102 duplicate_user`.

State (`WildcardState`): `roomCode, phase (lobby|playing|finished), players{seat -> PlayerSchema}, discardPile
(last 8, top is last), discardCount, drawPileCount, currentPlayer, direction, activeColor, pendingDraw, pendingKind,
winner (-1 none), hostSeat, seatCount, stacking, turnSeconds, turnDeadline (epoch ms, 0 none), matchNumber`.
`PlayerSchema`: `sessionId, seatIndex, name, isBot, occupied, connected, autopilot, autopilotReason, kind
(user|guest|bot), handle, isHost, timeouts, handCount` (public) and `hand` (**`view: true`**: only the owner's
StateView receives it, exactly as in the demo). Use `players` entry whose `sessionId === room.sessionId` for your own seat.

## Results contract (for step C)

When a game ends with a winner and at least one signed-in user was seated, the server logs the match to Mongo
(`uno_hub.matches`, plus `uno_hub.player_stats` upserts) and POSTs it to `DASHBOARD_RESULTS_URL`:

```
POST <DASHBOARD_RESULTS_URL>
Authorization: Bearer <DASHBOARD_SERVICE_TOKEN>
Content-Type: application/json
Idempotency-Key: <matchId>
```
```json
{
  "game": "wildcard",
  "matchId": "6f1c...-uuid",
  "roomCode": "BCDFG",
  "startedAt": "2026-11-20T10:00:00.000Z",
  "endedAt": "2026-11-20T10:05:00.000Z",
  "durationMs": 300000,
  "options": { "seats": 4, "stacking": false, "turnSeconds": 30 },
  "humanPlayers": 2,
  "players": [
    { "seat": 0, "kind": "user", "handle": "avraham", "name": "Avraham", "role": "owner", "rank": 1, "winner": true,
      "cardsLeft": 0, "handPoints": 0, "score": 74, "afk": false, "timeouts": 0, "botTurns": 0 },
    { "seat": 1, "kind": "guest", "handle": null, "name": "Sam", "role": null, "rank": 3, "winner": false, "...": "..." },
    { "seat": 2, "kind": "bot", "handle": null, "name": "Bot 3", "role": null, "rank": 2, "winner": false, "...": "..." }
  ]
}
```

- Respond **2xx** when stored. The server retries network errors, 429 and 5xx (3 attempts: now, +1 s, +4 s); any other
  4xx is final. Be **idempotent on `matchId`**: a retry can arrive after a slow success.
- Only `kind: "user"` entries are dashboard accounts (`handle` = the dashboard handle, lower-case). Guests and bots
  never earn XP. The server does **not** decide XP; it sends the facts and the dashboard decides.
  Useful signals: `winner`, `rank`, `score`, `humanPlayers` (1 = solo against bots), `afk` (autopilot at the end, or a
  bot made the winning move: suggested no XP), `role` (e.g. `recruiter_guest` sandbox accounts).
- Until step C exists leave `DASHBOARD_RESULTS_URL` / `DASHBOARD_SERVICE_TOKEN` unset: results are then only
  logged and stored (`report: { status: "skipped" }`). A failed report is stored on the match as
  `report: { status: "failed", ... }` so it can be replayed.

## Limits and notes

- Single process (room codes are checked against the local room registry). Fine for one container.
- If MongoDB is unreachable at boot, matches are kept in memory (last 200) and a warning is logged; the game is
  never blocked by logging.
- The Colyseus playground and monitor are only mounted when `ENABLE_DEBUG_UI=1` (the demo mounts them on `/`).
- Third-party licence: the rules, schema shape, message names and StateView handling are adapted from the MIT demo;
  keep [`LICENSE-turnbased-cards-demo`](LICENSE-turnbased-cards-demo) with this folder.
