// WILDCARD // 2077 rules: pure, dependency-free, no I/O and no clock.
//
// Adapted from colyseus/turnbased-cards-demo (server/shared/uno.ts), MIT,
// Copyright (c) 2026 Endel Dreyer. See ../../LICENSE-turnbased-cards-demo.
// Changes: state is immutable and holds 2-4 seats, rng is injected, the +2/+4
// stacking toggle, reverse-as-skip with 2 seats, scoring/standings, and a
// Result type instead of silently ignoring illegal moves.

export const COLORS = ['red', 'yellow', 'green', 'blue'] as const;
export type Color = (typeof COLORS)[number];

export const COLOR_VALUES = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2',
] as const;
export type ColorValue = (typeof COLOR_VALUES)[number];

export type WildValue = 'wild' | 'wild_draw4';

export interface ColorCard {
  id: string;
  kind: 'color';
  color: Color;
  value: ColorValue;
}

export interface WildCard {
  id: string;
  kind: 'wild';
  value: WildValue;
}

export type Card = ColorCard | WildCard;

/** Random source in [0, 1). Inject a seeded one in tests. */
export type Rng = () => number;

export const HAND_SIZE = 7;
export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

/** What a pending draw penalty was created by (only that kind may be stacked). */
export type PendingKind = 'draw2' | 'wild_draw4';

export interface GameState {
  seats: number;
  stacking: boolean;
  hands: Card[][];
  /** Top of the pile is the END of the array. */
  drawPile: Card[];
  /** Top of the pile is the END of the array. */
  discard: Card[];
  activeColor: Color;
  current: number;
  direction: 1 | -1;
  /** Cards `current` still owes the pile. 0 = none. */
  pending: number;
  pendingKind: PendingKind | null;
  winner: number | null;
}

export type Move =
  | { type: 'play'; cardId: string; chosenColor?: Color }
  | { type: 'draw' };

export type GameEvent =
  | { type: 'play'; seat: number; card: Card; chosenColor: Color | null }
  | { type: 'draw'; seat: number; count: number; forced: boolean }
  | { type: 'skip'; seat: number }
  | { type: 'reverse'; direction: 1 | -1 }
  | { type: 'win'; seat: number };

export type RejectReason =
  | 'game_over'
  | 'not_your_turn'
  | 'unknown_card'
  | 'not_playable'
  | 'must_draw'
  | 'color_required';

export type MoveResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; reason: RejectReason };

// ── Deck ────────────────────────────────────────────────────────────

/** The standard 108-card deck. Card ids are stable per card type + copy. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    for (const value of COLOR_VALUES) {
      const copies = value === '0' ? 1 : 2;
      for (let copy = 0; copy < copies; copy++) {
        deck.push({ id: `${color}_${value}_${copy}`, kind: 'color', color, value });
      }
    }
  }
  for (let copy = 0; copy < 4; copy++) {
    deck.push({ id: `wild_${copy}`, kind: 'wild', value: 'wild' });
    deck.push({ id: `wild_draw4_${copy}`, kind: 'wild', value: 'wild_draw4' });
  }
  return deck;
}

/** Fisher-Yates; returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

export function cardPoints(card: Card): number {
  if (card.kind === 'wild') return 50;
  if (card.value === 'skip' || card.value === 'reverse' || card.value === 'draw2') return 20;
  return Number(card.value);
}

export function handPoints(hand: readonly Card[]): number {
  let total = 0;
  for (const card of hand) total += cardPoints(card);
  return total;
}

// ── Setup ───────────────────────────────────────────────────────────

export interface NewGameOptions {
  seats: number;
  stacking?: boolean;
  rng?: Rng;
}

/**
 * Shuffle, deal 7 cards per seat (one card at a time, round robin) and turn
 * up the first non-wild card. First-card effects, as in the demo:
 * skip   -> seat 0 is skipped, seat 1 starts;
 * reverse-> direction flips and the last seat starts (with 2 seats that is
 *           seat 1, i.e. reverse acts as skip);
 * draw2  -> seat 0 owes 2 cards (it may stack when stacking is on).
 */
