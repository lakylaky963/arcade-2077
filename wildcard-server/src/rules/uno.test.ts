import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS,
  applyMove,
  canPlayCard,
  createDeck,
  createGame,
  handPoints,
  mustDraw,
  playableCards,
  seatAfter,
  shuffle,
  standings,
  topCard,
  type GameState,
  type MoveResult,
} from './uno.ts';
import { chooseMove } from './bot.ts';
import { c, countCards, mk, seeded, totalCards, wild, wild4 } from './testkit.ts';

function ok(result: MoveResult): Extract<MoveResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : `rejected: ${result.reason}`);
  return result as Extract<MoveResult, { ok: true }>;
}

// ── deck ────────────────────────────────────────────────────────────

test('deck has 108 cards with the standard distribution', () => {
  const deck = createDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((card) => card.id)).size, 108);
  for (const color of COLORS) {
    const ofColor = deck.filter((card) => card.kind === 'color' && card.color === color);
    assert.equal(ofColor.length, 25);
    assert.equal(ofColor.filter((card) => card.value === '0').length, 1);
    for (const value of ['1', '5', '9', 'skip', 'reverse', 'draw2']) {
      assert.equal(ofColor.filter((card) => card.value === value).length, 2, `${color} ${value}`);
    }
  }
  assert.equal(deck.filter((card) => card.value === 'wild').length, 4);
  assert.equal(deck.filter((card) => card.value === 'wild_draw4').length, 4);
});

test('shuffle keeps every card and does not touch the input', () => {
  const deck = createDeck();
  const before = deck.map((card) => card.id).join();
  const out = shuffle(deck, seeded(1));
  assert.equal(deck.map((card) => card.id).join(), before);
  assert.equal(out.length, 108);
  assert.equal(new Set(out.map((card) => card.id)).size, 108);
  assert.notEqual(out.map((card) => card.id).join(), before);
});

// ── deal ────────────────────────────────────────────────────────────

test('deal gives 7 cards per seat for 2, 3 and 4 seats and conserves the deck', () => {
  for (const seats of [2, 3, 4]) {
    const state = createGame({ seats, rng: seeded(seats) });
    assert.equal(state.hands.length, seats);
    for (const hand of state.hands) assert.equal(hand.length, 7);
    assert.equal(state.discard.length, 1);
    assert.equal(totalCards(state), 108);
    assert.equal(countCards(state), 108);
    assert.equal(state.winner, null);
    assert.equal(state.stacking, false);
  }
});

test('the starting card is never a wild', () => {
  for (let seed = 0; seed < 300; seed++) {
    const state = createGame({ seats: 4, rng: seeded(seed) });
    assert.equal(topCard(state).kind, 'color', `seed ${seed}`);
    assert.equal(state.activeColor, (topCard(state) as { color: string }).color);
  }
});

test('createGame rejects bad seat counts', () => {
  assert.throws(() => createGame({ seats: 1 }), RangeError);
  assert.throws(() => createGame({ seats: 5 }), RangeError);
  assert.throws(() => createGame({ seats: 2.5 }), RangeError);
});

test('first-card effects: skip, reverse and draw2', () => {
  const seen = { skip: false, reverse: false, draw2: false };
  for (let seed = 0; seed < 3000 && !(seen.skip && seen.reverse && seen.draw2); seed++) {
    const state = createGame({ seats: 4, stacking: true, rng: seeded(seed) });
    const top = topCard(state);
    if (top.kind !== 'color') continue;
    if (top.value === 'skip') {
      seen.skip = true;
      assert.equal(state.current, 1);
      assert.equal(state.direction, 1);
    } else if (top.value === 'reverse') {
      seen.reverse = true;
      assert.equal(state.current, 3);
      assert.equal(state.direction, -1);
    } else if (top.value === 'draw2') {
      seen.draw2 = true;
      assert.equal(state.current, 0);
      assert.equal(state.pending, 2);
      assert.equal(state.pendingKind, 'draw2');
    } else {
      assert.equal(state.current, 0);
      assert.equal(state.pending, 0);
    }
  }
  assert.deepEqual(seen, { skip: true, reverse: true, draw2: true });
});

