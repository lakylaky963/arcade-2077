// WILDCARD // 2077 room: a thin Colyseus adapter around the Match engine.
//
// Adapted from colyseus/turnbased-cards-demo (server/src/rooms/UnoRoom.ts), MIT,
// Copyright (c) 2026 Endel Dreyer. See ../../LICENSE-turnbased-cards-demo.
// Kept from the demo: the message names (play_card, draw_card, restart),
// bot-filled seats that humans replace, and StateView for hidden hands
// (the view is given the player; every new card is pushed into the hand
// FIRST and only then added to the view, because a detached instance cannot
// be added). Everything else (rules, bots, timer, reconnection, auth, logging,
// reporting) lives in the Match engine and its neighbours so it can be tested
// without Colyseus.
//
// Client contract (messages):
//   client -> server
//     play_card   { cardId: string, chosenColor?: "red"|"yellow"|"green"|"blue" }  (colour required for wilds)
//     draw_card   {}                       draw 1 card (or the pending penalty); ends the turn
//     resume      {}                       take the seat back from the bot after timeouts
//     set_options { stacking?: boolean, turnSeconds?: 0|15|30 }   host only, not mid-game
//     start       {}                       host only: deal (lobby) or deal again (after a game)
//     restart     {}                       same as start
//   server -> client
//     welcome     { seat, roomCode, kind, name }     once, after joining
//     event       { type: "play"|"draw"|"skip"|"reverse"|"win", ... , bot: boolean }   play-by-play
//     rejected    { action, reason }                 a message was refused
//   Create: client.create("wildcard", { name, seats: 2-4, stacking, turnSeconds })
//   Join:   client.joinById(CODE, { name })   (CODE = the 5-letter roomId)

