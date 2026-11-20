// The match engine: seats, lobby, turn timer, bot takeover, reconnection holds,
// host handling and results. It owns a pure rules GameState and knows nothing
// about Colyseus: the room forwards messages in and mirrors the state out.
// That keeps everything here testable with a fake clock.
//
// Seat model: every seat starts as a bot. A person who joins takes the lowest
// free (bot) seat. A seat has an `occupant` while a person owns it, even when
// a bot is playing for them (autopilot), so nobody else can take it:
//   - 2 timeouts in a row  -> autopilot (reason "timeout"); the person takes
//     control back by acting or sending `resume`
//   - dropped connection   -> autopilot (reason "disconnect") while the room
//     holds the seat for reconnection; `reconnect()` gives it back
//   - left / hold expired  -> `leave()`: the seat becomes a plain bot again.

import { chooseMove } from '../rules/bot.ts';
import {
  applyMove,
  createGame,
  handPoints,
  mustDraw,
  standings,
  type Color,
  type GameEvent,
  type GameState,
  type Move,
  type RejectReason,
  type Rng,
} from '../rules/uno.ts';
import type { OptionsPatch, RoomOptions } from '../lib/options.ts';
import { uniqueName } from '../lib/names.ts';
import type { Identity, LoggedMove, MatchDoc, MatchResult, PlayerResult } from '../types.ts';

export type Phase = 'lobby' | 'playing' | 'finished';

export const TIMEOUTS_BEFORE_AUTOPILOT = 2;

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Timing {
  /** A bot waits this long before moving (+ up to botJitterMs). */
  botDelayMs: number;
  botJitterMs: number;
  /** A human with no legal play (must draw) is drawn for after this long. Not a timeout. */
  forcedDelayMs: number;
}

export const DEFAULT_TIMING: Timing = { botDelayMs: 900, botJitterMs: 300, forcedDelayMs: 700 };

export interface Seat {
  index: number;
  name: string;
  occupant: { clientId: string; identity: Identity } | null;
  connected: boolean;
  autopilot: boolean;
  autopilotReason: 'timeout' | 'disconnect' | null;
  /** Consecutive turns lost to the timer. */
  timeouts: number;
  /** Moves a bot made while this person owned the seat. */
  botTurns: number;
}

export interface MatchHooks {
  /** Anything visible changed: re-sync the room state. Called once per operation. */
  onChange(): void;
  /** Public play-by-play for animations and toasts. Never contains hidden cards. */
  onEvents(events: GameEvent[], meta: { seat: number; bot: boolean }): void;
  /** The game ended with a winner. */
  onFinished(result: MatchResult, doc: MatchDoc): void;
}

export interface MatchConfig {
  options: RoomOptions;
  roomCode: string;
  hooks: MatchHooks;
  scheduler?: Scheduler;
  rng?: Rng;
  now?: () => number;
  newId?: () => string;
  timing?: Partial<Timing>;
}

export type JoinResult = { ok: true; seat: number } | { ok: false; reason: 'full' | 'duplicate_user' };
export type ActionResult =
  | { ok: true }
  | { ok: false; reason: RejectReason | 'not_playing' | 'not_seated' | 'not_host' | 'bad_phase' | 'autopilot' };

export class Match {
  readonly roomCode: string;
  readonly seats: Seat[];
  options: RoomOptions;
  phase: Phase = 'lobby';
  game: GameState | null = null;
  hostSeat = -1;
  /** Epoch ms when the human on turn times out; 0 = no deadline. */
  turnDeadline = 0;
  matchId = '';

  private readonly hooks: MatchHooks;
  private readonly scheduler: Scheduler;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly timing: Timing;
  private timer: unknown = null;
  private startedAt = 0;
  private moves: LoggedMove[] = [];
  private lastMoveBot = false;

  constructor(config: MatchConfig) {
    this.options = { ...config.options };
    this.roomCode = config.roomCode;
    this.hooks = config.hooks;
    this.scheduler = config.scheduler ?? realScheduler;
    this.rng = config.rng ?? Math.random;
    this.now = config.now ?? Date.now;
    this.newId = config.newId ?? (() => `${this.now().toString(36)}-${Math.floor(this.rng() * 1e9).toString(36)}`);
    this.timing = { ...DEFAULT_TIMING, ...config.timing };
    this.seats = Array.from({ length: this.options.seats }, (_, index) => ({
      index,
      name: botName(index),
      occupant: null,
      connected: false,
      autopilot: false,
      autopilotReason: null,
      timeouts: 0,
      botTurns: 0,
    }));
  }