test('with 2 seats a starting reverse hands the turn to seat 1 (acts as skip)', () => {
  for (let seed = 0; seed < 3000; seed++) {
    const state = createGame({ seats: 2, rng: seeded(seed) });
    const top = topCard(state);
    if (top.kind === 'color' && top.value === 'reverse') {
      assert.equal(state.current, 1);
      return;
    }
  }
  assert.fail('no seed produced a starting reverse');
});

// ── playability ─────────────────────────────────────────────────────

test('playability: colour match, value match, wilds, and nothing else', () => {
  const state = mk({
    hands: [[c('red', '2'), c('blue', '5'), c('green', '7'), wild()], [c('yellow', '1')]],
    top: c('red', '5', 9),
  });
  const hand = state.hands[0]!;
  assert.equal(canPlayCard(state, hand[0]!), true); // same colour
  assert.equal(canPlayCard(state, hand[1]!), true); // same value
  assert.equal(canPlayCard(state, hand[2]!), false);
  assert.equal(canPlayCard(state, hand[3]!), true); // wild
  assert.deepEqual(playableCards(state, 0).map((card) => card.id), [hand[0]!.id, hand[1]!.id, hand[3]!.id]);
  assert.deepEqual(playableCards(state, 1), []); // not that seat's turn
});

test('a played wild sets the active colour that later cards must match', () => {
  const s0 = mk({ hands: [[wild(), c('green', '3')], [c('blue', '4'), c('green', '8')]] });
  const s1 = ok(applyMove(s0, 0, { type: 'play', cardId: 'wild_0', chosenColor: 'green' })).state;
  assert.equal(s1.activeColor, 'green');
  assert.equal(canPlayCard(s1, s1.hands[1]![0]!), false); // blue 4
  assert.equal(canPlayCard(s1, s1.hands[1]![1]!), true); // green 8
  // value match does not apply on top of a wild
  const s2 = mk({ hands: [[c('red', '3')], [c('blue', '4')]], top: wild(), activeColor: 'green' });
  assert.equal(canPlayCard(s2, s2.hands[0]![0]!), false);
});

// ── validation ──────────────────────────────────────────────────────

test('illegal moves are rejected and change nothing', () => {
  const state = mk({ hands: [[c('red', '2'), c('green', '7'), wild()], [c('blue', '1')]] });
  const frozen = JSON.stringify(state);
  const bad = (seat: number, move: Parameters<typeof applyMove>[2]) => applyMove(state, seat, move);
  assert.deepEqual(bad(1, { type: 'draw' }), { ok: false, reason: 'not_your_turn' });
  assert.deepEqual(bad(1, { type: 'play', cardId: 'blue_1_0' }), { ok: false, reason: 'not_your_turn' });
  assert.deepEqual(bad(0, { type: 'play', cardId: 'nope' }), { ok: false, reason: 'unknown_card' });
  assert.deepEqual(bad(0, { type: 'play', cardId: 'green_7_0' }), { ok: false, reason: 'not_playable' });
  assert.deepEqual(bad(0, { type: 'play', cardId: 'wild_0' }), { ok: false, reason: 'color_required' });
  assert.deepEqual(
    // @ts-expect-error not a colour
    bad(0, { type: 'play', cardId: 'wild_0', chosenColor: 'purple' }),
    { ok: false, reason: 'color_required' },
  );
  assert.equal(JSON.stringify(state), frozen);
});

test('applyMove never mutates the state it is given', () => {
  const state = mk({ hands: [[c('red', '2'), c('red', '9')], [c('blue', '1')]] });
  const frozen = JSON.stringify(state);
  ok(applyMove(state, 0, { type: 'play', cardId: 'red_2_0' }));
  ok(applyMove(state, 0, { type: 'draw' }));
  assert.equal(JSON.stringify(state), frozen);
});