export function createGame(options: NewGameOptions): GameState {
  const { seats } = options;
  if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) {
    throw new RangeError(`seats must be an integer from ${MIN_SEATS} to ${MAX_SEATS}`);
  }
  const rng = options.rng ?? Math.random;
  const deck = shuffle(createDeck(), rng);

  const hands: Card[][] = Array.from({ length: seats }, () => []);
  let idx = 0;
  for (let round = 0; round < HAND_SIZE; round++) {
    for (let seat = 0; seat < seats; seat++) {
      (hands[seat] as Card[]).push(deck[idx++] as Card);
    }
  }

  // First non-wild card starts the discard pile; skipped wilds stay in the pile.
  let startIdx = idx;
  while (startIdx < deck.length && (deck[startIdx] as Card).kind === 'wild') startIdx++;
  const first = deck[startIdx] as Card; // a 108-card deck always has a colour card left
  const drawPile = [...deck.slice(idx, startIdx), ...deck.slice(startIdx + 1)];

  let current = 0;
  let direction: 1 | -1 = 1;
  let pending = 0;
  let pendingKind: PendingKind | null = null;
  if (first.kind === 'color') {
    if (first.value === 'skip') current = 1;
    else if (first.value === 'reverse') {
      direction = -1;
      current = seats - 1;
    } else if (first.value === 'draw2') {
      pending = 2;
      pendingKind = 'draw2';
    }
  }

  return {
    seats,
    stacking: options.stacking === true,
    hands,
    drawPile,
    discard: [first],
    activeColor: first.kind === 'color' ? first.color : 'red',
    current,
    direction,
    pending,
    pendingKind,
    winner: null,
  };
}

// ── Queries ─────────────────────────────────────────────────────────

export function topCard(state: GameState): Card {
  return state.discard[state.discard.length - 1] as Card;
}

/** The seat that follows `from` after `steps` moves in the current direction. */
export function seatAfter(state: GameState, from: number, steps = 1): number {
  const n = state.seats;
  return (((from + state.direction * steps) % n) + n) % n;
}

/** Can `card` be played right now by the seat on turn? */
export function canPlayCard(state: GameState, card: Card): boolean {
  if (state.winner !== null) return false;
  if (state.pending > 0) {
    // A penalty is owed: only a stacking response is legal, same kind only.
    return state.stacking && state.pendingKind !== null && card.value === state.pendingKind;
  }
  if (card.kind === 'wild') return true;
  if (card.color === state.activeColor) return true;
  const top = topCard(state);
  return top.kind === 'color' && card.value === top.value;
}

export function playableCards(state: GameState, seat: number): Card[] {
  if (state.winner !== null || seat !== state.current) return [];
  return (state.hands[seat] as Card[]).filter((card) => canPlayCard(state, card));
}

/** True when the seat on turn has no legal play and can only draw. */
export function mustDraw(state: GameState): boolean {
  if (state.winner !== null) return false;
  return playableCards(state, state.current).length === 0;
}

// ── Moves ───────────────────────────────────────────────────────────

function cloneState(state: GameState): GameState {
  return {
    ...state,
    hands: state.hands.map((hand) => hand.slice()),
    drawPile: state.drawPile.slice(),
    discard: state.discard.slice(),
  };
}

/** Draw `count` cards into `seat`, recycling the discard pile (keep top) when the draw pile runs out. */
function drawInto(state: GameState, seat: number, count: number, rng: Rng): number {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0 && state.discard.length > 1) {
      const top = state.discard[state.discard.length - 1] as Card;
      state.drawPile = shuffle(state.discard.slice(0, -1), rng);
      state.discard = [top];
    }
    const card = state.drawPile.pop();
    if (card === undefined) break; // every card is in a hand: nothing left to draw
    (state.hands[seat] as Card[]).push(card);
    drawn++;
  }
  return drawn;
}

/**
 * Apply one move for `seat`. Never mutates `state`. Illegal moves come back as
 * `{ ok: false, reason }` and change nothing.
 *
 * Draw ends the turn (as in the demo: the drawn card cannot be played the same
 * turn). When a penalty is pending, draw takes the whole penalty.
 */