  // ── lookups ───────────────────────────────────────────────────────

  seatOf(clientId: string): Seat | null {
    return this.seats.find((s) => s.occupant?.clientId === clientId) ?? null;
  }

  isBotControlled(seat: Seat): boolean {
    return seat.occupant === null || seat.autopilot;
  }

  humanSeats(): Seat[] {
    return this.seats.filter((s) => s.occupant !== null);
  }

  hasFreeSeat(): boolean {
    return this.seats.some((s) => s.occupant === null);
  }

  // ── seating ───────────────────────────────────────────────────────

  join(clientId: string, identity: Identity): JoinResult {
    if (identity.kind === 'user' && this.seats.some((s) => s.occupant?.identity.handle === identity.handle)) {
      return { ok: false, reason: 'duplicate_user' }; // one seat per account: no XP farming against yourself
    }
    const seat = this.seats.find((s) => s.occupant === null);
    if (!seat) return { ok: false, reason: 'full' };
    const taken = this.seats.filter((s) => s !== seat).map((s) => s.name);
    seat.occupant = { clientId, identity };
    seat.name = uniqueName(identity.name, taken);
    seat.connected = true;
    seat.autopilot = false;
    seat.autopilotReason = null;
    seat.timeouts = 0;
    seat.botTurns = 0;
    if (this.hostSeat === -1) this.hostSeat = seat.index;
    // A bot seat becoming human changes who must move (timer instead of bot delay).
    if (this.phase === 'playing' && this.game?.current === seat.index) this.schedule();
    this.hooks.onChange();
    return { ok: true, seat: seat.index };
  }

  /** The person left for good (or the reconnection hold ran out): the seat goes back to a bot. */
  leave(clientId: string): void {
    const seat = this.seatOf(clientId);
    if (!seat) return;
    seat.occupant = null;
    seat.name = botName(seat.index);
    seat.connected = false;
    seat.autopilot = false;
    seat.autopilotReason = null;
    seat.timeouts = 0;
    seat.botTurns = 0;
    if (this.hostSeat === seat.index) {
      this.hostSeat = this.humanSeats()[0]?.index ?? -1;
    }
    if (this.phase === 'playing' && this.game?.current === seat.index) this.schedule();
    this.hooks.onChange();
  }

  /** The connection dropped: a bot holds the seat until `reconnect()` or `leave()`. */
  drop(clientId: string): void {
    const seat = this.seatOf(clientId);
    if (!seat) return;
    seat.connected = false;
    seat.autopilot = true;
    seat.autopilotReason = 'disconnect';
    seat.timeouts = 0;
    if (this.phase === 'playing' && this.game?.current === seat.index) this.schedule();
    this.hooks.onChange();
  }

  reconnect(clientId: string): boolean {
    const seat = this.seatOf(clientId);
    if (!seat) return false;
    seat.connected = true;
    if (seat.autopilotReason === 'disconnect') {
      seat.autopilot = false;
      seat.autopilotReason = null;
    }
    if (this.phase === 'playing' && this.game?.current === seat.index) this.schedule();
    this.hooks.onChange();
    return true;
  }

  /** Take the seat back from the bot after timeouts. */
  resume(clientId: string): ActionResult {
    const seat = this.seatOf(clientId);
    if (!seat) return { ok: false, reason: 'not_seated' };
    if (seat.autopilot && seat.connected) {
      seat.autopilot = false;
      seat.autopilotReason = null;
      seat.timeouts = 0;
      if (this.phase === 'playing' && this.game?.current === seat.index) this.schedule();
      this.hooks.onChange();
    }
    return { ok: true };
  }

  // ── lobby ─────────────────────────────────────────────────────────