// ── action cards ────────────────────────────────────────────────────

test('skip jumps over the next seat', () => {
  const state = mk({
    hands: [[c('red', 'skip'), c('red', '1')], [c('blue', '1')], [c('blue', '2')], [c('blue', '3')]],
  });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'red_skip_0' }));
  assert.equal(r.state.current, 2);
  assert.deepEqual(r.events.filter((e) => e.type === 'skip'), [{ type: 'skip', seat: 1 }]);
});

test('skip wraps around the table and respects direction', () => {
  const state = mk({
    hands: [[c('red', '1')], [c('blue', '1')], [c('blue', '2')], [c('red', 'skip'), c('red', '2')]],
    current: 3,
  });
  assert.equal(ok(applyMove(state, 3, { type: 'play', cardId: 'red_skip_0' })).state.current, 1);
  const back = mk({
    hands: [[c('red', 'skip'), c('red', '2')], [c('blue', '1')], [c('blue', '2')], [c('blue', '3')]],
    direction: -1,
  });
  assert.equal(ok(applyMove(back, 0, { type: 'play', cardId: 'red_skip_0' })).state.current, 2);
});

test('reverse flips direction with 3 and 4 seats', () => {
  const four = mk({
    hands: [[c('red', 'reverse'), c('red', '1')], [c('blue', '1')], [c('blue', '2')], [c('blue', '3')]],
  });
  const r4 = ok(applyMove(four, 0, { type: 'play', cardId: 'red_reverse_0' }));
  assert.equal(r4.state.direction, -1);
  assert.equal(r4.state.current, 3);

  const three = mk({
    hands: [[c('red', 'reverse'), c('red', '1')], [c('blue', '1')], [c('blue', '2')]],
    current: 0,
  });
  const r3 = ok(applyMove(three, 0, { type: 'play', cardId: 'red_reverse_0' }));
  assert.equal(r3.state.direction, -1);
  assert.equal(r3.state.current, 2);
  // and back again
  const again = mk({
    hands: [[c('blue', '1')], [c('blue', '2')], [c('red', 'reverse'), c('red', '2')]],
    current: 2,
    direction: -1,
  });
  const rb = ok(applyMove(again, 2, { type: 'play', cardId: 'red_reverse_0' }));
  assert.equal(rb.state.direction, 1);
  assert.equal(rb.state.current, 0);
});

test('reverse acts as skip with 2 seats: the same player goes again', () => {
  const state = mk({ hands: [[c('red', 'reverse'), c('red', '1')], [c('blue', '1'), c('blue', '2')]] });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'red_reverse_0' }));
  assert.equal(r.state.current, 0);
  assert.equal(r.state.direction, -1);
  assert.deepEqual(r.events.filter((e) => e.type === 'skip'), [{ type: 'skip', seat: 1 }]);
  // seat 0 can play again straight away
  ok(applyMove(r.state, 0, { type: 'play', cardId: 'red_1_0' }));
});

test('draw2 makes the next seat draw 2 and lose the turn (stacking off)', () => {
  const state = mk({
    hands: [[c('red', 'draw2'), c('red', '1')], [c('red', '4'), c('blue', '4')], [c('blue', '9')]],
  });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'red_draw2_0' }));
  assert.equal(r.state.pending, 2);
  assert.equal(r.state.pendingKind, 'draw2');
  assert.equal(r.state.current, 1);
  assert.equal(mustDraw(r.state), true);
  // seat 1 holds playable red/4s but cannot answer with them
  assert.deepEqual(applyMove(r.state, 1, { type: 'play', cardId: 'red_4_0' }), { ok: false, reason: 'must_draw' });
  const d = ok(applyMove(r.state, 1, { type: 'draw' }));
  assert.equal(d.state.hands[1]!.length, 4);
  assert.equal(d.state.pending, 0);
  assert.equal(d.state.pendingKind, null);
  assert.equal(d.state.current, 2); // seat 1's turn was spent drawing
  assert.deepEqual(d.events, [{ type: 'draw', seat: 1, count: 2, forced: true }]);
});

