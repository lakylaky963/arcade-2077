// Match logs and per-player stats in MongoDB `uno_hub` (CT 106, no auth).
//
//   uno_hub.matches       one document per match (finished or abandoned), with a public move log
//   uno_hub.player_stats  one document per signed-in user (_id = dashboard handle)
//
// The server must keep running when Mongo is down, so every call is wrapped by
// safeStore(): errors are logged and swallowed.

import type { MatchDoc, ReportOutcome } from '../types.ts';

export interface MatchStore {
  recordMatch(doc: MatchDoc): Promise<void>;
  /** Attach the outcome of the dashboard report to an already stored match. */
  setReport(matchId: string, outcome: ReportOutcome): Promise<void>;
  close(): Promise<void>;
}

// ── memory (tests, and fallback when Mongo is unreachable at boot) ──

export class MemoryMatchStore implements MatchStore {
  readonly matches: MatchDoc[] = [];
  readonly stats = new Map<string, PlayerStats>();
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  async recordMatch(doc: MatchDoc): Promise<void> {
    this.matches.push(structuredClone(doc));
    if (this.matches.length > this.limit) this.matches.shift();
    if (doc.status !== 'finished') return;
    for (const p of doc.players) {
      if (p.kind !== 'user' || p.handle === null) continue;
      const prev = this.stats.get(p.handle) ?? emptyStats(p.handle, doc.endedAt);
      this.stats.set(p.handle, {
        ...prev,
        name: p.name,
        lastRole: p.role,
        games: prev.games + 1,
        wins: prev.wins + (p.winner ? 1 : 0),
        afkGames: prev.afkGames + (p.afk ? 1 : 0),
        timeouts: prev.timeouts + p.timeouts,
        totalScore: prev.totalScore + p.score,
        lastPlayedAt: doc.endedAt,
      });
    }
  }

  async setReport(matchId: string, outcome: ReportOutcome): Promise<void> {
    const doc = this.matches.find((m) => m.matchId === matchId);
    if (doc) doc.report = outcome;
  }

  async close(): Promise<void> {}
}

export interface PlayerStats {
  handle: string;
  name: string;
  lastRole: string | null;
  games: number;
  wins: number;
  afkGames: number;
  timeouts: number;
  totalScore: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
}

function emptyStats(handle: string, at: string): PlayerStats {
  return {
    handle,
    name: handle,
    lastRole: null,
    games: 0,
    wins: 0,
    afkGames: 0,
    timeouts: 0,
    totalScore: 0,
    firstPlayedAt: at,
    lastPlayedAt: at,
  };
}

// ── mongo ───────────────────────────────────────────────────────────

/** The few driver methods we use, so the store can be tested without a database. */
export interface MongoCollectionLike {
  insertOne(doc: object): Promise<unknown>;
  updateOne(filter: object, update: object, options?: object): Promise<unknown>;
  createIndex(spec: object, options?: object): Promise<unknown>;
}
export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
}

export class MongoMatchStore implements MatchStore {
  private readonly db: MongoDbLike;
  private readonly closer: () => Promise<void>;

  constructor(db: MongoDbLike, closer: () => Promise<void> = async () => {}) {
    this.db = db;
    this.closer = closer;
  }

  async init(): Promise<void> {
    await this.db.collection('matches').createIndex({ matchId: 1 }, { unique: true });
    await this.db.collection('matches').createIndex({ endedAt: -1 });
    await this.db.collection('matches').createIndex({ 'players.handle': 1, endedAt: -1 });
  }

  async recordMatch(doc: MatchDoc): Promise<void> {
    await this.db.collection('matches').insertOne({ ...doc });
    if (doc.status !== 'finished') return;
    const statsCol = this.db.collection('player_stats');
    for (const p of doc.players) {
      if (p.kind !== 'user' || p.handle === null) continue;
      await statsCol.updateOne(
        { _id: p.handle },
        {
          $inc: {
            games: 1,
            wins: p.winner ? 1 : 0,
            afkGames: p.afk ? 1 : 0,
            timeouts: p.timeouts,
            totalScore: p.score,
          },
          $set: { name: p.name, lastRole: p.role, lastPlayedAt: doc.endedAt },
          $setOnInsert: { firstPlayedAt: doc.endedAt },
        },
        { upsert: true },
      );
    }
  }

  async setReport(matchId: string, outcome: ReportOutcome): Promise<void> {
    await this.db.collection('matches').updateOne({ matchId }, { $set: { report: outcome } });
  }

  close(): Promise<void> {
    return this.closer();
  }
}

/** Never throws: logs and carries on so a Mongo hiccup cannot break a game. */
export function safeStore(inner: MatchStore, log: (message: string) => void): MatchStore {
  const guard = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      log(`[matchLog] ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    recordMatch: (doc) => guard(`recordMatch ${doc.matchId}`, () => inner.recordMatch(doc)),
    setReport: (matchId, outcome) => guard(`setReport ${matchId}`, () => inner.setReport(matchId, outcome)),
    close: () => guard('close', () => inner.close()),
  };
}

export const DEFAULT_DB_NAME = 'uno_hub';

interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): MongoDbLike;
  close(): Promise<void>;
}

/**
 * MONGO_URL set -> MongoDB (db MONGO_DB, default `uno_hub`). If it cannot be reached at boot, or
 * MONGO_URL is unset, matches are kept in memory only (last 200) and a warning is logged.
 */
export async function createMatchStore(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
): Promise<MatchStore> {
  const url = env.MONGO_URL;
  if (!url) {
    log('[matchLog] MONGO_URL not set: match logs kept in memory only');
    return new MemoryMatchStore();
  }
  try {
    const moduleName = 'mongodb'; // dynamic so the pure modules and tests never need the driver
    const mod = (await import(moduleName)) as {
      MongoClient: new (url: string, options?: object) => MongoClientLike;
    };
    const client = new mod.MongoClient(url, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const store = new MongoMatchStore(client.db(env.MONGO_DB || DEFAULT_DB_NAME), () => client.close());
    await store.init();
    log(`[matchLog] connected to MongoDB, db ${env.MONGO_DB || DEFAULT_DB_NAME}`);
    return safeStore(store, log);
  } catch (e) {
    log(`[matchLog] MongoDB unavailable (${e instanceof Error ? e.message : String(e)}): keeping matches in memory only`);
    return new MemoryMatchStore();
  }
}
