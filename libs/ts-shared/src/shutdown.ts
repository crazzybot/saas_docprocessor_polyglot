/** Graceful shutdown on SIGTERM / SIGINT. */

import { getLogger } from './logging.js';

const logger = getLogger('shared.shutdown');

/**
 * Run `close` once on SIGTERM or SIGINT, then exit (0, or 1 if `close`
 * threw).
 *
 * The exit is explicit because in a container Node usually runs as PID 1,
 * for which the kernel ignores signals that have no handler: re-raising
 * the signal after cleanup (as Nest's `enableShutdownHooks` does) would leave
 * the process running until the kubelet's SIGKILL.
 */
export function exitOnSignals(close: () => Promise<void>): void {
  let closing = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info('shutdown_signal_received', { signal });
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('shutdown_failed', {}, error);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
