/**
 * `@finesign/shared` — cross-cutting primitives used by every FineSign package.
 * Pure (no I/O beyond Node's `crypto` for id/token generation).
 *
 * @packageDocumentation
 */
export {
  FineSignError,
  ValidationError,
  NotFoundError,
  AuthorizationError,
  ConflictError,
  NotImplementedError,
  isFineSignError,
} from "./errors";
export { type Clock, SystemClock, FixedClock } from "./clock";
export {
  type IdGenerator,
  CryptoIdGenerator,
  SeededIdGenerator,
  tokensEqual,
  hashToken,
  sha256Hex,
} from "./ids";
export { type Logger, NullLogger, ConsoleLogger } from "./logger";