  setOptions(clientId: string, patch: OptionsPatch): ActionResult {
    const seat = this.seatOf(clientId);
    if (!seat) return { ok: false, reason: 'not_seated' };
    if (seat.index !== this.hostSeat) return { ok: false, reason: 'not_host' };
    if (this.phase === 'playing') return { ok: false, reason: 'bad_phase' };
    if (patch.stacking !== undefined) this.options.stacking = patch.stacking;
    if (patch.turnSeconds !== undefined) this.options.turnSeconds = patch.turnSeconds;
    this.hooks.onChange();
    return { ok: true };
  }

  /** Host only. Deals from the lobby, or deals again after a finished game. */
  start(clientId: string): ActionResult {
    const seat = this.seatOf(clientId);
    if (!seat) return { ok: false, reason: 'not_seated' };
    if (seat.index !== this.hostSeat) return { ok: false, reason: 'not_host' };
    if (this.phase === 'playing') return { ok: false, reason: 'bad_phase' };
    this.deal();
    return { ok: true };
  }

  private deal(): void {
    this.game = createGame({ seats: this.options.seats, stacking: this.options.stacking, rng: this.rng });
    this.phase = 'playing';
    this.matchId = this.newId();
    this.startedAt = this.now();
    this.moves = [];
    this.lastMoveBot = false;
    for (const seat of this.seats) {
      seat.timeouts = 0;
      seat.botTurns = 0;
      if (seat.occupant !== null) {
        // someone still disconnected from the last game stays on autopilot until they return
        seat.autopilot = !seat.connected;
        seat.autopilotReason = seat.connected ? null : 'disconnect';
      }
    }
    this.schedule();
    this.hooks.onChange();
  }

  // ── moves ─────────────────────────────────────────────────────────

  play(clientId: string, cardId: string, chosenColor?: Color): ActionResult {
    return this.humanMove(clientId, { type: 'play', cardId, ...(chosenColor ? { chosenColor } : {}) });
  }

  draw(clientId: string): ActionResult {
    return this.humanMove(clientId, { type: 'draw' });
  }

  private humanMove(clientId: string, move: Move): ActionResult {
    if (this.phase !== 'playing' || this.game === null) return { ok: false, reason: 'not_playing' };
    const seat = this.seatOf(clientId);
    if (!seat) return { ok: false, reason: 'not_seated' };
    if (seat.autopilot) {
      if (!seat.connected) return { ok: false, reason: 'autopilot' };
      // acting is taking the seat back, with a fresh timeout count
      seat.autopilot = false;
      seat.autopilotReason = null;
      seat.timeouts = 0;
    }
    const result = applyMove(this.game, seat.index, move, this.rng);
    if (!result.ok) {
      this.hooks.onChange(); // seat may have been resumed above
      return { ok: false, reason: result.reason };
    }
    seat.timeouts = 0;
    this.commit(seat.index, result.state, result.events, false);
    return { ok: true };
  }

  private commit(seatIndex: number, state: GameState, events: GameEvent[], bot: boolean): void {
    this.game = state;
    this.lastMoveBot = bot;
    const seat = this.seats[seatIndex] as Seat;
    if (bot && seat.occupant !== null) seat.botTurns++;
    const t = this.now() - this.startedAt;
    for (const e of events) {
      if (e.type === 'play') {
        this.moves.push({
          t, seat: e.seat, type: 'play', card: e.card.id,
          ...(e.chosenColor ? { chosenColor: e.chosenColor } : {}),
          bot,
        });
      } else if (e.type === 'draw') {
        this.moves.push({ t, seat: e.seat, type: 'draw', count: e.count, bot });
      }
    }
    this.hooks.onEvents(events, { seat: seatIndex, bot });
    if (state.winner !== null) {
      this.finish();
    } else {
      this.schedule();
    }
    this.hooks.onChange();
  }

  // ── turn scheduling ───────────────────────────────────────────────

  private clearTimer(): void {
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clearTimer();
    this.turnDeadline = 0;
    if (this.phase !== 'playing' || this.game === null) return;
    const seat = this.seats[this.game.current] as Seat;

    if (this.isBotControlled(seat)) {
      const delay = this.timing.botDelayMs + Math.floor(this.rng() * (this.timing.botJitterMs + 1));
      this.timer = this.scheduler.set(() => this.botMove(), delay);
    } else if (mustDraw(this.game)) {
      // Nothing to choose: draw for them (no timeout is counted).
      this.timer = this.scheduler.set(() => this.forcedDraw(), this.timing.forcedDelayMs);
    } else if (this.options.turnSeconds > 0) {
      const ms = this.options.turnSeconds * 1000;
      this.turnDeadline = this.now() + ms;
      this.timer = this.scheduler.set(() => this.onTimeout(), ms);
    }
  }