test('draw2 cannot be answered with another +2 when stacking is off', () => {
  const state = mk({
    hands: [[c('red', 'draw2'), c('red', '1')], [c('green', 'draw2')]],
  });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'red_draw2_0' }));
  assert.deepEqual(applyMove(r.state, 1, { type: 'play', cardId: 'green_draw2_0' }), { ok: false, reason: 'must_draw' });
});

test('wild picks the colour; wild +4 also makes the next seat draw 4', () => {
  const state = mk({ hands: [[wild(), c('red', '1')], [c('blue', '4')]] });
  const w = ok(applyMove(state, 0, { type: 'play', cardId: 'wild_0', chosenColor: 'blue' }));
  assert.equal(w.state.activeColor, 'blue');
  assert.equal(w.state.pending, 0);
  assert.equal(w.state.current, 1);

  const s4 = mk({ hands: [[wild4(), c('red', '1')], [c('blue', '4')]] });
  const f = ok(applyMove(s4, 0, { type: 'play', cardId: 'wild_draw4_0', chosenColor: 'yellow' }));
  assert.equal(f.state.activeColor, 'yellow');
  assert.equal(f.state.pending, 4);
  assert.equal(f.state.pendingKind, 'wild_draw4');
  const d = ok(applyMove(f.state, 1, { type: 'draw' }));
  assert.equal(d.state.hands[1]!.length, 5);
  assert.equal(d.state.current, 0);
});

// ── stacking ────────────────────────────────────────────────────────

test('stacking on: +2 stacks on +2 (any colour) and the total is drawn at once', () => {
  const state = mk({
    stacking: true,
    hands: [[c('red', 'draw2'), c('red', '1')], [c('green', 'draw2'), c('green', '1')], [c('yellow', 'draw2'), c('yellow', '1')]],
  });
  const a = ok(applyMove(state, 0, { type: 'play', cardId: 'red_draw2_0' }));
  assert.equal(a.state.pending, 2);
  assert.deepEqual(playableCards(a.state, 1).map((card) => card.id), ['green_draw2_0']);
  const b = ok(applyMove(a.state, 1, { type: 'play', cardId: 'green_draw2_0' }));
  assert.equal(b.state.pending, 4);
  assert.equal(b.state.current, 2);
  const c3 = ok(applyMove(b.state, 2, { type: 'play', cardId: 'yellow_draw2_0' }));
  assert.equal(c3.state.pending, 6);
  assert.equal(c3.state.current, 0);
  const d = ok(applyMove(c3.state, 0, { type: 'draw' }));
  assert.equal(d.state.hands[0]!.length, 1 + 6);
  assert.equal(d.state.pending, 0);
  assert.equal(d.state.current, 1);
});

test('stacking on: +4 stacks only on +4, +2 only on +2', () => {
  const plus2 = mk({
    stacking: true,
    hands: [[c('red', 'draw2'), c('red', '1')], [wild4(), c('red', '3')]],
  });
  const a = ok(applyMove(plus2, 0, { type: 'play', cardId: 'red_draw2_0' }));
  assert.deepEqual(applyMove(a.state, 1, { type: 'play', cardId: 'wild_draw4_0', chosenColor: 'red' }), {
    ok: false,
    reason: 'must_draw',
  });
  assert.deepEqual(applyMove(a.state, 1, { type: 'play', cardId: 'red_3_0' }), { ok: false, reason: 'must_draw' });

  const plus4 = mk({
    stacking: true,
    hands: [[wild4(0), c('red', '1')], [wild4(1), c('red', 'draw2')]],
  });
  const b = ok(applyMove(plus4, 0, { type: 'play', cardId: 'wild_draw4_0', chosenColor: 'blue' }));
  assert.deepEqual(applyMove(b.state, 1, { type: 'play', cardId: 'red_draw2_0' }), { ok: false, reason: 'must_draw' });
  const stacked = ok(applyMove(b.state, 1, { type: 'play', cardId: 'wild_draw4_1', chosenColor: 'green' }));
  assert.equal(stacked.state.pending, 8);
  assert.equal(stacked.state.activeColor, 'green');
});

