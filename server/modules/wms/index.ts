/**
 * @echelon/wms — Warehouse Execution, Order Items, Picking Commands, Shipments & Returns (`CI-03`)
 */
export * from "./order-intake-and-items.api";
export * from "./picking-execution.api";
export * from "./pick-corrections-and-holds.api";
export * from "./shipment-execution-and-projection.api";
export * from "./assembly-and-packing.api";
export * from "./returns-receipt.api";
export * from "./cutover-and-dispatch.api";

export interface WmsApi {
  readonly recipeBuildPromise: import("./assembly-and-packing.api").RecipeBuildPromiseService;
  readonly dispatchSourceOwner: import("./cutover-and-dispatch.api").WmsCanonicalClaimDispatchSourceOwner;
  readonly operationalShipmentSourceOwner: import("./cutover-and-dispatch.api").WmsOperationalShipmentSourceOwner;
}
