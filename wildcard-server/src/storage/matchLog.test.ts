import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryMatchStore,
  MongoMatchStore,
  createMatchStore,
  safeStore,
  type MongoCollectionLike,
  type MongoDbLike,
} from './matchLog.ts';
import type { MatchDoc, PlayerResult } from '../types.ts';

function player(over: Partial<PlayerResult>): PlayerResult {
  return {
    seat: 0, kind: 'user', handle: 'avraham', name: 'Avraham', role: 'owner', rank: 1, winner: true,
    cardsLeft: 0, handPoints: 0, score: 40, afk: false, timeouts: 0, botTurns: 0, ...over,
  };
}

function doc(over: Partial<MatchDoc> = {}): MatchDoc {
  return {
    game: 'wildcard',
    matchId: 'm1',
    roomCode: 'BCDFG',
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: '2026-11-20T10:03:00.000Z',
    durationMs: 180000,
    options: { seats: 3, stacking: true, turnSeconds: 15 },
    humanPlayers: 2,
    status: 'finished',
    players: [
      player({}),
      player({ seat: 1, kind: 'guest', handle: null, name: 'Sam', role: null, rank: 2, winner: false, cardsLeft: 3, handPoints: 20, score: 0 }),
      player({ seat: 2, kind: 'bot', handle: null, name: 'Bot 3', role: null, rank: 3, winner: false, cardsLeft: 5, handPoints: 20, score: 0 }),
    ],
    moves: [],
    ...over,
  };
}

interface Call {
  col: string;
  op: string;
  args: unknown[];
}

function fakeDb(calls: Call[], failOn?: string): MongoDbLike {
  return {
    collection(col: string): MongoCollectionLike {
      const make = (op: string) => async (...args: unknown[]) => {
        calls.push({ col, op, args });
        if (failOn === op) throw new Error(`${op} exploded`);
        return {};
      };
      return { insertOne: make('insertOne'), updateOne: make('updateOne'), createIndex: make('createIndex') };
    },
  };
}

test('memory store keeps the match and per-user stats, but never for guests or bots', async () => {
  const store = new MemoryMatchStore();
  await store.recordMatch(doc());
  await store.recordMatch(doc({ matchId: 'm2', players: [player({ winner: false, rank: 2, score: 0, afk: true, timeouts: 2 })] }));
  assert.equal(store.matches.length, 2);
  assert.deepEqual([...store.stats.keys()], ['avraham']);
  const s = store.stats.get('avraham')!;
  assert.equal(s.games, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.afkGames, 1);
  assert.equal(s.timeouts, 2);
  assert.equal(s.totalScore, 40);
});

test('abandoned matches are logged but do not touch stats', async () => {
  const store = new MemoryMatchStore();
  await store.recordMatch(doc({ status: 'abandoned' }));
  assert.equal(store.matches.length, 1);
  assert.equal(store.stats.size, 0);
});

test('memory store is capped and can attach a report outcome', async () => {
  const store = new MemoryMatchStore(3);
  for (let i = 0; i < 5; i++) await store.recordMatch(doc({ matchId: `m${i}` }));
  assert.deepEqual(store.matches.map((m) => m.matchId), ['m2', 'm3', 'm4']);
  await store.setReport('m4', { status: 'sent', attempts: 1 });
  assert.deepEqual(store.matches[2]!.report, { status: 'sent', attempts: 1 });
});

test('mongo store: one insert, one upsert per signed-in user, indexes on init', async () => {
  const calls: Call[] = [];
  const store = new MongoMatchStore(fakeDb(calls));
  await store.init();
  assert.ok(calls.every((c) => c.col === 'matches' && c.op === 'createIndex'));
  assert.ok(calls.length >= 2);
  calls.length = 0;

  await store.recordMatch(doc());
  assert.equal(calls.filter((c) => c.col === 'matches' && c.op === 'insertOne').length, 1);
  const upserts = calls.filter((c) => c.col === 'player_stats');
  assert.equal(upserts.length, 1, 'guest and bot get no stats');
  const [filter, update, options] = upserts[0]!.args as [Record<string, unknown>, Record<string, Record<string, unknown>>, Record<string, unknown>];
  assert.deepEqual(filter, { _id: 'avraham' });
  assert.deepEqual(update.$inc, { games: 1, wins: 1, afkGames: 0, timeouts: 0, totalScore: 40 });
  assert.equal(update.$set!.lastPlayedAt, '2026-11-20T10:03:00.000Z');
  assert.deepEqual(options, { upsert: true });

  calls.length = 0;
  await store.setReport('m1', { status: 'failed', attempts: 3, error: 'HTTP 500' });
  assert.deepEqual(calls[0]!.args[0], { matchId: 'm1' });
});

test('mongo store: abandoned matches write the log only', async () => {
  const calls: Call[] = [];
  await new MongoMatchStore(fakeDb(calls)).recordMatch(doc({ status: 'abandoned' }));
  assert.deepEqual(calls.map((c) => `${c.col}.${c.op}`), ['matches.insertOne']);
});

test('safeStore swallows errors and logs them', async () => {
  const logs: string[] = [];
  const store = safeStore(new MongoMatchStore(fakeDb([], 'insertOne')), (m) => logs.push(m));
  await store.recordMatch(doc());
  await store.setReport('m1', { status: 'sent', attempts: 1 });
  assert.ok(logs.some((l) => l.includes('recordMatch m1 failed: insertOne exploded')));
});

test('without MONGO_URL (or when Mongo cannot be loaded) the server falls back to memory', async () => {
  const logs: string[] = [];
  const none = await createMatchStore({}, (m) => logs.push(m));
  assert.ok(none instanceof MemoryMatchStore);
  const broken = await createMatchStore({ MONGO_URL: 'mongodb://127.0.0.1:1/x' }, (m) => logs.push(m));
  assert.ok(broken instanceof MemoryMatchStore); // driver missing here, or connection refused
  assert.ok(logs.some((l) => l.includes('memory only')));
});
