// Dropship owns its eBay sync-back state. This published read port gives OMS
// operations health the sync-back issues (plan v4 §10) as read-only SQL
// fragments, without letting it read dropship tables or load the sync runtime.
export { DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS } from "./infrastructure/dropship-marketplace-sync-health.sql";
export type { DropshipMarketplaceSyncHealthCheck } from "./infrastructure/dropship-marketplace-sync-health.sql";