  private botMove(): void {
    this.timer = null;
    if (this.phase !== 'playing' || this.game === null) return;
    const seatIndex = this.game.current;
    this.playFor(seatIndex);
  }

  private forcedDraw(): void {
    this.timer = null;
    if (this.phase !== 'playing' || this.game === null) return;
    const seatIndex = this.game.current;
    const result = applyMove(this.game, seatIndex, { type: 'draw' }, this.rng);
    if (result.ok) this.commit(seatIndex, result.state, result.events, false);
  }

  private onTimeout(): void {
    this.timer = null;
    if (this.phase !== 'playing' || this.game === null) return;
    const seatIndex = this.game.current;
    const seat = this.seats[seatIndex] as Seat;
    seat.timeouts++;
    if (seat.timeouts >= TIMEOUTS_BEFORE_AUTOPILOT) {
      seat.autopilot = true;
      seat.autopilotReason = 'timeout';
    }
    this.playFor(seatIndex);
  }

  /** The bot makes the move for `seatIndex`. Falls back to a draw if the bot ever picked an illegal move. */
  private playFor(seatIndex: number): void {
    const game = this.game as GameState;
    let result = applyMove(game, seatIndex, chooseMove(game, seatIndex, this.rng), this.rng);
    if (!result.ok) result = applyMove(game, seatIndex, { type: 'draw' }, this.rng);
    if (result.ok) this.commit(seatIndex, result.state, result.events, true);
  }

  // ── results ───────────────────────────────────────────────────────

  private finish(): void {
    this.clearTimer();
    this.turnDeadline = 0;
    this.phase = 'finished';
    const doc = this.buildDoc('finished');
    this.hooks.onFinished(
      {
        game: doc.game,
        matchId: doc.matchId,
        roomCode: doc.roomCode,
        startedAt: doc.startedAt,
        endedAt: doc.endedAt,
        durationMs: doc.durationMs,
        options: doc.options,
        humanPlayers: doc.humanPlayers,
        players: doc.players,
      },
      doc,
    );
  }

  /** Stop timers; if a game was running, return its log marked "abandoned" (nothing is reported to the dashboard). */
  dispose(): MatchDoc | null {
    this.clearTimer();
    this.turnDeadline = 0;
    if (this.phase !== 'playing' || this.game === null) return null;
    this.phase = 'finished';
    return this.buildDoc('abandoned');
  }

  private buildDoc(status: 'finished' | 'abandoned'): MatchDoc {
    const game = this.game as GameState;
    const table = status === 'finished' ? standings(game) : [];
    const endedAt = this.now();
    const players: PlayerResult[] = this.seats.map((seat) => {
      const row = table.find((r) => r.seat === seat.index);
      const hand = game.hands[seat.index] ?? [];
      const winner = row?.winner ?? false;
      const identity = seat.occupant?.identity ?? null;
      return {
        seat: seat.index,
        kind: identity ? identity.kind : 'bot',
        handle: identity ? identity.handle : null,
        name: seat.name,
        role: identity ? identity.role : null,
        rank: row?.rank ?? null,
        winner,
        cardsLeft: hand.length,
        handPoints: row?.handPoints ?? handPoints(hand),
        score: row?.score ?? 0,
        afk: identity !== null && (seat.autopilot || (winner && this.lastMoveBot)),
        timeouts: identity ? seat.timeouts : 0,
        botTurns: identity ? seat.botTurns : 0,
      };
    });
    return {
      game: 'wildcard',
      matchId: this.matchId,
      roomCode: this.roomCode,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - this.startedAt,
      options: { ...this.options },
      humanPlayers: this.humanSeats().length,
      status,
      players,
      moves: this.moves.slice(0, 2000),
    };
  }
}

export function botName(index: number): string {
  return `Bot ${index + 1}`;
}