test('stacking on: a seat with no stackable card simply draws the pile', () => {
  const state = mk({
    stacking: true,
    hands: [[c('red', 'draw2'), c('red', '1')], [c('red', '5')]],
  });
  const a = ok(applyMove(state, 0, { type: 'play', cardId: 'red_draw2_0' }));
  assert.equal(mustDraw(a.state), true);
  const d = ok(applyMove(a.state, 1, { type: 'draw' }));
  assert.equal(d.state.hands[1]!.length, 3);
});

// ── draw when stuck ─────────────────────────────────────────────────

test('draw-when-stuck: one card, turn passes, the drawn card is not played automatically', () => {
  const state = mk({
    hands: [[c('green', '7'), c('yellow', '2')], [c('blue', '1')], [c('blue', '2')]],
    drawPile: [c('green', '3', 50), c('red', '9', 51)], // top of pile is the LAST element
  });
  assert.equal(mustDraw(state), true);
  const r = ok(applyMove(state, 0, { type: 'draw' }));
  assert.equal(r.state.hands[0]!.length, 3);
  assert.equal(r.state.hands[0]![2]!.id, 'red_9_51'); // drawn from the top; red 9 would be playable
  assert.equal(r.state.discard.length, 1); // ...but it was not played
  assert.equal(r.state.current, 1);
  assert.equal(r.state.drawPile.length, 1);
  assert.deepEqual(r.events, [{ type: 'draw', seat: 0, count: 1, forced: false }]);
});

test('a player may also draw voluntarily when they hold a playable card', () => {
  const state = mk({ hands: [[c('red', '2')], [c('blue', '1')]] });
  assert.equal(mustDraw(state), false);
  const r = ok(applyMove(state, 0, { type: 'draw' }));
  assert.equal(r.state.hands[0]!.length, 2);
  assert.equal(r.state.current, 1);
});

test('an empty draw pile is refilled from the discard pile, keeping the top card', () => {
  const below = [c('red', '1', 20), c('red', '2', 21), c('blue', '3', 22)];
  const state = mk({
    hands: [[c('green', '7')], [c('blue', '1')]],
    drawPile: [],
    discardBelow: below,
    top: c('red', '5', 9),
  });
  const r = ok(applyMove(state, 0, { type: 'draw' }, seeded(7)));
  assert.equal(r.state.hands[0]!.length, 2);
  assert.equal(r.state.discard.length, 1);
  assert.equal(topCard(r.state).id, 'red_5_9');
  assert.equal(r.state.drawPile.length, 2); // 3 recycled, 1 drawn
  assert.ok(below.some((card) => card.id === r.state.hands[0]![1]!.id));
});

test('a forced draw larger than the available cards takes what exists and still passes the turn', () => {
  const state = mk({
    hands: [[c('green', '7')], [c('blue', '1')]],
    drawPile: [c('blue', '9', 60)],
    pending: 4,
    pendingKind: 'wild_draw4',
    top: wild4(),
    activeColor: 'red',
    current: 1,
  });
  const r = ok(applyMove(state, 1, { type: 'draw' }));
  assert.equal(r.state.hands[1]!.length, 2); // only 1 card existed
  assert.deepEqual(r.events, [{ type: 'draw', seat: 1, count: 1, forced: true }]);
  assert.equal(r.state.current, 0);
});

// ── win and scoring ─────────────────────────────────────────────────

