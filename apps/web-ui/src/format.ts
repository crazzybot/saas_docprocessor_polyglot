import type { DocumentStatus } from './api';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Elapsed time between two ISO timestamps, e.g. "1.4 s". */
export function formatElapsed(from: string, to: string | null): string {
  if (!to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  queued: 'Queued',
  succeeded: 'Succeeded',
  failed: 'Failed',
};
