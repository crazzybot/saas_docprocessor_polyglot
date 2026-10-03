/** Small async primitives for the services' background loops. */

/**
 * Resolve after `ms` milliseconds, or as soon as `signal` aborts (without
 * throwing), so loops can sleep between iterations yet stop promptly.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A wake-up flag: `wait` resolves when `notify` is called (or was called
 * since the last `clear`), when the timeout elapses, or when `signal` aborts.
 */
export class WakeSignal {
  private notified = false;
  private waiters: Array<() => void> = [];

  notify(): void {
    this.notified = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  clear(): void {
    this.notified = false;
  }

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.notified) {
      return;
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const woken = new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      await Promise.race([woken, sleep(timeoutMs, controller.signal)]);
    } finally {
      controller.abort(); // cancel the timer
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Reject with a TimeoutError if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(`timed out after ${ms} ms`, 'TimeoutError')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
