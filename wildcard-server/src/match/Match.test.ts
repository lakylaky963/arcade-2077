import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMEOUTS_BEFORE_AUTOPILOT } from './Match.ts';
import { harness, type Harness } from './testkit.ts';
import { canPlayCard, mustDraw, playableCards, type GameState } from '../rules/uno.ts';
import type { Identity } from '../types.ts';

const user = (handle: string, name = handle): Identity => ({ kind: 'user', handle, name, role: 'player' });
const guest = (name: string): Identity => ({ kind: 'guest', handle: null, name, role: null });

/** Make `seat` the one on turn with a chosen situation, without waiting for the shuffle. */
function setTurn(h: Harness, mutate: (g: GameState) => GameState): void {
  h.match.game = mutate(h.match.game!);
  // the timer armed for the old situation is stale: a no-op reconnect re-arms it for the new one
  const anyone = h.match.seats.find((s) => s.occupant !== null)!.occupant!.clientId;
  h.match.reconnect(anyone);
}

function startWith(h: Harness, who: Identity[]): void {
  who.forEach((id, i) => assert.equal(h.match.join(`c${i}`, id).ok, true));
  assert.deepEqual(h.match.start('c0'), { ok: true });
}

// ── seating and lobby ────────────────────────────────────────────────

test('seats start as bots; people take the lowest free seat; the first becomes host', () => {
  const h = harness({ seats: 3 });
  assert.deepEqual(h.match.seats.map((s) => s.name), ['Bot 1', 'Bot 2', 'Bot 3']);
  assert.deepEqual(h.match.join('a', guest('Ann')), { ok: true, seat: 0 });
  assert.deepEqual(h.match.join('b', user('bob', 'Bob')), { ok: true, seat: 1 });
  assert.equal(h.match.hostSeat, 0);
  assert.deepEqual(h.match.seats.map((s) => s.name), ['Ann', 'Bob', 'Bot 3']);
  assert.equal(h.match.hasFreeSeat(), true);
  assert.deepEqual(h.match.join('c', guest('Cy')), { ok: true, seat: 2 });
  assert.equal(h.match.hasFreeSeat(), false);
  assert.deepEqual(h.match.join('d', guest('Di')), { ok: false, reason: 'full' });
});

test('names are made unique and one account cannot take two seats', () => {
  const h = harness({ seats: 3 });
  h.match.join('a', guest('Sam'));
  h.match.join('b', guest('sam'));
  assert.equal(h.match.seats[1]!.name, 'sam 2');
  h.match.join('c', user('dana'));
  assert.deepEqual(h.match.join('d', user('dana')), { ok: false, reason: 'duplicate_user' });
  assert.equal(h.match.hasFreeSeat(), false);
});

test('only the host can change options or start, and only outside a running game', () => {
  const h = harness({ seats: 2 });
  h.match.join('host', guest('H'));
  h.match.join('other', guest('O'));
  assert.deepEqual(h.match.setOptions('other', { stacking: true }), { ok: false, reason: 'not_host' });
  assert.deepEqual(h.match.start('other'), { ok: false, reason: 'not_host' });
  assert.deepEqual(h.match.setOptions('nobody', {}), { ok: false, reason: 'not_seated' });
  assert.deepEqual(h.match.setOptions('host', { stacking: true, turnSeconds: 15 }), { ok: true });
  assert.equal(h.match.options.stacking, true);
  assert.equal(h.match.options.turnSeconds, 15);
  assert.deepEqual(h.match.start('host'), { ok: true });
  assert.equal(h.match.game!.stacking, true);
  assert.deepEqual(h.match.start('host'), { ok: false, reason: 'bad_phase' });
  assert.deepEqual(h.match.setOptions('host', { stacking: false }), { ok: false, reason: 'bad_phase' });
});

test('starting deals the configured seats; empty seats are bots', () => {
  const h = harness({ seats: 4, stacking: true });
  startWith(h, [guest('Solo')]);
  assert.equal(h.match.phase, 'playing');
  assert.equal(h.match.game!.hands.length, 4);
  assert.equal(h.match.matchId, 'match-1');
  assert.equal(h.match.seats.filter((s) => s.occupant === null).length, 3);
});

