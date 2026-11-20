// Display names: strip anything that can break layouts or spoof other players.

const MAX_NAME_LENGTH = 16;

// control chars, zero-width and bidi override/isolate marks
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function cleanName(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const name = Array.from(input.replace(UNSAFE, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return name.length > 0 ? name : fallback;
}

/** `name`, or `name 2`, `name 3`... when `taken` already has it (case-insensitive). */
export function uniqueName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const candidate = Array.from(name).slice(0, MAX_NAME_LENGTH - suffix.length).join('').trimEnd() + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
