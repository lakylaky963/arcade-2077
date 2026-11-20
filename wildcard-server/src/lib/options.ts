// Room options: what the host can choose. Anything unexpected falls back to the default.

export type TurnSeconds = 0 | 15 | 30;

export interface RoomOptions {
  /** 2-4 seats; seats nobody sits in are played by bots. Fixed when the room is created. */
  seats: number;
  /** +2 stacks on +2 and +4 on +4 (off by default). */
  stacking: boolean;
  /** Seconds a human has to move; 0 = no timer. */
  turnSeconds: TurnSeconds;
}

export const DEFAULT_OPTIONS: RoomOptions = { seats: 4, stacking: false, turnSeconds: 30 };

export const TURN_SECONDS_CHOICES: readonly TurnSeconds[] = [0, 15, 30];

function asSeats(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= 4) return n;
  return DEFAULT_OPTIONS.seats;
}

function asTurnSeconds(value: unknown, fallback: TurnSeconds): TurnSeconds {
  const n = typeof value === 'string' ? Number(value) : value;
  return TURN_SECONDS_CHOICES.find((choice) => choice === n) ?? fallback;
}

/** Options sent by the client when it creates a room. */
export function parseCreateOptions(raw: unknown): RoomOptions {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    seats: asSeats(o.seats),
    stacking: o.stacking === true,
    turnSeconds: asTurnSeconds(o.turnSeconds, DEFAULT_OPTIONS.turnSeconds),
  };
}

export type OptionsPatch = Partial<Pick<RoomOptions, 'stacking' | 'turnSeconds'>>;

/** A host's `set_options` message. Seats cannot change after creation. Unknown or invalid fields are dropped. */
export function parseOptionsPatch(raw: unknown): OptionsPatch {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const patch: OptionsPatch = {};
  if (typeof o.stacking === 'boolean') patch.stacking = o.stacking;
  if ('turnSeconds' in o) {
    const n = typeof o.turnSeconds === 'string' ? Number(o.turnSeconds) : o.turnSeconds;
    const match = TURN_SECONDS_CHOICES.find((choice) => choice === n);
    if (match !== undefined) patch.turnSeconds = match;
  }
  return patch;
}