import { Room, matchMaker, ServerError, type AuthContext, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { randomUUID } from "node:crypto";
import { lookupSession, toIdentity } from "../auth/session.ts";
import { parseCreateOptions, parseOptionsPatch } from "../lib/options.ts";
import { generateRoomCode } from "../lib/roomCode.ts";
import { Match, type ActionResult } from "../match/Match.ts";
import { COLORS, type Card, type GameEvent } from "../rules/uno.ts";
import { runtime } from "../runtime.ts";
import type { Identity, MatchDoc, MatchResult } from "../types.ts";
import { CardSchema, PlayerSchema, WildcardState } from "./schema/WildcardState.ts";

type RoomState = InstanceType<typeof WildcardState>;
type PlayerInstance = InstanceType<typeof PlayerSchema>;
type CardInstance = InstanceType<typeof CardSchema>;

/** How long a dropped player's seat is held by a bot before it is given up. */
export const RECONNECT_SECONDS = 30;
/** How many discard cards the state shows (top is the last). */
const DISCARD_WINDOW = 8;

const ERR_FULL = 4101;
const ERR_DUPLICATE = 4102;

function toCardSchema(card: Card, chosenColor = ""): CardInstance {
  const c = new CardSchema();
  c.id = card.id;
  if (card.kind === "color") {
    c.kind = "color";
    c.color = card.color;
    c.value = card.value;
    c.chosenColor = "";
  } else {
    c.kind = "wild";
    c.color = "";
    c.value = card.value;
    c.chosenColor = chosenColor;
  }
  return c;
}

function publicCard(card: Card) {
  return card.kind === "color"
    ? { id: card.id, kind: card.kind, color: card.color, value: card.value }
    : { id: card.id, kind: card.kind, color: "", value: card.value };
}

export class WildcardRoom extends Room<{ state: RoomState }> {
  private match!: Match;
  /** One StateView per seat that a person owns. Kept here (not looked up from this.clients) so a bot
   *  holding a dropped player's seat can keep adding cards to the view that player gets back on reconnect. */
  private views = new Map<number, StateView>();
  private discardKey = "";
  private lastMatchId = "";

  async onCreate(rawOptions: unknown) {
    const options = parseCreateOptions(rawOptions);

    // 5-letter room code as roomId (single process: the local registry is the source of truth).
    this.roomId = generateRoomCode((code) => matchMaker.getLocalRoomById(code) !== undefined);
    // Colyseus locks the room by itself when seats (clients + reconnection holds) reach maxClients.
    this.maxClients = options.seats;
    // Hidden from joinOrCreate/auto-matching: people get in with the code (joinById).
    await this.setPrivate(true);

    this.setState(new WildcardState());
    const state = this.state;
    state.roomCode = this.roomId;
    state.phase = "lobby";
    state.winner = -1;
    state.hostSeat = -1;
    state.direction = 1;
    state.seatCount = options.seats;

    for (let i = 0; i < options.seats; i++) {
      const player = new PlayerSchema();
      player.seatIndex = i;
      player.sessionId = "";
      player.name = `Bot ${i + 1}`;
      player.isBot = true;
      player.kind = "bot";
      player.handle = "";
      player.autopilotReason = "";
      state.players.set(String(i), player);
    }

    this.match = new Match({
      options,
      roomCode: this.roomId,
      newId: randomUUID,
      hooks: {
        onChange: () => this.sync(),
        onEvents: (events, meta) => this.broadcastEvents(events, meta.bot),
        onFinished: (result, doc) => this.finishMatch(result, doc),
      },
    });
    this.sync();

    this.onMessage("play_card", (client: Client, message: unknown) => {
      const m = (message ?? {}) as { cardId?: unknown; chosenColor?: unknown };
      const cardId = typeof m.cardId === "string" ? m.cardId.slice(0, 40) : "";
      const color = COLORS.find((c) => c === m.chosenColor);
      this.answer(client, "play_card", this.match.play(client.sessionId, cardId, color));
    });
    this.onMessage("draw_card", (client: Client) => {
      this.answer(client, "draw_card", this.match.draw(client.sessionId));
    });
    this.onMessage("resume", (client: Client) => {
      this.answer(client, "resume", this.match.resume(client.sessionId));
    });
    this.onMessage("set_options", (client: Client, message: unknown) => {
      this.answer(client, "set_options", this.match.setOptions(client.sessionId, parseOptionsPatch(message)));
    });
    const start = (client: Client) => this.answer(client, "start", this.match.start(client.sessionId));
    this.onMessage("start", start);
    this.onMessage("restart", start);
  }

  /** Who is joining? Read the hub SSO cookie and ask the dashboard; anything else plays as a guest. */
  async onAuth(client: Client, options: any, context: AuthContext): Promise<Identity> {
    const rt = runtime();
    const lookup = await lookupSession(context.headers.get("cookie"), { meUrl: rt.meUrl });
    if (!lookup.ok && lookup.reason !== "no_cookie") {
      rt.log(`[auth] session lookup: ${lookup.reason}; joining as guest`);
    }
    return toIdentity(lookup, options?.name);
  }

  onJoin(client: Client) {
    const identity = client.auth as Identity;
    const joined = this.match.join(client.sessionId, identity);
    if (!joined.ok) {
      throw new ServerError(joined.reason === "full" ? ERR_FULL : ERR_DUPLICATE, joined.reason);
    }

    // Hidden hands, as in the demo: the client's view contains its own seat (and, with it, its hand).
    const view = new StateView();
    client.view = view;
    this.views.set(joined.seat, view);
    view.add(this.state.players.get(String(joined.seat)) as PlayerInstance);

    client.send("welcome", {
      seat: joined.seat,
      roomCode: this.roomId,
      kind: identity.kind,
      name: this.match.seats[joined.seat]?.name,
    });
  }

  /** Connection lost without a goodbye: a bot holds the seat while the player may come back. */
  onDrop(client: Client) {
    if (this.match.seatOf(client.sessionId) === null) return;
    this.match.drop(client.sessionId);
    // On timeout Colyseus calls onLeave, which gives the seat up. The catch only silences the rejection.
    this.allowReconnection(client, RECONNECT_SECONDS).catch(() => {});
  }

  /** The player is back (same seat, same StateView). */
  onReconnect(client: Client) {
    this.match.reconnect(client.sessionId);
  }

  /** Left for good: said goodbye, or the reconnection window ran out. The seat goes back to a bot. */
  onLeave(client: Client) {
    const seat = this.match.seatOf(client.sessionId);
    if (seat === null) return;
    this.views.delete(seat.index);
    this.match.leave(client.sessionId);
  }

  onDispose() {
    const rt = runtime();
    const abandoned = this.match.dispose();
    if (abandoned !== null) void rt.store.recordMatch(abandoned);
  }

  // ── replies and broadcasts ────────────────────────────────────────

  private answer(client: Client, action: string, result: ActionResult) {
    if (!result.ok) client.send("rejected", { action, reason: result.reason });
  }

  private broadcastEvents(events: GameEvent[], bot: boolean) {
    for (const e of events) {
      switch (e.type) {
        case "play":
          this.broadcast("event", { type: "play", seat: e.seat, card: publicCard(e.card), chosenColor: e.chosenColor ?? "", bot });
          break;
        case "draw":
          // only the count: never which cards
          this.broadcast("event", { type: "draw", seat: e.seat, count: e.count, forced: e.forced, bot });
          break;
        case "skip":
          this.broadcast("event", { type: "skip", seat: e.seat, bot });
          break;
        case "reverse":
          this.broadcast("event", { type: "reverse", direction: e.direction, bot });
          break;
        case "win":
          this.broadcast("event", { type: "win", seat: e.seat, bot });
          break;
      }
    }
  }

  /** Log the match, then tell the dashboard (who decides XP), then note how that went. Never throws. */
  private finishMatch(result: MatchResult, doc: MatchDoc) {
    const rt = runtime();
    void (async () => {
      try {
        await rt.store.recordMatch(doc);
        const outcome = result.players.some((p) => p.kind === "user")
          ? await rt.reporter.report(result)
          : ({ status: "skipped", reason: "no signed-in players" } as const);
        await rt.store.setReport(doc.matchId, outcome);
        rt.log(`[match ${doc.matchId}] room ${doc.roomCode} finished; report ${outcome.status}`);
      } catch (e) {
        rt.log(`[match ${doc.matchId}] finish handling failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  // ── Match -> schema ───────────────────────────────────────────────

  private sync() {
    const m = this.match;
    const s = this.state;
    const g = m.game;

    s.phase = m.phase;
    s.hostSeat = m.hostSeat;
    s.stacking = m.options.stacking;
    s.turnSeconds = m.options.turnSeconds;
    s.turnDeadline = m.turnDeadline;
    if (m.matchId !== this.lastMatchId) {
      this.lastMatchId = m.matchId;
      s.matchNumber += 1;
      this.discardKey = "";
    }

    if (g !== null) {
      s.currentPlayer = g.current;
      s.direction = g.direction;
      s.activeColor = g.activeColor;
      s.pendingDraw = g.pending;
      s.pendingKind = g.pendingKind ?? "";
      s.winner = g.winner ?? -1;
      s.drawPileCount = g.drawPile.length;
      s.discardCount = g.discard.length;
      this.syncDiscard(g.discard, g.activeColor);
    }

    for (const seat of m.seats) {
      const player = s.players.get(String(seat.index)) as PlayerInstance;
      const identity = seat.occupant?.identity ?? null;
      player.sessionId = seat.occupant?.clientId ?? "";
      player.name = seat.name;
      player.isBot = m.isBotControlled(seat);
      player.occupied = seat.occupant !== null;
      player.connected = seat.connected;
      player.autopilot = seat.autopilot;
      player.autopilotReason = seat.autopilotReason ?? "";
      player.kind = identity ? identity.kind : "bot";
      player.handle = identity?.handle ?? "";
      player.isHost = seat.index === m.hostSeat;
      player.timeouts = seat.timeouts;
      this.syncHand(player, seat.index, g?.hands[seat.index] ?? []);
    }
  }

  /** Make the seat's `hand` array match the engine's hand, registering new cards with the seat's StateView. */
  private syncHand(player: PlayerInstance, seatIndex: number, target: readonly Card[]) {
    const hand = player.hand;
    const want = new Set(target.map((c) => c.id));
    for (let i = hand.length - 1; i >= 0; i--) {
      if (!want.has((hand[i] as CardInstance).id)) hand.splice(i, 1);
    }
    const have = new Set<string>();
    hand.forEach((c: CardInstance) => have.add(c.id));
    const view = this.views.get(seatIndex);
    for (const card of target) {
      if (have.has(card.id)) continue;
      const schemaCard = toCardSchema(card);
      hand.push(schemaCard); // attach first...
      view?.add(schemaCard); // ...then make it visible to its owner (a detached instance cannot be added)
    }
    player.handCount = target.length;
  }

  private syncDiscard(discard: readonly Card[], activeColor: string) {
    const tail = discard.slice(-DISCARD_WINDOW);
    const key = `${tail.map((c) => c.id).join("|")}:${activeColor}`;
    if (key === this.discardKey) return;
    this.discardKey = key;
    const pile = this.state.discardPile;
    pile.splice(0, pile.length);
    tail.forEach((card, i) => {
      const isTop = i === tail.length - 1;
      pile.push(toCardSchema(card, isTop && card.kind === "wild" ? activeColor : ""));
    });
  }
}
