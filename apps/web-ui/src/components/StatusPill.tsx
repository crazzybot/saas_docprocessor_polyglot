import type { DocumentStatus } from '../api';
import { STATUS_LABEL } from '../format';

export function StatusPill({ status }: { status: DocumentStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}
