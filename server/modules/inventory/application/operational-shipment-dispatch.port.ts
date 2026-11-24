import type { InventoryAvailabilityTransactionQueryClient } from "../../inventory-planning/inventory-availability-transaction-query.port.api";
import type { OperationalShipmentRequest, OperationalShipmentResult, OperationalShipmentSource } from "../domain/operational-shipment-dispatch";
export interface OperationalShipmentSourceOwner {
  lockSource(client: InventoryAvailabilityTransactionQueryClient, request: OperationalShipmentRequest): Promise<OperationalShipmentSource>;
}
export interface OperationalShipmentDispatcher {
  dispatch(request: OperationalShipmentRequest): Promise<OperationalShipmentResult>;
}
export type OperationalShipmentBeforeCommit = (input: {
  client: InventoryAvailabilityTransactionQueryClient;
  request: OperationalShipmentRequest;
  inventoryTransactionId: number;
}) => Promise<void>;
