/**
 * Internal API facade for marketplace channel sync batch persistence (CI-03 / CHN-2).
 *
 * Peer modules (e.g. `channels`) must import `PostgresChannelSyncBatchRepository`
 * through this facade rather than reaching into
 * `marketplace-listings/infrastructure/*`.
 */

export {
  PostgresChannelSyncBatchRepository,
} from "./infrastructure/pg-channel-sync-batch.repository";