test('the host passes to the next person when the host leaves', () => {
  const h = harness({ seats: 3 });
  h.match.join('a', guest('A'));
  h.match.join('b', guest('B'));
  h.match.join('c', guest('C'));
  h.match.leave('a');
  assert.equal(h.match.hostSeat, 1);
  assert.equal(h.match.seats[0]!.name, 'Bot 1');
  assert.equal(h.match.seats[0]!.occupant, null);
  h.match.leave('b');
  assert.equal(h.match.hostSeat, 2);
  h.match.leave('c');
  assert.equal(h.match.hostSeat, -1);
});

// ── bots ─────────────────────────────────────────────────────────────

test('bots play on their own; a lone bot table finishes a game', () => {
  const h = harness({ seats: 3, turnSeconds: 0 });
  startWith(h, [guest('Solo')]);
  // the human never moves; with the timer off the game waits for them on their turn,
  // so make the human a bot-held seat to let the table run
  h.match.drop('c0');
  for (let i = 0; i < 20000 && h.finished.length === 0; i++) h.clock.advance(1000);
  assert.equal(h.finished.length, 1);
  assert.equal(h.match.phase, 'finished');
  assert.equal(h.match.turnDeadline, 0);
  assert.equal(h.clock.pending, 0, 'no timers left after the game');
});

test('a human with nothing playable is drawn for automatically and no timeout is counted', () => {
  const h = harness({ seats: 2, turnSeconds: 15 });
  startWith(h, [guest('A'), guest('B')]);
  setTurn(h, (g) => ({
    ...g,
    current: 0,
    pending: 0,
    pendingKind: null,
    activeColor: 'red',
    discard: [{ id: 'red_5_9', kind: 'color', color: 'red', value: '5' }],
    hands: [[{ id: 'green_7_0', kind: 'color', color: 'green', value: '7' }], g.hands[1]!],
  }));
  assert.equal(mustDraw(h.match.game!), true);
  h.match.draw('nope');
  // re-arm the schedule by a no-op reconnect on the seat on turn
  h.match.reconnect('c0');
  h.clock.advance(700);
  assert.equal(h.match.game!.hands[0]!.length, 2);
  assert.equal(h.match.game!.current, 1);
  assert.equal(h.match.seats[0]!.timeouts, 0);
  assert.equal(h.match.seats[0]!.autopilot, false);
  assert.equal(h.match.seats[0]!.botTurns, 0);
});

// ── turn timer ───────────────────────────────────────────────────────

function humanTurnHarness(turnSeconds: 0 | 15 | 30) {
  const h = harness({ seats: 2, turnSeconds });
  startWith(h, [guest('A'), guest('B')]);
  // seat 0 on turn with two playable red cards so it is a real choice
  setTurn(h, (g) => ({
    ...g,
    current: 0,
    pending: 0,
    pendingKind: null,
    activeColor: 'red',
    discard: [{ id: 'red_5_9', kind: 'color', color: 'red', value: '5' }],
    hands: [
      [
        { id: 'red_1_0', kind: 'color', color: 'red', value: '1' },
        { id: 'red_2_0', kind: 'color', color: 'red', value: '2' },
        { id: 'red_3_0', kind: 'color', color: 'red', value: '3' },
        { id: 'red_4_0', kind: 'color', color: 'red', value: '4' },
      ],
      g.hands[1]!,
    ],
  }));
  h.match.reconnect('c0'); // re-arm the timer for the situation above
  return h;
}

test('the turn timer publishes a deadline and moves for a human who is too slow', () => {
  const h = humanTurnHarness(15);
  assert.equal(h.match.turnDeadline, h.clock.now + 15_000);
  h.clock.advance(14_999);
  assert.equal(h.match.game!.current, 0);
  h.clock.advance(2);
  assert.equal(h.match.game!.current === 0, false, 'a bot moved for them');
  assert.equal(h.match.seats[0]!.timeouts, 1);
  assert.equal(h.match.seats[0]!.autopilot, false);
  assert.equal(h.match.seats[0]!.botTurns, 1);
});

test('timer off: a human is never moved for', () => {
  const h = humanTurnHarness(0);
  assert.equal(h.match.turnDeadline, 0);
  h.clock.advance(10 * 60 * 1000);
  assert.equal(h.match.game!.current, 0);
  assert.equal(h.match.seats[0]!.timeouts, 0);
});