export function applyMove(
  state: GameState,
  seat: number,
  move: Move,
  rng: Rng = Math.random,
): MoveResult {
  if (state.winner !== null) return { ok: false, reason: 'game_over' };
  if (seat !== state.current) return { ok: false, reason: 'not_your_turn' };

  const next = cloneState(state);
  const events: GameEvent[] = [];

  if (move.type === 'draw') {
    const forced = next.pending > 0;
    const count = forced ? next.pending : 1;
    const drawn = drawInto(next, seat, count, rng);
    next.pending = 0;
    next.pendingKind = null;
    next.current = seatAfter(next, seat);
    events.push({ type: 'draw', seat, count: drawn, forced });
    return { ok: true, state: next, events };
  }

  const hand = next.hands[seat] as Card[];
  const handIdx = hand.findIndex((card) => card.id === move.cardId);
  if (handIdx === -1) return { ok: false, reason: 'unknown_card' };
  const card = hand[handIdx] as Card;

  if (!canPlayCard(state, card)) {
    return { ok: false, reason: state.pending > 0 ? 'must_draw' : 'not_playable' };
  }
  let chosenColor: Color | null = null;
  if (card.kind === 'wild') {
    if (move.chosenColor === undefined || !COLORS.includes(move.chosenColor)) {
      return { ok: false, reason: 'color_required' };
    }
    chosenColor = move.chosenColor;
  }

  hand.splice(handIdx, 1);
  next.discard.push(card);
  next.activeColor = card.kind === 'wild' ? (chosenColor as Color) : card.color;
  events.push({ type: 'play', seat, card, chosenColor });

  if (hand.length === 0) {
    next.winner = seat;
    events.push({ type: 'win', seat });
    return { ok: true, state: next, events };
  }

  if (card.kind === 'wild') {
    if (card.value === 'wild_draw4') {
      next.pending += 4;
      next.pendingKind = 'wild_draw4';
    }
    next.current = seatAfter(next, seat);
  } else {
    switch (card.value) {
      case 'reverse':
        next.direction = next.direction === 1 ? -1 : 1;
        events.push({ type: 'reverse', direction: next.direction });
        if (next.seats === 2) {
          // With 2 seats reverse acts as skip: the player goes again.
          next.current = seat;
          events.push({ type: 'skip', seat: seatAfter(next, seat) });
        } else {
          next.current = seatAfter(next, seat);
        }
        break;
      case 'skip': {
        const skipped = seatAfter(next, seat);
        events.push({ type: 'skip', seat: skipped });
        next.current = seatAfter(next, seat, 2);
        break;
      }
      case 'draw2':
        next.pending += 2;
        next.pendingKind = 'draw2';
        next.current = seatAfter(next, seat);
        break;
      default:
        next.current = seatAfter(next, seat);
    }
  }

  return { ok: true, state: next, events };
}

// ── Standings ───────────────────────────────────────────────────────

export interface Standing {
  seat: number;
  rank: number;
  winner: boolean;
  cardsLeft: number;
  handPoints: number;
  /** Winner: sum of every other hand's points (classic Uno round score). Others: 0. */
  score: number;
}

/**
 * Standings for a finished game. Winner is rank 1; the rest are ordered by the
 * points left in hand (fewer is better) then by cards left. Equal hands share
 * a rank (1, 2, 2, 4 style). Returns [] while the game is still running.
 */
export function standings(state: GameState): Standing[] {
  if (state.winner === null) return [];
  const rows = state.hands.map((hand, seat) => ({
    seat,
    cardsLeft: hand.length,
    handPoints: handPoints(hand),
  }));
  const winnerSeat = state.winner;
  const roundScore = rows.reduce((sum, r) => (r.seat === winnerSeat ? sum : sum + r.handPoints), 0);

  const losers = rows
    .filter((r) => r.seat !== winnerSeat)
    .sort((a, b) => a.handPoints - b.handPoints || a.cardsLeft - b.cardsLeft || a.seat - b.seat);

  const out: Standing[] = [];
  const win = rows[winnerSeat] as (typeof rows)[number];
  out.push({ ...win, rank: 1, winner: true, score: roundScore });
  let prev: (typeof rows)[number] | null = null;
  let prevRank = 1;
  losers.forEach((row, i) => {
    const rank =
      prev !== null && prev.handPoints === row.handPoints && prev.cardsLeft === row.cardsLeft
        ? prevRank
        : i + 2;
    out.push({ ...row, rank, winner: false, score: 0 });
    prev = row;
    prevRank = rank;
  });
  return out.sort((a, b) => a.seat - b.seat);
}
