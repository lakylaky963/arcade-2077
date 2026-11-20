// Process-wide services the room needs. Colyseus constructs rooms itself, so
// they cannot take constructor arguments; index.ts configures this once at boot.

import { meUrlFromEnv } from './auth/session.ts';
import { reporterFromEnv, type ResultsReporter } from './reporting/dashboard.ts';
import { createMatchStore, safeStore, type MatchStore } from './storage/matchLog.ts';

export interface Runtime {
  /** Full URL of the dashboard's GET /api/game/me. */
  meUrl: string;
  reporter: ResultsReporter;
  store: MatchStore;
  log: (message: string) => void;
}

let current: Runtime | null = null;

export function configureRuntime(runtime: Runtime): void {
  current = runtime;
}

export function runtime(): Runtime {
  if (current === null) throw new Error('wildcard-server runtime is not configured (call configureRuntime at boot)');
  return current;
}

export async function runtimeFromEnv(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
): Promise<Runtime> {
  const store = safeStore(await createMatchStore(env, log), log);
  return { meUrl: meUrlFromEnv(env), reporter: reporterFromEnv(env), store, log };
}
