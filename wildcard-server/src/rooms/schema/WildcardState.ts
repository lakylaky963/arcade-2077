// Synchronised room state. Hidden hands use Colyseus StateView exactly like
// colyseus/turnbased-cards-demo (MIT, (c) 2026 Endel Dreyer, see
// ../../../LICENSE-turnbased-cards-demo): `hand` is `view: true`, so a client
// only receives the hand of the seat its StateView was given; `handCount` is
// public. Only schema constructs the demo itself uses are used here.

import { schema } from "@colyseus/schema";

export const CardSchema = schema({
  id: "string",
  kind: "string",        // "color" | "wild"
  color: "string",       // "red" | "yellow" | "green" | "blue", "" for wilds
  value: "string",       // "0".."9" | "skip" | "reverse" | "draw2" | "wild" | "wild_draw4"
  chosenColor: "string", // wild on top of the discard pile: the colour picked, "" otherwise
});

export const PlayerSchema = schema({
  sessionId: "string",       // "" for a bot seat
  seatIndex: "number",
  name: "string",
  isBot: "boolean",          // a bot is playing this seat right now (empty seat or autopilot)
  occupied: "boolean",       // a person owns this seat (even while a bot holds it for them)
  connected: "boolean",
  autopilot: "boolean",
  autopilotReason: "string", // "" | "timeout" | "disconnect"
  kind: "string",            // "user" (signed in) | "guest" | "bot"
  handle: "string",          // dashboard handle of a signed-in user, else ""
  isHost: "boolean",
  timeouts: "number",        // consecutive turns lost to the timer
  hand: { array: CardSchema, view: true },  // only visible via StateView
  handCount: "number",                      // always visible to all
});

export const WildcardState = schema({
  roomCode: "string",
  phase: "string",           // "lobby" | "playing" | "finished"
  players: { map: PlayerSchema },           // keyed by seat index "0".."3"
  discardPile: { array: CardSchema },       // last few cards, top is the LAST element
  discardCount: "number",
  drawPileCount: "number",
  currentPlayer: "number",   // seat index
  direction: "number",       // 1 or -1
  activeColor: "string",
  pendingDraw: "number",     // cards the seat on turn owes
  pendingKind: "string",     // "" | "draw2" | "wild_draw4"
  winner: "number",          // -1 = none
  hostSeat: "number",        // -1 = none
  seatCount: "number",
  stacking: "boolean",
  turnSeconds: "number",     // 0 = no timer
  turnDeadline: "number",    // epoch ms the seat on turn times out, 0 = none
  matchNumber: "number",     // 0 until the first deal, +1 per deal (lets clients reset animations)
});
