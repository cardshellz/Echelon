/**
 * Published internal Inventory interface for Shipment Quantity Evidence,
 * Shipment Runtime Authority, and Operational Shipment Dispatch.
 */
export { shipmentQuantityEvidenceProjection } from "./infrastructure/shipment-quantity-evidence.sql";
export { readSourceShipmentPostedQuantity } from "./domain/source-shipment-quantity-evidence";
export {
  loadAndLockShipmentRuntimeAuthority,
  ReplacementInventoryUnavailableError,
  ShipmentInventoryUnavailableError,
  type InventoryUseCases,
  type RecordInventoryShipmentInput,
  type RecordReplacementInventoryShipmentInput,
} from "./application/inventory.use-cases";
export {
  OperationalShipmentError,
  operationalShipmentRequestSchema,
  type OperationalShipmentSource,
  type OperationalShipmentRequest,
  type OperationalShipmentResult,
} from "./domain/operational-shipment-dispatch";
export type {
  OperationalShipmentSourceOwner,
  OperationalShipmentDispatcher,
  OperationalShipmentBeforeCommit,
} from "./application/operational-shipment-dispatch.port";
