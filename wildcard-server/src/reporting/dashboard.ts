// Reports finished matches to the dashboard (CT 105).
//
// STUB INTERFACE: step C builds the receiving endpoint in landingPage. Until
// then DASHBOARD_RESULTS_URL is unset and the reporter only logs. The contract
// (body = MatchResult, auth = service token, idempotent on matchId) is in the
// README under "Results contract".

import type { FetchLike } from '../auth/session.ts';
import { defaultFetch } from '../auth/session.ts';
import type { MatchResult, ReportOutcome } from '../types.ts';

export interface ResultsReporter {
  report(result: MatchResult): Promise<ReportOutcome>;
}

/** Used when no endpoint is configured yet. */
export class NoopReporter implements ResultsReporter {
  private readonly reason: string;
  constructor(reason = 'DASHBOARD_RESULTS_URL / DASHBOARD_SERVICE_TOKEN not set') {
    this.reason = reason;
  }
  async report(): Promise<ReportOutcome> {
    return { status: 'skipped', reason: this.reason };
  }
}

export interface HttpReporterOptions {
  url: string;
  /** Service token. Sent as `Authorization: Bearer <token>`. Never logged. */
  token: string;
  fetchImpl?: FetchLike;
  /** Delays between attempts; its length + 1 is the attempt count. */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS = [1000, 4000] as const;
const DEFAULT_TIMEOUT_MS = 5000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 2xx = sent. 429 and 5xx and network errors are retried; any other status is final. */
export class HttpResultsReporter implements ResultsReporter {
  private readonly o: Required<Omit<HttpReporterOptions, 'fetchImpl'>> & { fetchImpl: FetchLike };

  constructor(options: HttpReporterOptions) {
    this.o = {
      url: options.url,
      token: options.token,
      fetchImpl: options.fetchImpl ?? defaultFetch(),
      retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      sleep: options.sleep ?? defaultSleep,
    };
  }

  async report(result: MatchResult): Promise<ReportOutcome> {
    const attemptsAllowed = this.o.retryDelaysMs.length + 1;
    const body = JSON.stringify(result);
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      let retryable = true;
      try {
        const status = await this.post(body, result.matchId);
        if (status >= 200 && status < 300) return { status: 'sent', attempts: attempt };
        lastError = `HTTP ${status}`;
        retryable = status === 429 || status >= 500;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (!retryable) return { status: 'failed', attempts: attempt, error: lastError };
      if (attempt < attemptsAllowed) await this.o.sleep(this.o.retryDelaysMs[attempt - 1] as number);
    }
    return { status: 'failed', attempts: attemptsAllowed, error: lastError };
  }

  private async post(body: string, matchId: string): Promise<number> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error('timeout'));
      }, this.o.timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.o.fetchImpl(this.o.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.o.token}`,
            'idempotency-key': matchId,
          },
          body,
          signal: controller?.signal,
        }),
        timeout,
      ]);
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function reporterFromEnv(env: Record<string, string | undefined>): ResultsReporter {
  const url = env.DASHBOARD_RESULTS_URL;
  const token = env.DASHBOARD_SERVICE_TOKEN;
  if (url && token) return new HttpResultsReporter({ url, token });
  return new NoopReporter();
}
