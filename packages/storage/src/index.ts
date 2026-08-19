/**
 * `@finesign/storage` — concrete adapters for the domain's `EnvelopeRepository`
 * and `BlobStore` ports. In-memory for tests/dev; SQLite + local-FS for
 * self-hosting. Both repositories satisfy the shared contract in `./contract`.
 *
 * @packageDocumentation
 */
export { InMemoryEnvelopeRepository } from "./in-memory-repository";
export { SqliteEnvelopeRepository } from "./sqlite-repository";
export { PostgresEnvelopeRepository, type PgQueryable } from "./postgres-repository";
export { InMemoryBlobStore, LocalFsBlobStore } from "./blob-store";
export { runEnvelopeRepositoryContract } from "./contract";
export {
  InMemoryWebhookStore,
  SqliteWebhookStore,
  type WebhookStore,
  type WebhookSubscription,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "./webhook-store";
export { runWebhookStoreContract } from "./webhook-contract";
export {
  EncryptedBlobStore,
  LocalKeyProvider,
  UnknownKeyError,
  keyIdFor,
  seal,
  open,
  isSealed,
  type KeyProvider,
  type DataKey,
  type EncryptedBlobStoreOptions,
} from "./encrypted-blob-store";
