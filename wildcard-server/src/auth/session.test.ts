import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE,
  lookupSession,
  meUrlFromEnv,
  parseCookie,
  toIdentity,
  type FetchInit,
  type FetchLike,
} from './session.ts';

const ME = 'http://10.0.0.223:3000/api/game/me';

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init?: FetchInit }> = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('parseCookie finds one cookie among many', () => {
  assert.equal(parseCookie('a=1; homelab_session=abc.def; b=2', SESSION_COOKIE), 'abc.def');
  assert.equal(parseCookie('homelab_session=x=y==', SESSION_COOKIE), 'x=y==');
  assert.equal(parseCookie('xhomelab_session=nope', SESSION_COOKIE), null);
  assert.equal(parseCookie('homelab_session=', SESSION_COOKIE), null);
  assert.equal(parseCookie('', SESSION_COOKIE), null);
  assert.equal(parseCookie(null, SESSION_COOKIE), null);
  assert.equal(parseCookie(undefined, SESSION_COOKIE), null);
});

test('the dashboard URL defaults to CT 105 and can be overridden', () => {
  assert.equal(meUrlFromEnv({}), ME);
  assert.equal(meUrlFromEnv({ DASHBOARD_BASE_URL: 'http://dash.local:3001/' }), 'http://dash.local:3001/api/game/me');
});

test('no cookie: guest, and the dashboard is not called', async () => {
  const calls: Array<{ url: string }> = [];
  const r = await lookupSession('a=1', { meUrl: ME, fetchImpl: fakeFetch(200, {}, calls) });
  assert.deepEqual(r, { ok: false, reason: 'no_cookie' });
  assert.equal(calls.length, 0);
});

test('only the session cookie is forwarded to the dashboard', async () => {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const body = { ok: true, user: { handle: 'Avraham', display_name: 'Avraham A', role: 'owner' } };
  const r = await lookupSession('theme=dark; homelab_session=tok123; other=zzz', {
    meUrl: ME,
    fetchImpl: fakeFetch(200, body, calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ME);
  assert.equal(calls[0]!.init!.method, 'GET');
  assert.equal(calls[0]!.init!.headers!.cookie, 'homelab_session=tok123');
  assert.deepEqual(r, { ok: true, user: { handle: 'avraham', displayName: 'Avraham A', role: 'owner' } });
});

test('accepts the bare user object and the username field, like the hub SDK', async () => {
  const bare = await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: fakeFetch(200, { handle: 'sam' }) });
  assert.deepEqual(bare, { ok: true, user: { handle: 'sam', displayName: 'sam', role: null } });
  const legacy = await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: fakeFetch(200, { user: { username: 'Dana' } }) });
  assert.equal(legacy.ok && legacy.user.handle, 'dana');
});

test('401/403 mean the cookie was rejected', async () => {
  for (const status of [401, 403]) {
    const r = await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: fakeFetch(status, { error: 'no' }) });
    assert.deepEqual(r, { ok: false, reason: 'rejected' });
  }
});

test('server errors, network errors and timeouts mean unreachable (play as guest)', async () => {
  assert.deepEqual(await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: fakeFetch(502, {}) }), { ok: false, reason: 'unreachable' });
  const boom: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.deepEqual(await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: boom }), { ok: false, reason: 'unreachable' });
  const hang: FetchLike = () => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: hang, timeoutMs: 40 }), { ok: false, reason: 'unreachable' });
  assert.ok(Date.now() - started < 1000);
});

test('garbage responses are not trusted', async () => {
  for (const body of [null, 'x', {}, { ok: false }, { ok: true, user: {} }, { user: { handle: '  ' } }]) {
    const r = await lookupSession('homelab_session=t', { meUrl: ME, fetchImpl: fakeFetch(200, body) });
    assert.deepEqual(r, { ok: false, reason: 'bad_response' }, JSON.stringify(body));
  }
});

test('identity: a user takes the dashboard name, a guest the name it sent', () => {
  const user = toIdentity({ ok: true, user: { handle: 'avraham', displayName: 'Avraham', role: 'owner' } }, 'IGNORED');
  assert.deepEqual(user, { kind: 'user', handle: 'avraham', name: 'Avraham', role: 'owner' });
  const guest = toIdentity({ ok: false, reason: 'no_cookie' }, '  Sam‮ ');
  assert.deepEqual(guest, { kind: 'guest', handle: null, name: 'Sam', role: null });
  assert.equal(toIdentity({ ok: false, reason: 'rejected' }, undefined).name, 'Guest');
});
