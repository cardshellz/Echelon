/**
 * Internal API facade for legacy eBay maintenance evidence reads (CI-03 / CHN-2).
 *
 * Peer modules (e.g. `inventory-planning`) must import
 * `PostgresEbayLegacyMaintenanceEvidenceReader` through this facade rather
 * than reaching into `channels/infrastructure/*`.
 */

export {
  PostgresEbayLegacyMaintenanceEvidenceReader,
} from "./infrastructure/ebay-legacy-maintenance-evidence";