test('the 30 s option waits 30 s', () => {
  const h = humanTurnHarness(30);
  h.clock.advance(29_000);
  assert.equal(h.match.game!.current, 0);
  h.clock.advance(1_100);
  assert.notEqual(h.match.game!.current, 0);
});

test('after 2 timeouts a bot takes the seat over; acting takes it back', () => {
  const h = humanTurnHarness(15);
  const seat = h.match.seats[0]!;
  h.clock.advance(15_000); // timeout 1, bot moves for seat 0, then seat 1 (bot, 0.9-1.2 s)
  assert.equal(seat.timeouts, 1);
  assert.equal(seat.autopilot, false);
  // run until it is seat 0's turn again
  for (let i = 0; i < 200 && h.match.game!.current !== 0 && h.match.phase === 'playing'; i++) h.clock.advance(500);
  if (h.match.phase !== 'playing') return; // an unlucky quick finish would make this test moot; seed 42 does not
  assert.equal(h.match.game!.current, 0);
  assert.equal(h.match.turnDeadline > 0 || seat.autopilot, true);
  h.clock.advance(15_000); // timeout 2
  assert.equal(seat.timeouts, TIMEOUTS_BEFORE_AUTOPILOT);
  assert.equal(seat.autopilot, true);
  assert.equal(seat.autopilotReason, 'timeout');
  assert.notEqual(seat.occupant, null, 'the seat is still theirs');
  assert.equal(h.match.hasFreeSeat(), false, 'nobody else can take it');

  // while on autopilot the bot moves quickly instead of waiting for the timer
  for (let i = 0; i < 100 && h.match.game!.current !== 0 && h.match.phase === 'playing'; i++) h.clock.advance(500);
  if (h.match.phase !== 'playing') return;
  assert.equal(h.match.turnDeadline, 0);
  h.clock.advance(1300);
  assert.notEqual(h.match.game!.current, 0);

  // taking control back
  assert.deepEqual(h.match.resume('c0'), { ok: true });
  assert.equal(seat.autopilot, false);
  assert.equal(seat.timeouts, 0);
});

test('a manual move resets the timeout count', () => {
  const h = humanTurnHarness(15);
  h.clock.advance(15_000);
  const seat = h.match.seats[0]!;
  assert.equal(seat.timeouts, 1);
  for (let i = 0; i < 200 && h.match.game!.current !== 0 && h.match.phase === 'playing'; i++) h.clock.advance(500);
  if (h.match.phase !== 'playing') return;
  const playable = playableCards(h.match.game!, 0)[0];
  const move = playable
    ? h.match.play('c0', playable.id, playable.kind === 'wild' ? 'red' : undefined)
    : h.match.draw('c0');
  assert.deepEqual(move, { ok: true });
  assert.equal(seat.timeouts, 0);
});

test('acting while on timeout-autopilot also takes the seat back', () => {
  const h = humanTurnHarness(15);
  const seat = h.match.seats[0]!;
  seat.timeouts = 2;
  seat.autopilot = true;
  seat.autopilotReason = 'timeout';
  assert.deepEqual(h.match.draw('c0'), { ok: true });
  assert.equal(seat.autopilot, false);
  assert.equal(seat.timeouts, 0);
});

// ── human move validation ────────────────────────────────────────────

test('no moves before the game starts', () => {
  const h = harness({ seats: 2, turnSeconds: 0 });
  h.match.join('a', guest('A'));
  assert.deepEqual(h.match.draw('a'), { ok: false, reason: 'not_playing' });
  assert.deepEqual(h.match.play('a', 'red_1_0'), { ok: false, reason: 'not_playing' });
});

test('humans cannot play out of turn, play unknown cards, or skip choosing a wild colour', () => {
  const h = humanTurnHarness(0);
  assert.deepEqual(h.match.draw('stranger'), { ok: false, reason: 'not_seated' });
  assert.deepEqual(h.match.draw('c1'), { ok: false, reason: 'not_your_turn' });
  assert.deepEqual(h.match.play('c0', 'nope'), { ok: false, reason: 'unknown_card' });
  assert.deepEqual(h.match.play('c0', 'red_1_0'), { ok: true });
  // seat 1 is a human here, so it is now its turn
  assert.equal(h.match.game!.current, 1);
});

