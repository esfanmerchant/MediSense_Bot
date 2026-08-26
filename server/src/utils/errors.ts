/**
 * Application error codes returned to clients.
 *
 * The client only ever sees a code and a human-readable message — never a
 * stack trace, a database error or a provider response (spec §37).
 */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN_RESOURCE: 'FORBIDDEN_RESOURCE',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  DUPLICATE_INVOICE: 'DUPLICATE_INVOICE',
  UNSUPPORTED_FILE: 'UNSUPPORTED_FILE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  field?: string;
  message: string;
}

/** An error that is safe to show a user. Anything else becomes INTERNAL_ERROR. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: ErrorDetail[];
  readonly expose = true;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]) =>
  new AppError(400, ErrorCode.BAD_REQUEST, message, details);

export const validationFailed = (details: ErrorDetail[]) =>
  new AppError(422, ErrorCode.VALIDATION_ERROR, 'The submitted data is invalid.', details);

export const unauthenticated = (message = 'Sign in to continue.') =>
  new AppError(401, ErrorCode.UNAUTHENTICATED, message);

export const sessionExpired = (
  message = 'Your session expired after a period of inactivity. Sign in again to continue.',
) => new AppError(401, ErrorCode.SESSION_EXPIRED, message);

export const invalidCredentials = () =>
  // Deliberately identical for unknown email and wrong password: distinguishing
  // them turns the login form into an account-enumeration oracle.
  new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');

export const forbidden = (message = 'You are not authorized to access this resource.') =>
  new AppError(403, ErrorCode.UNAUTHORIZED, message);

export const forbiddenResource = (message = 'You do not have access to this patient’s data.') =>
  new AppError(403, ErrorCode.FORBIDDEN_RESOURCE, message);

export const notFound = (what = 'Resource') =>
  new AppError(404, ErrorCode.NOT_FOUND, `${what} was not found.`);

export const conflict = (message: string, code: ErrorCodeValue = ErrorCode.CONFLICT) =>
  new AppError(409, code, message);

export const serviceUnavailable = (message: string) =>
  new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message);

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