test('playing the last card wins; nothing is playable afterwards', () => {
  const state = mk({ hands: [[c('red', '9')], [c('blue', '4'), c('green', 'skip')], [wild()]] });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'red_9_0' }));
  assert.equal(r.state.winner, 0);
  assert.deepEqual(r.events.at(-1), { type: 'win', seat: 0 });
  assert.deepEqual(applyMove(r.state, 1, { type: 'draw' }), { ok: false, reason: 'game_over' });
  assert.deepEqual(playableCards(r.state, 0), []);
  assert.equal(mustDraw(r.state), false);
});

test('going out with a +4 or +2 still ends the game immediately', () => {
  const state = mk({ hands: [[wild4()], [c('blue', '4')]] });
  const r = ok(applyMove(state, 0, { type: 'play', cardId: 'wild_draw4_0', chosenColor: 'red' }));
  assert.equal(r.state.winner, 0);
});

test('standings: winner scores the sum of the other hands, ties share a rank', () => {
  const state = mk({
    hands: [
      [],
      [c('blue', '4'), c('green', 'skip')], // 24 points, 2 cards
      [wild()], // 50 points
      [c('blue', '4', 1), c('green', 'skip', 1)], // 24 points, 2 cards: ties with seat 1
    ],
  });
  state.winner = 0;
  const table = standings(state);
  assert.equal(table.length, 4);
  const bySeat = Object.fromEntries(table.map((row) => [row.seat, row]));
  assert.deepEqual(bySeat[0], { seat: 0, rank: 1, winner: true, cardsLeft: 0, handPoints: 0, score: 24 + 50 + 24 });
  assert.equal(bySeat[1]!.rank, 2);
  assert.equal(bySeat[3]!.rank, 2);
  assert.equal(bySeat[2]!.rank, 4);
  assert.equal(bySeat[1]!.score, 0);
  assert.equal(handPoints(state.hands[2]!), 50);

  // fewer points beats more cards: 3 low cards (3 points) outrank 1 wild (50)
  const two = mk({ hands: [[], [wild()], [c('red', '1'), c('red', '1', 1), c('red', '1', 2)]] });
  two.winner = 0;
  const t2 = standings(two);
  assert.equal(t2[2]!.rank, 2);
  assert.equal(t2[1]!.rank, 3);
});

test('standings are empty while the game is running', () => {
  assert.deepEqual(standings(createGame({ seats: 3, rng: seeded(3) })), []);
});

test('seatAfter wraps both ways', () => {
  const state = mk({ hands: [[], [], []] });
  assert.equal(seatAfter(state, 2), 0);
  assert.equal(seatAfter({ ...state, direction: -1 }, 0), 2);
  assert.equal(seatAfter(state, 1, 2), 0);
});

// ── whole games with bots ───────────────────────────────────────────

function playOut(state: GameState, rng: () => number): { state: GameState; moves: number } {
  let moves = 0;
  while (state.winner === null) {
    const move = chooseMove(state, state.current, rng);
    const r = applyMove(state, state.current, move, rng);
    assert.equal(r.ok, true, `bot made an illegal move: ${JSON.stringify(move)}`);
    if (!r.ok) break;
    state = r.state;
    moves++;
    assert.equal(totalCards(state), 108, 'cards created or destroyed');
    assert.ok(moves < 4000, 'game did not finish');
  }
  return { state, moves };
}

test('bots finish full games legally: 2-4 seats, stacking on and off, 300 deals', () => {
  let games = 0;
  for (const seats of [2, 3, 4]) {
    for (const stacking of [false, true]) {
      for (let seed = 1; seed <= 50; seed++) {
        const rng = seeded(seed * 31 + seats);
        const { state } = playOut(createGame({ seats, stacking, rng }), rng);
        assert.equal(state.hands[state.winner!]!.length, 0);
        const table = standings(state);
        assert.equal(table.filter((row) => row.winner).length, 1);
        games++;
      }
    }
  }
  assert.equal(games, 300);
});
