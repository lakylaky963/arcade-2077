// Fake clock + hook recorder for Match tests (not imported by the server).

import type { GameEvent } from '../rules/uno.ts';
import type { MatchDoc, MatchResult } from '../types.ts';
import { Match, type MatchConfig, type MatchHooks, type Scheduler } from './Match.ts';
import { DEFAULT_OPTIONS, type RoomOptions } from '../lib/options.ts';
import { seeded } from '../rules/testkit.ts';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Scheduler {
  now = 1_700_000_000_000;
  private nextId = 1;
  private timers: Timer[] = [];

  set(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.now + ms, fn };
    this.timers.push(timer);
    return timer.id;
  }

  clear(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward, firing timers in order (timers set while advancing fire too if due). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.now = next.at;
      next.fn();
    }
    this.now = target;
  }
}

export interface Harness {
  match: Match;
  clock: FakeClock;
  changes: number;
  events: Array<{ events: GameEvent[]; seat: number; bot: boolean }>;
  finished: Array<{ result: MatchResult; doc: MatchDoc }>;
}

export function harness(options: Partial<RoomOptions> = {}, extra: Partial<MatchConfig> = {}): Harness {
  const clock = new FakeClock();
  const h: Harness = { match: null as unknown as Match, clock, changes: 0, events: [], finished: [] };
  const hooks: MatchHooks = {
    onChange: () => {
      h.changes++;
    },
    onEvents: (events, meta) => {
      h.events.push({ events, ...meta });
    },
    onFinished: (result, doc) => {
      h.finished.push({ result, doc });
    },
  };
  let id = 0;
  h.match = new Match({
    options: { ...DEFAULT_OPTIONS, ...options },
    roomCode: 'BCDFG',
    hooks,
    scheduler: clock,
    rng: seeded(42),
    now: () => clock.now,
    newId: () => `match-${++id}`,
    ...extra,
  });
  return h;
}
