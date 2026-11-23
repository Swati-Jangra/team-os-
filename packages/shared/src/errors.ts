export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, message: 'Request validation failed' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid email or password' },
  EMAIL_NOT_VERIFIED: { status: 403, message: 'Email address is not verified' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to perform this action' },
  CSRF_FAILED: { status: 403, message: 'CSRF token missing or invalid' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  CONFLICT: { status: 409, message: 'Resource conflict' },
  EMAIL_TAKEN: { status: 409, message: 'An account with this email already exists' },
  SLUG_TAKEN: { status: 409, message: 'This slug is already in use' },
  LAST_OWNER: { status: 409, message: 'An organization must keep at least one owner' },
  TOKEN_INVALID: { status: 400, message: 'Token is invalid or expired' },
  INVITATION_INVALID: { status: 400, message: 'Invitation is invalid, expired or already used' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  AI_UNAVAILABLE: { status: 503, message: 'The AI service is unavailable' },
  INTEGRATION_NOT_CONFIGURED: { status: 503, message: 'This integration is not configured on the server' },
  UPSTREAM_ERROR: { status: 502, message: 'The external service returned an error' },
  INTERNAL: { status: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.details = details;
  }
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}
