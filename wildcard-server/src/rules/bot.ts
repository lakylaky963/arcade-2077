// WILDCARD // 2077 bot strategy. Pure: reads a GameState, returns a Move.
//
// Replaces the demo's "random playable card" bot. Heuristics:
//  - dump high cards first (50 for wilds is the exception: wilds are kept),
//  - keep wilds for when nothing else is playable (plain wild before +4),
//  - when the next seat is about to go out (<= 2 cards), disrupt it:
//    skip / +2 first, +4 even ahead of ordinary cards,
//  - when a stacked penalty is pending and stacking is on, always pass it on,
//  - a wild picks the colour the bot holds most of (ties: more points in that
//    colour, then random).

import {
  COLORS,
  canPlayCard,
  cardPoints,
  seatAfter,
  type Card,
  type Color,
  type GameState,
  type Move,
  type Rng,
} from './uno.ts';

const WILD_PENALTY = 1000;
const WILD_DRAW4_EXTRA_PENALTY = 100;
const THREAT_HAND_SIZE = 2;
const THREAT_ACTION_BONUS = 100;
const THREAT_DRAW4_BONUS = 1150;

function cardScore(card: Card, threat: boolean): number {
  let score: number;
  if (card.kind === 'wild') {
    score = -WILD_PENALTY - (card.value === 'wild_draw4' ? WILD_DRAW4_EXTRA_PENALTY : 0);
    if (threat && card.value === 'wild_draw4') score += THREAT_DRAW4_BONUS;
  } else {
    score = cardPoints(card);
    if (threat && (card.value === 'skip' || card.value === 'draw2')) score += THREAT_ACTION_BONUS;
  }
  return score;
}

/** Colour the seat holds most of, ignoring `exclude` (the wild being played). */
export function pickColor(hand: readonly Card[], exclude: Card | null, rng: Rng = Math.random): Color {
  const count: Record<Color, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  const points: Record<Color, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const card of hand) {
    if (card === exclude || card.kind !== 'color') continue;
    count[card.color]++;
    points[card.color] += cardPoints(card);
  }
  let best: Color[] = [];
  let bestCount = 0;
  let bestPoints = -1;
  for (const color of COLORS) {
    const c = count[color];
    const p = points[color];
    if (c === 0) continue;
    if (c > bestCount || (c === bestCount && p > bestPoints)) {
      best = [color];
      bestCount = c;
      bestPoints = p;
    } else if (c === bestCount && p === bestPoints) {
      best.push(color);
    }
  }
  if (best.length === 0) best = [...COLORS]; // only wilds left: any colour
  return best[Math.floor(rng() * best.length)] as Color;
}

/** Choose the bot's move for `seat` (which must be the seat on turn). */
export function chooseMove(state: GameState, seat: number, rng: Rng = Math.random): Move {
  const hand = state.hands[seat] ?? [];
  const playable = hand.filter((card) => canPlayCard(state, card));
  if (playable.length === 0) return { type: 'draw' };

  const nextHand = state.hands[seatAfter(state, seat)] ?? [];
  // With a pending stack the next seat is the one that would take it on.
  const threat = state.seats > 1 && nextHand.length <= THREAT_HAND_SIZE;

  let best: Card[] = [];
  let bestScore = -Infinity;
  for (const card of playable) {
    const score = cardScore(card, threat);
    if (score > bestScore) {
      best = [card];
      bestScore = score;
    } else if (score === bestScore) {
      best.push(card);
    }
  }
  const card = best[Math.floor(rng() * best.length)] as Card;
  if (card.kind === 'wild') {
    return { type: 'play', cardId: card.id, chosenColor: pickColor(hand, card, rng) };
  }
  return { type: 'play', cardId: card.id };
}