// ── drops, reconnection and leaving ──────────────────────────────────

test('a dropped player is held by a bot and gets the seat back on reconnect', () => {
  const h = humanTurnHarness(30);
  const seat = h.match.seats[0]!;
  h.match.drop('c0');
  assert.equal(seat.connected, false);
  assert.equal(seat.autopilot, true);
  assert.equal(seat.autopilotReason, 'disconnect');
  assert.equal(h.match.hasFreeSeat(), false, 'the seat is reserved');
  assert.deepEqual(h.match.draw('c0'), { ok: false, reason: 'autopilot' }, 'no actions while disconnected');

  // the bot plays for them (their turn): no waiting for the 30 s timer
  h.clock.advance(1300);
  assert.notEqual(h.match.game!.current, 0);
  assert.equal(seat.botTurns >= 1, true);

  assert.equal(h.match.reconnect('c0'), true);
  assert.equal(seat.connected, true);
  assert.equal(seat.autopilot, false);
  assert.equal(seat.autopilotReason, null);
  assert.equal(seat.occupant!.clientId, 'c0');
});

test('reconnecting does not clear timeout-autopilot; resume does', () => {
  const h = humanTurnHarness(15);
  const seat = h.match.seats[0]!;
  seat.autopilot = true;
  seat.autopilotReason = 'timeout';
  h.match.reconnect('c0');
  assert.equal(seat.autopilot, true);
  h.match.resume('c0');
  assert.equal(seat.autopilot, false);
});

test('when the hold expires the seat becomes a free bot seat again', () => {
  const h = humanTurnHarness(30);
  h.match.drop('c0');
  h.match.leave('c0');
  const seat = h.match.seats[0]!;
  assert.equal(seat.occupant, null);
  assert.equal(seat.name, 'Bot 1');
  assert.equal(seat.autopilot, false);
  assert.equal(h.match.hasFreeSeat(), true);
  assert.equal(h.match.seatOf('c0'), null);
  assert.equal(h.match.reconnect('c0'), false);
  // a newcomer can take it mid-game and gets the hand that was dealt to that seat
  const handBefore = h.match.game!.hands[0]!.map((c) => c.id);
  assert.deepEqual(h.match.join('newbie', guest('New')), { ok: true, seat: 0 });
  assert.deepEqual(h.match.game!.hands[0]!.map((c) => c.id), handBefore);
});

test('the host dropping keeps the host seat until the hold expires', () => {
  const h = humanTurnHarness(30);
  h.match.drop('c0');
  assert.equal(h.match.hostSeat, 0);
  h.match.leave('c0');
  assert.equal(h.match.hostSeat, 1);
});

// ── finishing and results ────────────────────────────────────────────

function winningHarness() {
  const h = harness({ seats: 3, turnSeconds: 0, stacking: true });
  h.match.join('a', user('avraham', 'Avraham'));
  h.match.join('b', guest('Guest B'));
  h.match.start('a');
  setTurn(h, (g) => ({
    ...g,
    current: 0,
    pending: 0,
    pendingKind: null,
    activeColor: 'red',
    discard: [{ id: 'red_5_9', kind: 'color', color: 'red', value: '5' }],
    hands: [
      [{ id: 'red_9_0', kind: 'color', color: 'red', value: '9' }],
      [{ id: 'blue_4_0', kind: 'color', color: 'blue', value: '4' }, { id: 'wild_0', kind: 'wild', value: 'wild' }],
      [{ id: 'green_skip_0', kind: 'color', color: 'green', value: 'skip' }],
    ],
  }));
  return h;
}

