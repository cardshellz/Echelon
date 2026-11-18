/**
 * Inventory Planning — Runtime Availability & Channel Quantity Internal API (`CI-03`)
 *
 * Published cross-module interface for authority-aware ATP readers,
 * channel quantity runtime readers, and shared runtime authority locks
 * (`channels`, `dropship`, `inventory`).
 */
export {
  createAuthorityAwareInventoryAtpService,
  loadAndLockRuntimeAuthority,
  PostgresInventoryAvailabilityRuntimeAtpExecutor,
  type PostgresInventoryAvailabilityRuntimeTransaction,
} from "./infrastructure/inventory-availability-runtime-atp.repository";
export {
  createAuthorityAwareInventoryPublicationService,
  createInventoryChannelQuantityRuntimeService,
} from "./infrastructure/inventory-availability-runtime-publication.repository";
export {
  AuthorityAwareInventoryAtpService,
  InventoryAvailabilityRuntimeAtpError,
  type InventoryAvailabilityRuntimeAuthority,
} from "./application/inventory-availability-runtime-atp.service";
export {
  InventoryChannelQuantityRuntimeError,
  InventoryChannelQuantityRuntimeService,
} from "./application/inventory-channel-quantity-runtime.service";
