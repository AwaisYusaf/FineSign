/**
 * Ports — the interfaces the domain OWNS and adapters implement (hexagonal).
 * The domain never constructs these; the server injects concrete adapters.
 */

import type { Envelope } from "./types";

/** Paging for `EnvelopeRepository.list` (newest first). */
export interface EnvelopeListParams {
  limit?: number;
  offset?: number;
  /** Keyset cursor: only envelopes created before this envelope id. */
  before?: string;
}

/** Persistence for the envelope aggregate (root + documents + recipients +
 *  fields + audit are saved/loaded together). */
export interface EnvelopeRepository {
  create(envelope: Envelope): Promise<void>;
  /**
   * Persist the whole aggregate with OPTIMISTIC CONCURRENCY: the write succeeds
   * only if the stored `version` equals `envelope.version`, then the stored
   * version is incremented. If they differ (a concurrent write happened since
   * this aggregate was loaded), throws a `ConflictError` (code
   * `VERSION_CONFLICT`) instead of silently losing the other update. Atomic.
   */
  save(envelope: Envelope): Promise<void>;
  findById(id: string): Promise<Envelope | null>;
  /** Look up an envelope by a recipient's token hash → (envelope, recipientId). */
  findByRecipientTokenHash(
    tokenHash: string
  ): Promise<{ envelope: Envelope; recipientId: string } | null>;
  /**
   * Newest first (most recently created), so a console's first page shows the
   * latest work.
   *
   * Page back with `before` (the id of the last envelope already shown): only
   * envelopes created before it are returned. Unlike `offset`, that stays put
   * while new envelopes arrive — newest-first offsets shift by one with every
   * create, repeating an item across pages. An unknown `before` id yields an
   * empty page. `offset` still applies, after `before`.
   */
  list(params?: EnvelopeListParams): Promise<Envelope[]>;
  /**
   * `sent` envelopes whose `expiresAt` is strictly before `nowIso`, oldest first,
   * capped at `limit`.
   *
   * A dedicated query rather than a `list()` filter: the expiry sweep runs on a
   * timer forever, and scanning + deserializing every envelope in the store on
   * each tick is O(table) work to find the usually-empty set that is actually
   * due. Adapters are free to index it (the SQL ones do).
   */
  listExpirable(nowIso: string, limit: number): Promise<Envelope[]>;
}

/** Opaque byte storage addressed by key (local FS, S3, …). */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

/** Normalizes a source document to a signable PDF (PDF passthrough, DOCX→PDF). */
export interface DocumentConverter {
  /** True if this converter can handle the given format. */
  supports(format: "pdf" | "docx"): boolean;
  /** Convert source bytes to PDF bytes. Throws if unsupported/unavailable. */
  toPdf(bytes: Uint8Array, format: "pdf" | "docx"): Promise<Uint8Array>;
}

// NOTE: the domain does NOT own a `Mailer` port. Notification delivery is
// expressed as a `NotifyEffect` (see effects.ts) which the server executes; the
// `Mailer` interface therefore lives in the server (its executor), avoiding a
// second, unused notification abstraction in the domain.