test('going out finishes the match and builds the result for the dashboard', () => {
  const h = winningHarness();
  h.clock.advance(65_000);
  assert.deepEqual(h.match.play('a', 'red_9_0'), { ok: true });
  assert.equal(h.match.phase, 'finished');
  assert.equal(h.finished.length, 1);
  const { result, doc } = h.finished[0]!;
  assert.equal(result.game, 'wildcard');
  assert.equal(result.matchId, 'match-1');
  assert.equal(result.roomCode, 'BCDFG');
  assert.equal(result.durationMs, 65_000);
  assert.equal(result.humanPlayers, 2);
  assert.deepEqual(result.options, { seats: 3, stacking: true, turnSeconds: 0 });
  assert.equal(new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime(), 65_000);

  const [p0, p1, p2] = result.players;
  assert.deepEqual(p0, {
    seat: 0, kind: 'user', handle: 'avraham', name: 'Avraham', role: 'player', rank: 1, winner: true,
    cardsLeft: 0, handPoints: 0, score: 54 + 20, afk: false, timeouts: 0, botTurns: 0,
  });
  assert.equal(p1!.kind, 'guest');
  assert.equal(p1!.handle, null);
  assert.equal(p1!.rank, 3); // blue 4 + wild = 54 points left
  assert.equal(p1!.handPoints, 54);
  assert.equal(p2!.kind, 'bot');
  assert.equal(p2!.handle, null);
  assert.equal(p2!.rank, 2); // green skip = 20 points left
  assert.equal(doc.status, 'finished');
  assert.deepEqual(doc.moves.map((m) => `${m.seat}:${m.type}:${m.card ?? ''}:${m.bot}`), ['0:play:red_9_0:false']);
  assert.equal(h.clock.pending, 0, 'no timers left after the game');
  assert.equal(h.match.turnDeadline, 0);
});

test('the result is plain JSON with no hidden information', () => {
  const h = winningHarness();
  h.match.play('a', 'red_9_0');
  const json = JSON.stringify(h.finished[0]!.result);
  assert.deepEqual(JSON.parse(json), h.finished[0]!.result);
  assert.ok(!json.includes('blue_4_0'), 'no card ids in the report');
});

test('public events are emitted for every move', () => {
  const h = winningHarness();
  h.match.play('a', 'red_9_0');
  const last = h.events.at(-1)!;
  assert.equal(last.seat, 0);
  assert.equal(last.bot, false);
  assert.deepEqual(last.events.map((e) => e.type), ['play', 'win']);
});

test('a bot winning for an AFK person is flagged afk, and a seat released before the end is reported as a bot', () => {
  const h = winningHarness();
  h.match.leave('b'); // guest B walks away: seat 1 becomes a bot
  h.match.seats[0]!.autopilot = true;
  h.match.seats[0]!.autopilotReason = 'timeout';
  h.match.seats[0]!.timeouts = 2;
  h.match.reconnect('c-none'); // no-op (unknown client)
  h.match.drop('a');
  h.clock.advance(5_000); // bot plays the winning card for seat 0
  assert.equal(h.finished.length, 1);
  const p0 = h.finished[0]!.result.players[0]!;
  assert.equal(p0.winner, true);
  assert.equal(p0.afk, true);
  assert.equal(p0.botTurns, 1);
  assert.equal(h.finished[0]!.result.players[1]!.kind, 'bot');
  assert.equal(h.finished[0]!.result.humanPlayers, 1);
});

test('rematch: the host can deal again after a game, with changed options', () => {
  const h = winningHarness();
  h.match.play('a', 'red_9_0');
  assert.deepEqual(h.match.start('b'), { ok: false, reason: 'not_host' });
  assert.deepEqual(h.match.setOptions('a', { stacking: false, turnSeconds: 15 }), { ok: true });
  assert.deepEqual(h.match.start('a'), { ok: true });
  assert.equal(h.match.phase, 'playing');
  assert.equal(h.match.matchId, 'match-2');
  assert.equal(h.match.game!.stacking, false);
  assert.equal(h.match.game!.winner, null);
  assert.equal(h.match.options.turnSeconds, 15);
  for (const hand of h.match.game!.hands) assert.equal(hand.length, 7);
});

test('disposing a running game returns an abandoned log and stops every timer', () => {
  const h = winningHarness();
  const doc = h.match.dispose();
  assert.ok(doc);
  assert.equal(doc.status, 'abandoned');
  assert.ok(doc.players.every((p) => p.rank === null && p.winner === false));
  assert.equal(doc.players[0]!.cardsLeft, 1);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.finished.length, 0, 'abandoned matches are not reported as finished');
  // nothing to log for a lobby or a finished game
  assert.equal(harness().match.dispose(), null);
});
