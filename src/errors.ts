/**
 * Typed error hierarchy for the MizanCore BaaS SDK.
 *
 * Maps the standard error envelope `{ success:false, message, errors }` onto a
 * structured error carrying the HTTP status, a machine error code, the human
 * message, and the field-level validation errors.
 *
 * Mirrors the PHP SDK's `BaasApiException` (+ Auth/Validation/RateLimit).
 */

export interface ErrorEnvelope {
  success?: boolean;
  message?: string;
  code?: string;
  error_code?: string;
  errors?: Record<string, unknown>;
}

export class BaasApiError extends Error {
  readonly httpStatus: number;
  readonly errorCode: string | null;
  readonly errors: Record<string, unknown>;
  /** The raw decoded response body, when available. */
  readonly body: unknown;

  constructor(
    message: string,
    httpStatus: number,
    errorCode: string | null = null,
    errors: Record<string, unknown> = {},
    body: unknown = undefined,
  ) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.errors = errors;
    this.body = body;
    // Restore prototype chain (TS down-level emit).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Build the correct typed error from an HTTP status + decoded body.
   */
  static fromResponse(status: number, body: unknown): BaasApiError {
    let message = 'MizanCore BaaS API request failed.';
    let errorCode: string | null = null;
    let errors: Record<string, unknown> = {};

    if (body && typeof body === 'object') {
      const env = body as ErrorEnvelope;
      if (typeof env.message === 'string') {
        message = env.message;
      }
      const rawCode = env.code ?? env.error_code;
      if (rawCode != null && (typeof rawCode === 'string' || typeof rawCode === 'number')) {
        errorCode = String(rawCode);
      }
      if (env.errors && typeof env.errors === 'object') {
        errors = env.errors as Record<string, unknown>;
      }
    }

    if (status === 401 || status === 403) {
      return new BaasAuthError(message, status, errorCode, errors, body);
    }
    if (status === 422) {
      return new BaasValidationError(message, status, errorCode, errors, body);
    }
    if (status === 429) {
      return new BaasRateLimitError(message, status, errorCode, errors, body);
    }
    return new BaasApiError(message, status, errorCode, errors, body);
  }
}

/** Raised on 401/403 — invalid/missing X-API-Key, or insufficient scope. */
export class BaasAuthError extends BaasApiError {}

/** Raised on 422 — request failed FormRequest validation; see `.errors`. */
export class BaasValidationError extends BaasApiError {}

/** Raised on 429 — rate limit exceeded (after the SDK exhausted its retries). */
export class BaasRateLimitError extends BaasApiError {}
