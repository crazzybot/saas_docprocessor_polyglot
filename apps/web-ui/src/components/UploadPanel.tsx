import { useRef, useState } from 'react';

import { uploadDocument, type Api, type Document } from '../api';
import { formatBytes } from '../format';

/** What the API accepts (MAX_UPLOAD_SIZE_MB and the content sniffing are enforced there). */
const ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

interface Attempt {
  readonly key: number;
  readonly name: string;
  readonly size: number;
  readonly state: 'uploading' | 'done' | 'error';
  readonly message?: string;
  readonly docId?: string;
}

export function UploadPanel({ api, onUploaded }: { api: Api; onUploaded: (doc: Document) => void }) {
  const [attempts, setAttempts] = useState<readonly Attempt[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const upload = (files: Iterable<File>) => {
    for (const file of files) {
      const key = nextKey.current++;
      const update = (change: Partial<Attempt>) =>
        setAttempts((all) => all.map((a) => (a.key === key ? { ...a, ...change } : a)));
      setAttempts((all) =>
        [{ key, name: file.name, size: file.size, state: 'uploading' as const }, ...all].slice(0, 8),
      );
      uploadDocument(api, file).then(
        (doc) => {
          update({ state: 'done', docId: doc.doc_id });
          onUploaded(doc);
        },
        (error: unknown) => update({ state: 'error', message: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  return (
    <div className="panel">
      <h2>Upload</h2>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') input.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          upload(event.dataTransfer.files);
        }}
      >
        <strong>Drop files here</strong> or click to choose
        <span className="hint">PDF, DOCX, PNG or JPEG</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      {attempts.length > 0 && (
        <ul className="attempts">
          {attempts.map((a) => (
            <li key={a.key} className={a.state}>
              <span className="name">{a.name}</span>
              <span className="muted">{formatBytes(a.size)}</span>
              <span className="state">
                {a.state === 'uploading' && 'Uploading…'}
                {a.state === 'done' && 'Accepted (202)'}
                {a.state === 'error' && a.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
