/**
 * An HTTP error raised by the API layer itself (auth, validation). Rendered
 * by `ApiExceptionFilter` as `{"detail": ...}` with optional extra headers.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly detail: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
  }
}

export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** 422 with a list of issues, in the same shape for every validation failure. */
export function validationError(issues: ValidationIssue[]): ApiError {
  return new ApiError(422, issues);
}
