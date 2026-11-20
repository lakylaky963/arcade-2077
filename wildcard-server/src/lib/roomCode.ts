// 5-letter room codes. Consonants only: no accidental words, and no O/0, I/1 mix-ups.

import type { Rng } from '../rules/uno.ts';

export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const ROOM_CODE_LENGTH = 5;

const VALID = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function randomRoomCode(rng: Rng = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** A code nobody else is using right now. Throws if `isTaken` rejects every attempt. */
export function generateRoomCode(
  isTaken: (code: string) => boolean,
  rng: Rng = Math.random,
  maxAttempts = 100,
): string {
  for (let i = 0; i < maxAttempts; i++) {
    const code = randomRoomCode(rng);
    if (!isTaken(code)) return code;
  }
  throw new Error('could not find a free room code');
}

/** What a player typed -> the canonical code, or null if it cannot be one. */
export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]+/g, '').toUpperCase();
  return VALID.test(code) ? code : null;
}
