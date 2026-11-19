/**
 * Order-action projection persistence store, worker, and scheduler composition facade (CI-03).
 */
export { PostgresOrderActionProjectionStore } from "./infrastructure/order-action-projection.repository";
export {
  createOrderActionProjectionWorker,
  startOrderActionProjectionScheduler,
  type OrderActionProjectionReport,
} from "./infrastructure/order-action-projection.composition";
