import { describe, expect, it } from 'vitest';

import { describeError } from '../src/api';

describe('describeError', () => {
  it('shows an ErrorResponse detail', () => {
    expect(describeError(415, { detail: 'Unsupported content type' })).toBe('415: Unsupported content type');
  });

  it('lists ValidationErrorResponse issues with their location', () => {
    const body = {
      detail: [
        { loc: ['body', 'tags', 0], msg: 'Too short', type: 'too_small' },
        { loc: [], msg: 'Bad', type: 'x' },
      ],
    };
    expect(describeError(422, body)).toBe('422: body.tags.0: Too short; Bad');
  });

  it('falls back to a text body, then to the status alone', () => {
    expect(describeError(502, 'Bad gateway')).toBe('502: Bad gateway');
    expect(describeError(500, undefined)).toBe('500: request failed');
  });
});
