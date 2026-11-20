import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResultsReporter, NoopReporter, reporterFromEnv } from './dashboard.ts';
import type { FetchInit, FetchLike } from '../auth/session.ts';
import type { MatchResult } from '../types.ts';

const RESULT: MatchResult = {
  game: 'wildcard',
  matchId: 'm-1',
  roomCode: 'BCDFG',
  startedAt: '2026-11-20T10:00:00.000Z',
  endedAt: '2026-11-20T10:05:00.000Z',
  durationMs: 300000,
  options: { seats: 4, stacking: false, turnSeconds: 30 },
  humanPlayers: 1,
  players: [
    { seat: 0, kind: 'user', handle: 'avraham', name: 'Avraham', role: 'owner', rank: 1, winner: true, cardsLeft: 0, handPoints: 0, score: 60, afk: false, timeouts: 0, botTurns: 0 },
  ],
};

interface Call {
  url: string;
  init?: FetchInit;
}

function scripted(statuses: Array<number | Error>, calls: Call[]): FetchLike {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const next = statuses[Math.min(i++, statuses.length - 1)]!;
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next, json: async () => ({}) };
  };
}

const noSleep = async () => {};

test('posts the match with the service token and an idempotency key', async () => {
  const calls: Call[] = [];
  const reporter = new HttpResultsReporter({
    url: 'http://10.0.0.223:3000/api/game/server-result',
    token: 'secret-token',
    fetchImpl: scripted([200], calls),
    sleep: noSleep,
  });
  assert.deepEqual(await reporter.report(RESULT), { status: 'sent', attempts: 1 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, 'http://10.0.0.223:3000/api/game/server-result');
  assert.equal(init!.method, 'POST');
  assert.equal(init!.headers!.authorization, 'Bearer secret-token');
  assert.equal(init!.headers!['idempotency-key'], 'm-1');
  assert.equal(init!.headers!['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init!.body!), RESULT);
});

test('retries 5xx, 429 and network errors, then succeeds', async () => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const reporter = new HttpResultsReporter({
    url: 'http://x/y',
    token: 't',
    fetchImpl: scripted([503, new Error('ECONNRESET'), 200], calls),
    retryDelaysMs: [10, 20],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(await reporter.report(RESULT), { status: 'sent', attempts: 3 });
  assert.deepEqual(sleeps, [10, 20]);
  const again = new HttpResultsReporter({ url: 'http://x/y', token: 't', fetchImpl: scripted([429, 200], []), sleep: noSleep });
  assert.deepEqual(await again.report(RESULT), { status: 'sent', attempts: 2 });
});

test('gives up after the allowed attempts and reports why', async () => {
  const calls: Call[] = [];
  const reporter = new HttpResultsReporter({
    url: 'http://x/y',
    token: 't',
    fetchImpl: scripted([500], calls),
    retryDelaysMs: [1, 1],
    sleep: noSleep,
  });
  assert.deepEqual(await reporter.report(RESULT), { status: 'failed', attempts: 3, error: 'HTTP 500' });
  assert.equal(calls.length, 3);
});

test('client errors are final: no retry on 400/401/403/404', async () => {
  for (const status of [400, 401, 403, 404]) {
    const calls: Call[] = [];
    const reporter = new HttpResultsReporter({ url: 'http://x/y', token: 't', fetchImpl: scripted([status], calls), sleep: noSleep });
    assert.deepEqual(await reporter.report(RESULT), { status: 'failed', attempts: 1, error: `HTTP ${status}` });
    assert.equal(calls.length, 1);
  }
});

test('a hanging dashboard times out instead of blocking forever', async () => {
  const reporter = new HttpResultsReporter({
    url: 'http://x/y',
    token: 't',
    fetchImpl: () => new Promise(() => {}),
    retryDelaysMs: [],
    timeoutMs: 30,
    sleep: noSleep,
  });
  assert.deepEqual(await reporter.report(RESULT), { status: 'failed', attempts: 1, error: 'timeout' });
});

test('the token never appears in a failure outcome', async () => {
  const reporter = new HttpResultsReporter({
    url: 'http://x/y',
    token: 'super-secret',
    fetchImpl: scripted([new Error('connect failed')], []),
    retryDelaysMs: [],
    sleep: noSleep,
  });
  const outcome = await reporter.report(RESULT);
  assert.ok(!JSON.stringify(outcome).includes('super-secret'));
});

test('without URL and token the reporter only skips (step C has not built the endpoint yet)', async () => {
  assert.ok(reporterFromEnv({}) instanceof NoopReporter);
  assert.ok(reporterFromEnv({ DASHBOARD_RESULTS_URL: 'http://x' }) instanceof NoopReporter);
  assert.ok(reporterFromEnv({ DASHBOARD_SERVICE_TOKEN: 't' }) instanceof NoopReporter);
  assert.ok(reporterFromEnv({ DASHBOARD_RESULTS_URL: 'http://x', DASHBOARD_SERVICE_TOKEN: 't' }) instanceof HttpResultsReporter);
  const outcome = await new NoopReporter().report();
  assert.equal(outcome.status, 'skipped');
});
