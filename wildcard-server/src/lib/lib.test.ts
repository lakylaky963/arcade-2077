import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, parseCreateOptions, parseOptionsPatch } from './options.ts';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  generateRoomCode,
  normalizeRoomCode,
  randomRoomCode,
} from './roomCode.ts';
import { cleanName, uniqueName } from './names.ts';
import { seeded } from '../rules/testkit.ts';

test('create options: defaults, clamping and coercion', () => {
  assert.deepEqual(parseCreateOptions(undefined), DEFAULT_OPTIONS);
  assert.deepEqual(parseCreateOptions(null), DEFAULT_OPTIONS);
  assert.deepEqual(parseCreateOptions('x'), DEFAULT_OPTIONS);
  assert.deepEqual(parseCreateOptions({ seats: 2, stacking: true, turnSeconds: 15 }), { seats: 2, stacking: true, turnSeconds: 15 });
  assert.deepEqual(parseCreateOptions({ seats: '3', turnSeconds: '0' }), { seats: 3, stacking: false, turnSeconds: 0 });
  assert.equal(parseCreateOptions({ seats: 1 }).seats, 4);
  assert.equal(parseCreateOptions({ seats: 9 }).seats, 4);
  assert.equal(parseCreateOptions({ seats: 2.5 }).seats, 4);
  assert.equal(parseCreateOptions({ turnSeconds: 20 }).turnSeconds, DEFAULT_OPTIONS.turnSeconds);
  assert.equal(parseCreateOptions({ stacking: 'yes' }).stacking, false);
});

test('stacking and timer are off/30 by default; the timer offers 15, 30 or off only', () => {
  assert.equal(DEFAULT_OPTIONS.stacking, false);
  assert.equal(DEFAULT_OPTIONS.turnSeconds, 30);
  for (const t of [0, 15, 30]) assert.equal(parseCreateOptions({ turnSeconds: t }).turnSeconds, t);
});

test('options patch keeps only valid fields and never touches seats', () => {
  assert.deepEqual(parseOptionsPatch({ stacking: true }), { stacking: true });
  assert.deepEqual(parseOptionsPatch({ turnSeconds: 15, seats: 2, hack: 1 }), { turnSeconds: 15 });
  assert.deepEqual(parseOptionsPatch({ turnSeconds: 7, stacking: 'on' }), {});
  assert.deepEqual(parseOptionsPatch({ turnSeconds: 0 }), { turnSeconds: 0 });
  assert.deepEqual(parseOptionsPatch(null), {});
});

test('room codes are 5 letters from the safe alphabet', () => {
  const rng = seeded(5);
  for (let i = 0; i < 500; i++) {
    const code = randomRoomCode(rng);
    assert.equal(code.length, ROOM_CODE_LENGTH);
    for (const ch of code) assert.ok(ROOM_CODE_ALPHABET.includes(ch));
    assert.equal(normalizeRoomCode(code), code);
  }
  assert.ok(!/[AEIOUY]/.test(ROOM_CODE_ALPHABET), 'no vowels: no accidental words');
});

test('room code generation skips codes already in use and gives up eventually', () => {
  const rng = seeded(9);
  const first = randomRoomCode(seeded(9));
  const code = generateRoomCode((c) => c === first, rng);
  assert.notEqual(code, first);
  assert.throws(() => generateRoomCode(() => true, rng, 5), /free room code/);
});

test('typed codes are normalised; junk is rejected', () => {
  assert.equal(normalizeRoomCode(' bcd-fg '), 'BCDFG');
  assert.equal(normalizeRoomCode('b c d f g'), 'BCDFG');
  assert.equal(normalizeRoomCode('BCDF'), null);
  assert.equal(normalizeRoomCode('BCDFGH'), null);
  assert.equal(normalizeRoomCode('BCDFA'), null); // vowel
  assert.equal(normalizeRoomCode('BCDF0'), null);
  assert.equal(normalizeRoomCode(12345), null);
  assert.equal(normalizeRoomCode(undefined), null);
});

test('names: trimmed, control and bidi characters removed, 16 chars max, Hebrew kept', () => {
  assert.equal(cleanName('  Avraham  ', 'Guest'), 'Avraham');
  assert.equal(cleanName('a‮b\u0000c​d', 'Guest'), 'abcd');
  assert.equal(cleanName('x'.repeat(40), 'Guest'), 'x'.repeat(16));
  assert.equal(cleanName('אברהם', 'Guest'), 'אברהם');
  assert.equal(cleanName('   ', 'Guest'), 'Guest');
  assert.equal(cleanName(42, 'Guest'), 'Guest');
  assert.equal(cleanName('a   b', 'Guest'), 'a b');
});

test('duplicate names get a number', () => {
  assert.equal(uniqueName('Sam', ['Bot 1']), 'Sam');
  assert.equal(uniqueName('Sam', ['sam']), 'Sam 2');
  assert.equal(uniqueName('Sam', ['Sam', 'Sam 2']), 'Sam 3');
  assert.equal(uniqueName('x'.repeat(16), ['x'.repeat(16)]).length, 16);
});
