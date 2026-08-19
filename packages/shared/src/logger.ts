/**
 * A minimal injected logger interface (FACTORY §6: no `console.log` in library
 * code). Server wires a real logger; tests use the silent one.
 */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Discards everything — the default for pure/test contexts. */
export class NullLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Simple JSON-line console logger for local dev/server use. */
export class ConsoleLogger implements Logger {
  info(obj: Record<string, unknown>, msg?: string): void {
    this.write("info", obj, msg);
  }
  warn(obj: Record<string, unknown>, msg?: string): void {
    this.write("warn", obj, msg);
  }
  error(obj: Record<string, unknown>, msg?: string): void {
    this.write("error", obj, msg);
  }
  private write(level: string, obj: Record<string, unknown>, msg?: string): void {
    const line = JSON.stringify({ level, msg, ...obj });
    // Single controlled sink — allowed here, this IS the logger implementation.
    (level === "error" ? console.error : console.log)(line);
  }
}
