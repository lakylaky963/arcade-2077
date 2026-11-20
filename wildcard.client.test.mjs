// Pure-logic tests for the WILDCARD phone client: node --test wildcard.client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from './wildcard/js/logic.js';
import { t, STRINGS } from './wildcard/js/i18n.js';
import { existsSync, readFileSync } from 'node:fs';

const c = (id, color, value) => ({ id, kind: 'color', color, value });
const w = (id, value = 'wild') => ({ id, kind: 'wild', color: '', value });
const base = (o = {}) => ({
  phase: 'playing', currentPlayer: 0, pendingDraw: 0, pendingKind: '', stacking: false, activeColor: 'red',
  discardPile: [c('t', 'red', '5')], ...o,
});

test('sortHand groups by colour, orders values, wilds last, does not mutate', () => {
  const hand = [w('w1'), c('b2', 'blue', '2'), c('r9', 'red', '9'), c('rs', 'red', 'skip'), c('g0', 'green', '0'), w('w2', 'wild4'), c('r1', 'red', '1'), c('y3', 'yellow', '3')];
  const copy = JSON.parse(JSON.stringify(hand));
  const out = L.sortHand(hand);
  assert.deepEqual(hand, copy);
  assert.deepEqual(out.map((x) => x.id), ['r1', 'r9', 'rs', 'y3', 'g0', 'b2', 'w1', 'w2']);
});

test('canPlay: colour, value, wild; blocked when not playing', () => {
  const v = base();
  assert.equal(L.canPlay(v, c('x', 'red', '1')), true);
  assert.equal(L.canPlay(v, c('x', 'blue', '5')), true);
  assert.equal(L.canPlay(v, c('x', 'blue', '6')), false);
  assert.equal(L.canPlay(v, w('x')), true);
  assert.equal(L.canPlay(base({ phase: 'lobby' }), c('x', 'red', '1')), false);
});

test('canPlay: a chosen wild colour decides, value match needs a colour top', () => {
  const v = base({ activeColor: 'green', discardPile: [w('t')] });
  assert.equal(L.canPlay(v, c('x', 'green', '3')), true);
  assert.equal(L.canPlay(v, c('x', 'red', '3')), false);
});

test('canPlay with a pending penalty: only the stacking card, and only when stacking is on', () => {
  const on = base({ pendingDraw: 2, pendingKind: 'draw2', stacking: true });
  assert.equal(L.canPlay(on, c('x', 'blue', 'draw2')), true);
  assert.equal(L.canPlay(on, c('x', 'red', '5')), false);
  assert.equal(L.canPlay(on, w('x', 'wild4')), false);
  const four = base({ pendingDraw: 4, pendingKind: 'wild4', stacking: true });
  assert.equal(L.canPlay(four, w('x', 'wild4')), true);
  assert.equal(L.canPlay(four, c('x', 'red', 'draw2')), false);
  assert.equal(L.canPlay(base({ pendingDraw: 2, pendingKind: 'draw2', stacking: false }), c('x', 'red', 'draw2')), false);
});

test('playableIds / mustDraw / drawAction only react on my turn', () => {
  const hand = [c('a', 'red', '1'), c('b', 'blue', '9')];
  const v = base({ currentPlayer: 2 });
  assert.equal(L.playableIds(v, hand, 1).size, 0);
  assert.deepEqual([...L.playableIds(v, hand, 2)], ['a']);
  assert.equal(L.mustDraw(v, hand, 1), false);
  assert.equal(L.mustDraw(v, [c('b', 'blue', '9')], 2), true);
  assert.deepEqual(L.drawAction(v, 1), { enabled: false, count: 0 });
  assert.deepEqual(L.drawAction(v, 2), { enabled: true, count: 1 });
  assert.deepEqual(L.drawAction(base({ currentPlayer: 2, pendingDraw: 6 }), 2), { enabled: true, count: 6 });
});

test('timer helpers', () => {
  assert.equal(L.secondsLeft(0, 1000), null);
  assert.equal(L.secondsLeft(10_000, 1000), 9);
  assert.equal(L.secondsLeft(10_500, 10_000), 1);
  assert.equal(L.secondsLeft(1000, 5000), 0);
  assert.equal(L.timerFraction(15_000, 30, 0), 0.5);
  assert.equal(L.timerFraction(0, 30, 0), null);
  assert.equal(L.timerFraction(1000, 30, 9000), 0);
});

test('opponentsInPlayOrder follows the direction of play', () => {
  const seats = [0, 1, 2, 3].map((i) => ({ seatIndex: i }));
  assert.deepEqual(L.opponentsInPlayOrder(seats, 1, 1).map((p) => p.seatIndex), [2, 3, 0]);
  assert.deepEqual(L.opponentsInPlayOrder(seats, 1, -1).map((p) => p.seatIndex), [0, 3, 2]);
  assert.deepEqual(L.opponentsInPlayOrder(seats.slice(0, 2), 0).map((p) => p.seatIndex), [1]);
});

