/**
 * Time is an injected dependency (FACTORY §6) so every timestamp, expiry, and
 * audit entry is deterministic in tests.
 */
export interface Clock {
  /** The current instant. */
  now(): Date;
}

/** Production clock — wraps the system time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test clock — starts at a fixed instant and only advances when told to. */
export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  /** Advance the clock by `ms` milliseconds (for expiry tests). */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Jump to an absolute instant. */
  set(instant: Date | string): void {
    this.current = new Date(instant);
  }
}
