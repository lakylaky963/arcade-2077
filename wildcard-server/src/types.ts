// Shapes shared by the match engine, the results report and the Mongo log.

import type { RoomOptions } from './lib/options.ts';

/** Who sits in a seat. `handle` is the dashboard account handle (lower-case), null for guests. */
export type Identity =
  | { kind: 'user'; handle: string; name: string; role: string | null }
  | { kind: 'guest'; handle: null; name: string; role: null };

export interface PlayerResult {
  seat: number;
  /** user = signed in through the hub SSO, guest = anonymous human, bot = played by the server. */
  kind: 'user' | 'guest' | 'bot';
  handle: string | null;
  name: string;
  role: string | null;
  /** 1 = winner. null on abandoned matches. */
  rank: number | null;
  winner: boolean;
  cardsLeft: number;
  handPoints: number;
  /** Winner: sum of every other hand's points. Others 0. */
  score: number;
  /** True when a bot finished the game on this person's behalf (timeouts / dropped connection). */
  afk: boolean;
  /** Turns the person lost to the timer. */
  timeouts: number;
  /** Moves a bot made for this person's seat. */
  botTurns: number;
}

/** The body POSTed to the dashboard when a game ends. See README "Results contract". */
export interface MatchResult {
  game: 'wildcard';
  matchId: string;
  roomCode: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  options: RoomOptions;
  /** Seats held by a signed-in user or a guest (not bots). */
  humanPlayers: number;
  players: PlayerResult[];
}

export type ReportOutcome =
  | { status: 'sent'; attempts: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; attempts: number; error: string };

export interface LoggedMove {
  /** Milliseconds since the match started. */
  t: number;
  seat: number;
  type: 'play' | 'draw';
  /** Public card id for plays (e.g. `red_5_0`). */
  card?: string;
  chosenColor?: string;
  /** Cards drawn (draws only). */
  count?: number;
  bot: boolean;
}

/** What is stored in Mongo `uno_hub.matches`. */
export interface MatchDoc extends Omit<MatchResult, 'players'> {
  status: 'finished' | 'abandoned';
  players: PlayerResult[];
  moves: LoggedMove[];
  report?: ReportOutcome;
}