test('seatBadge', () => {
  assert.equal(L.seatBadge({ seatIndex: 1, occupied: true }, 1), 'you');
  assert.equal(L.seatBadge({ seatIndex: 1, occupied: true, autopilot: true }, 1), 'autopilot');
  assert.equal(L.seatBadge({ seatIndex: 2, occupied: true, isBot: true }, 1), 'bot');
  assert.equal(L.seatBadge({ seatIndex: 2, occupied: false }, 1), 'bot');
  assert.equal(L.seatBadge({ seatIndex: 2, occupied: true, autopilot: true, autopilotReason: 'disconnect' }, 1), 'away');
  assert.equal(L.seatBadge({ seatIndex: 2, occupied: true, autopilot: true, autopilotReason: 'timeout' }, 1), 'autopilot');
  assert.equal(L.seatBadge({ seatIndex: 2, occupied: true }, 1), null);
});

test('room code and name cleaning', () => {
  assert.equal(L.normalizeRoomCode(' ab-cd e1f '), 'ABCDE');
  assert.equal(L.isRoomCode('ABCDE'), true);
  assert.equal(L.isRoomCode('ABCD'), false);
  assert.equal(L.cleanName('  Ava <b>  Cohen\n'), 'Ava b Cohen');
  assert.equal(L.cleanName('x'.repeat(40)).length, 16);
  assert.equal(L.cleanName('', 'Guest'), 'Guest');
});

test('error keys: server join errors, rejects, unknowns', () => {
  assert.equal(L.joinErrorKey({ code: 4101 }), 'err_full');
  assert.equal(L.joinErrorKey({ code: 4102 }), 'err_duplicate');
  assert.ok(typeof L.joinErrorKey(new Error('boom')) === 'string');
  assert.equal(L.rejectKey('nope-not-a-reason'), 'rej_generic');
});

test('resolveEndpoint: default, query, stored, bare path, rejects junk', () => {
  const https = { protocol: 'https:', host: 'avrahamarazi.com' };
  assert.equal(L.resolveEndpoint({ location: https }), 'wss://avrahamarazi.com/game/uno-ws');
  assert.equal(L.resolveEndpoint({ location: { protocol: 'http:', host: '10.0.0.250' } }), 'ws://10.0.0.250/game/uno-ws');
  assert.equal(L.resolveEndpoint({ search: '?ws=ws://localhost:2567/', location: https }), 'ws://localhost:2567');
  assert.equal(L.resolveEndpoint({ stored: 'wss://x.example/a', location: https }), 'wss://x.example/a');
  assert.equal(L.resolveEndpoint({ search: '?ws=/custom/', location: https }), 'wss://avrahamarazi.com/custom');
  assert.equal(L.resolveEndpoint({ search: '?ws=javascript:alert(1)', location: https }), 'wss://avrahamarazi.com/game/uno-ws');
  assert.equal(L.resolveEndpoint({ search: '?ws=//evil.example', location: https }), 'wss://avrahamarazi.com/game/uno-ws');
});

test('reconnect token storage honours the 28 s window', () => {
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.equal(L.loadReconnect(st, 0), null);
  L.saveReconnect(st, { token: 'tok', roomCode: 'ABCDE', name: 'Ava' }, 1000);
  assert.equal(L.loadReconnect(st, 20_000).token, 'tok');
  assert.equal(L.loadReconnect(st, 1000 + L.RECONNECT_WINDOW_MS + 1), null);
  assert.equal(L.loadReconnect(st, 500), null, 'clock going backwards');
  L.clearReconnect(st);
  assert.equal(L.loadReconnect(st, 2000), null);
  m.set(L.RECONNECT_KEY, '{not json');
  assert.equal(L.loadReconnect(st, 2000), null);
  assert.deepEqual([1, 2, 3, 4, 9].map(L.reconnectDelay), [500, 1000, 2000, 3000, 3000]);
});

test('EN and HE string tables have identical keys, Hebrew text, and no "uno" brand', () => {
  const en = Object.keys(STRINGS.en).sort();
  const he = Object.keys(STRINGS.he).sort();
  assert.deepEqual(he, en);
  for (const k of ['title', 'createBtn', 'yourTurn', 'noXpNote']) assert.match(String(STRINGS.he[k]), /[֐-׿]/, k);
  const all = JSON.stringify(STRINGS).toLowerCase();
  assert.ok(!/\buno\b/.test(all) && !all.includes('אונו'), 'trademark-free copy');
  assert.equal(typeof t('en', 'drawN', 3), 'string');
  assert.ok(t('he', 'turnOf', 'Dan').includes('Dan'));
});

test('page files exist, carry the theme, and use no CDN', () => {
  const html = readFileSync(new URL('./wildcard/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-theme="yellow"/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'no absolute URLs in the page');
  for (const f of ['js/main.js', 'js/net.js', 'js/cards.js', 'js/logic.js', 'js/i18n.js', 'style.css', 'vendor/vendor.mjs', 'vendor/README.md']) {
    assert.ok(existsSync(new URL(`./wildcard/${f}`, import.meta.url)), f);
  }
});

test('vendored @colyseus/sdk is pinned to 0.17 with its licence (skipped until vendored)', (ctx) => {
  const dir = new URL('./wildcard/vendor/', import.meta.url);
  if (!existsSync(new URL('colyseus-sdk.mjs', dir))) return ctx.skip('run: node wildcard/vendor/vendor.mjs (needs npm access)');
  assert.match(readFileSync(new URL('VERSION', dir), 'utf8'), /^@colyseus\/sdk 0\.17\.\d+/);
  assert.ok(existsSync(new URL('LICENSE-colyseus-sdk', dir)));
});
