// Test helpers shared by the rules tests (not imported by the server).

import type { Card, Color, ColorValue, GameState, Rng } from './uno.ts';

export function c(color: Color, value: ColorValue, copy = 0): Card {
  return { id: `${color}_${value}_${copy}`, kind: 'color', color, value };
}

export function wild(copy = 0): Card {
  return { id: `wild_${copy}`, kind: 'wild', value: 'wild' };
}

export function wild4(copy = 0): Card {
  return { id: `wild_draw4_${copy}`, kind: 'wild', value: 'wild_draw4' };
}

/** Deterministic rng (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StateInit {
  hands: Card[][];
  top?: Card;
  activeColor?: Color;
  drawPile?: Card[];
  current?: number;
  direction?: 1 | -1;
  pending?: number;
  pendingKind?: GameState['pendingKind'];
  stacking?: boolean;
  discardBelow?: Card[];
}

/** Build a hand-picked state. Default top card is red 5, draw pile is 10 filler cards. */
export function mk(init: StateInit): GameState {
  const top = init.top ?? c('red', '5', 9);
  const filler: Card[] = Array.from({ length: 10 }, (_, i) => c('blue', '1', 100 + i));
  return {
    seats: init.hands.length,
    stacking: init.stacking ?? false,
    hands: init.hands,
    drawPile: init.drawPile ?? filler,
    discard: [...(init.discardBelow ?? []), top],
    activeColor: init.activeColor ?? (top.kind === 'color' ? top.color : 'red'),
    current: init.current ?? 0,
    direction: init.direction ?? 1,
    pending: init.pending ?? 0,
    pendingKind: init.pendingKind ?? null,
    winner: null,
  };
}

/** Total distinct card ids anywhere in the state (must stay 108 in real games). */
export function countCards(state: GameState): number {
  const ids = new Set<string>();
  for (const hand of state.hands) for (const card of hand) ids.add(card.id);
  for (const card of state.drawPile) ids.add(card.id);
  for (const card of state.discard) ids.add(card.id);
  return ids.size;
}

export function totalCards(state: GameState): number {
  return (
    state.hands.reduce((n, h) => n + h.length, 0) + state.drawPile.length + state.discard.length
  );
}
