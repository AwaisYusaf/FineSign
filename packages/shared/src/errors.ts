/**
 * The typed-error base for all of FineSign. Every domain/adapter/server error
 * carries a STABLE `code` (screaming-snake) that the HTTP layer maps to a status
 * in exactly one place — so error handling never depends on message strings.
 *
 * FACTORY §6: "Never throw bare strings." Throw a `FineSignError` subclass.
 */
export class FineSignError extends Error {
  /** Stable, machine-readable code, e.g. "ENVELOPE_NOT_FOUND". */
  readonly code: string;
  /** Suggested HTTP status (the server may override in its single mapper). */
  readonly httpStatus: number;
  /** Optional structured context (never contains secrets). */
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // Restore prototype chain when compiled to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** 400 — caller sent something invalid. */
export class ValidationError extends FineSignError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, 400, details);
  }
}

/** 404 — the referenced entity does not exist. */
export class NotFoundError extends FineSignError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, 404, details);
  }
}

/** 403 — the principal may not perform this action. */
export class AuthorizationError extends FineSignError {
  constructor(message = "Not authorized", details?: Record<string, unknown>) {
    super("FORBIDDEN", message, 403, details);
  }
}

/** 409 — the action conflicts with current state (e.g. illegal transition). */
export class ConflictError extends FineSignError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

/** 501 — a code path that is intentionally not built yet (FACTORY §1.5). */
export class NotImplementedError extends FineSignError {
  constructor(what: string) {
    super("NOT_IMPLEMENTED", `${what} is not implemented`, 501);
  }
}

/** Type guard for the error handler. */
export function isFineSignError(e: unknown): e is FineSignError {
  return e instanceof FineSignError;
}
