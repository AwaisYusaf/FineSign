/**
 * Boot-time environment preparation: an optional local `.env` file, and the
 * "empty means unset" rule for FineSign's own settings.
 *
 * Why this exists: `.env.example` lists every setting, with an empty value
 * meaning "use the default". Both ways an operator actually feeds that file to
 * the server — Docker Compose's `env_file`, and a `.env` next to `npm start` —
 * turn `KEY=` into an empty STRING rather than leaving the key unset. Readers
 * written as `process.env.X ?? default` then see an explicit, invalid choice:
 * `FINESIGN_PADES_LEVEL=""` refused to boot as an unknown level, and an empty
 * poll interval became `Number("") === 0`, a timer that never stops firing.
 * Normalizing once, at the process boundary, keeps every reader's `undefined`
 * check honest instead of teaching each one about empty strings.
 */
import fs from "node:fs";
import util from "node:util";

/** Settings FineSign owns. Only these follow the empty-means-unset rule; the
 *  rest of the environment (PATH, NODE_OPTIONS, …) is never touched. */
export function isFineSignSetting(key: string): boolean {
  return key === "PORT" || key.startsWith("FINESIGN_") || key.startsWith("SMTP_");
}

/**
 * Delete every FineSign setting whose value is the empty string, so it falls
 * back to its documented default. Returns the keys removed.
 */
export function dropEmptySettings(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === "" && isFineSignSetting(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Apply the `KEY=value` lines of a `.env` file to `env`.
 *
 * A variable that already has a non-empty value wins, so a shell export or a
 * container `environment:` entry always overrides the file — the same precedence
 * as Node's own `--env-file`. Empty values in the file are skipped (they mean
 * "default"). Returns the names of the keys the file supplied; never the values,
 * which may be secrets.
 */
export function applyEnvFile(contents: string, env: NodeJS.ProcessEnv): string[] {
  // `util.parseEnv` is Node >= 20.12 (the engines floor). Fail with a clear
  // message rather than a TypeError if someone runs an older runtime.
  if (typeof util.parseEnv !== "function") {
    throw new Error("loading a .env file needs Node >= 20.12 — upgrade Node, or export the variables in your shell instead");
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(util.parseEnv(contents))) {
    if (value === undefined || value === "") continue;
    const current = env[key];
    if (current !== undefined && current !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Read an optional positive-integer setting: `undefined` when unset, the number
 * when valid. Anything else throws, so a typo fails the boot loudly instead of
 * silently falling back to a default the operator did not choose.
 */
export function positiveIntSetting(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name}="${raw}" must be a positive whole number`);
  }
  return Number(raw);
}

/** One `.env` file that was found and applied. */
export interface LoadedEnvFile {
  path: string;
  /** Keys this file supplied (names only). */
  keys: string[];
}

/**
 * Apply every candidate `.env` that exists, in order; an earlier file wins over
 * a later one because already-set keys are never overwritten. A missing file is
 * skipped silently — `.env` is a local convenience, never a requirement (the
 * Docker image ships without one and gets its settings from Compose).
 */
export function loadEnvFiles(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv,
  read: (path: string) => string | undefined = readIfExists
): LoadedEnvFile[] {
  const loaded: LoadedEnvFile[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue; // cwd and the repo root are often the same dir
    seen.add(path);
    const contents = read(path);
    if (contents === undefined) continue;
    loaded.push({ path, keys: applyEnvFile(contents, env) });
  }
  return loaded;
}

/**
 * Boot entry point: load the local `.env` files, honouring `FINESIGN_ENV_FILE`.
 *
 * `FINESIGN_ENV_FILE` is a shell/process variable (it cannot live inside the file
 * it selects): a path loads exactly that file and fails if it is missing; `none`
 * loads nothing. The end-to-end suite sets `none`, so a developer's own `.env`
 * (SMTP credentials, a production seal level) can never reconfigure a test run.
 * Unset, the `defaults` are tried in order and missing ones are skipped.
 */
export function loadLocalEnv(
  env: NodeJS.ProcessEnv,
  defaults: readonly string[],
  read: (path: string) => string | undefined = readIfExists
): LoadedEnvFile[] {
  const override = env.FINESIGN_ENV_FILE;
  if (override === "none") return [];
  if (override !== undefined && override !== "") {
    const loaded = loadEnvFiles([override], env, read);
    if (loaded.length === 0) throw new Error(`FINESIGN_ENV_FILE="${override}" does not exist`);
    return loaded;
  }
  return loadEnvFiles(defaults, env, read);
}

/** Read a file, or `undefined` if it does not exist. Any other error (a
 *  permissions problem, a directory named `.env`) is surfaced, not hidden. */
function readIfExists(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
