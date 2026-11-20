import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMove } from './uno.ts';
import { chooseMove, pickColor } from './bot.ts';
import { c, mk, seeded, wild, wild4 } from './testkit.ts';

test('bot dumps its highest-value playable card', () => {
  const state = mk({
    hands: [[c('red', '2'), c('red', '9'), c('red', 'skip'), c('blue', '5')], [c('green', '1'), c('green', '2'), c('green', '3')]],
    top: c('red', '5', 9),
  });
  // playable: red 2, red 9, red skip, blue 5. Skip is worth 20 and wins.
  assert.deepEqual(chooseMove(state, 0, seeded(1)), { type: 'play', cardId: 'red_skip_0' });
  const numbers = mk({
    hands: [[c('red', '2'), c('red', '9'), c('blue', '5')], [c('green', '1'), c('green', '2'), c('green', '3')]],
  });
  assert.deepEqual(chooseMove(numbers, 0, seeded(1)), { type: 'play', cardId: 'red_9_0' });
});

test('bot keeps its wilds while anything else is playable, whatever the dice say', () => {
  const state = mk({ hands: [[wild(), wild4(), c('red', '0')], [c('green', '1'), c('green', '2'), c('green', '3')]] });
  for (let seed = 1; seed <= 60; seed++) {
    // a 0-point card is the worst possible dump, yet still beats any wild
    assert.deepEqual(chooseMove(state, 0, seeded(seed)), { type: 'play', cardId: 'red_0_0' }, `seed ${seed}`);
  }
});

test('bot plays a plain wild before a +4 when only wilds are playable', () => {
  const state = mk({
    hands: [[wild4(), wild(), c('green', '4')], [c('green', '1'), c('green', '2'), c('green', '3')]],
  });
  const move = chooseMove(state, 0, seeded(1));
  assert.equal(move.type, 'play');
  assert.equal(move.type === 'play' && move.cardId, 'wild_0');
});

test('bot picks the colour it holds most of', () => {
  const state = mk({
    hands: [
      [wild(), c('green', '1'), c('green', '2'), c('green', '3'), c('blue', '9'), c('red', '0', 1)],
      [c('red', '1'), c('red', '2'), c('red', '3')],
    ],
    top: c('yellow', '5', 9),
    activeColor: 'yellow',
  });
  assert.deepEqual(chooseMove(state, 0, seeded(1)), { type: 'play', cardId: 'wild_0', chosenColor: 'green' });
});

test('colour choice: ties go to the colour worth more points, then random; wild alone picks any', () => {
  const hand = [c('red', '1'), c('blue', '9')];
  assert.equal(pickColor(hand, null, seeded(1)), 'blue');
  const only = [wild()];
  const seen = new Set<string>();
  for (let i = 1; i <= 60; i++) seen.add(pickColor(only, only[0]!, seeded(i)));
  assert.ok(seen.size > 1, 'should vary when there is nothing to go on');
  // the wild being played is not counted
  assert.equal(pickColor([wild(), c('red', '2')], null, seeded(1)), 'red');
});

test('bot draws when it has nothing playable', () => {
  const state = mk({ hands: [[c('green', '7'), c('yellow', '2')], [c('blue', '1')]] });
  assert.deepEqual(chooseMove(state, 0, seeded(1)), { type: 'draw' });
});

test('bot draws a pending penalty when stacking is off, even with matching cards', () => {
  const state = mk({
    hands: [[c('red', 'draw2'), c('red', '1')], [c('red', '4'), c('red', '5'), c('red', '6')]],
  });
  const afterPlay = applyMove(state, 0, { type: 'play', cardId: 'red_draw2_0' });
  assert.ok(afterPlay.ok);
  if (afterPlay.ok) assert.deepEqual(chooseMove(afterPlay.state, 1, seeded(1)), { type: 'draw' });
});

test('bot stacks a +2 onto a +2 when stacking is on', () => {
  const state = mk({
    stacking: true,
    pending: 2,
    pendingKind: 'draw2',
    top: c('red', 'draw2', 9),
    hands: [[c('red', '1')], [c('green', 'draw2'), c('green', '1'), c('green', '2')]],
    current: 1,
  });
  assert.deepEqual(chooseMove(state, 1, seeded(1)), { type: 'play', cardId: 'green_draw2_0' });
});

test('threat mode: with the next seat on 1-2 cards the bot disrupts instead of dumping a big number', () => {
  const state = mk({
    hands: [[c('red', '9'), c('red', 'draw2')], [c('green', '1')], [c('green', '2'), c('green', '3'), c('green', '4')]],
    top: c('red', '5', 9),
  });
  assert.deepEqual(chooseMove(state, 0, seeded(1)), { type: 'play', cardId: 'red_draw2_0' });
  // ...and with a +4 it will even prefer it to plain numbers
  const w4 = mk({
    hands: [[c('red', '9'), wild4()], [c('green', '1')], [c('green', '2'), c('green', '3'), c('green', '4')]],
  });
  const move = chooseMove(w4, 0, seeded(1));
  assert.equal(move.type === 'play' && move.cardId, 'wild_draw4_0');
  // without a threat the same hand keeps the +4
  const calm = mk({
    hands: [[c('red', '9'), wild4()], [c('green', '1'), c('green', '2'), c('green', '3')], [c('green', '2'), c('green', '3'), c('green', '4')]],
  });
  assert.deepEqual(chooseMove(calm, 0, seeded(1)), { type: 'play', cardId: 'red_9_0' });
});

test('every bot move is legal', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seeded(seed);
    const state = mk({
      hands: [
        [c('red', '3'), c('blue', '7'), wild(), wild4(), c('green', 'skip'), c('yellow', 'reverse')],
        [c('red', '1')],
      ],
      top: c('blue', 'skip', 9),
      activeColor: 'blue',
    });
    const move = chooseMove(state, 0, rng);
    assert.equal(applyMove(state, 0, move, rng).ok, true, JSON.stringify(move));
  }
});
