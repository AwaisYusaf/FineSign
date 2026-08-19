/**
 * In-memory `EnvelopeRepository` — the zero-config default (tests, local dev).
 * Stores DEEP CLONES so a caller can never mutate the store by holding a
 * returned reference, and reads return clones for the same reason.
 */
import type { Envelope, EnvelopeRepository } from "@finesign/domain";
import { ConflictError } from "@finesign/shared";

function clone(env: Envelope): Envelope {
  return structuredClone(env);
}

export class InMemoryEnvelopeRepository implements EnvelopeRepository {
  private readonly store = new Map<string, Envelope>();
  private readonly order: string[] = [];

  async create(envelope: Envelope): Promise<void> {
    if (this.store.has(envelope.id)) {
      throw new Error(`envelope ${envelope.id} already exists`);
    }
    this.store.set(envelope.id, clone(envelope));
    this.order.push(envelope.id);
  }

  async save(envelope: Envelope): Promise<void> {
    const existing = this.store.get(envelope.id);
    if (existing && existing.version !== envelope.version) {
      throw new ConflictError(
        "VERSION_CONFLICT",
        `envelope ${envelope.id} was modified concurrently (expected version ${envelope.version}, found ${existing.version})`
      );
    }
    if (!existing) this.order.push(envelope.id);
    this.store.set(envelope.id, clone({ ...envelope, version: envelope.version + 1 }));
  }

  async findById(id: string): Promise<Envelope | null> {
    const e = this.store.get(id);
    return e ? clone(e) : null;
  }

  async findByRecipientTokenHash(
    tokenHash: string
  ): Promise<{ envelope: Envelope; recipientId: string } | null> {
    for (const id of this.order) {
      const env = this.store.get(id)!;
      const rec = env.recipients.find((r) => r.tokenHash === tokenHash);
      if (rec) return { envelope: clone(env), recipientId: rec.id };
    }
    return null;
  }

  async list(params?: { limit?: number; offset?: number }): Promise<Envelope[]> {
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? this.order.length;
    return this.order
      .slice(offset, offset + limit)
      .map((id) => clone(this.store.get(id)!));
  }
}
