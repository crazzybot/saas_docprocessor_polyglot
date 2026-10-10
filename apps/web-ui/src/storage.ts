/**
 * Per-browser conveniences only (the last tenant used). Storage can be
 * unavailable (private windows, blocked site data), so failures are ignored.
 */

const PREFIX = 'docprocessor-web-ui:';

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Not persisted; the value still applies to this page.
  }
}
