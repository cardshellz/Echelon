/**
 * Pure schemas and port contracts for customer order-action projections (CI-03).
 * Free of infrastructure, database singleton, and HTTP interface imports so CLI dry runs
 * and read-model adapters can validate options without opening database connections.
 */
export {
  orderActionMaintenanceIdsSchema,
  type OrderActionProjectionReader,
  type OrderActionScope,
} from "./application/order-action-projection.ports";
