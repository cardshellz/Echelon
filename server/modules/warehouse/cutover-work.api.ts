/**
 * Internal module API facade: Warehouse Source Cutover & Assembly Work Owner (`CI-03`).
 *
 * Cross-module consumers (e.g., `inventory-planning`) must import warehouse
 * source activation and assembly work owner contracts through this boundary
 * rather than reaching into `warehouse/infrastructure/*`, `warehouse/domain/*`,
 * or `warehouse/work/*` internals.
 */

export type { AssemblyWorkOwner } from "./work/application/assembly-work-owner";

export {
  activateReviewedWarehouseSourcesInsideTransaction,
  readWarehouseSourceActivationEvidence,
} from "./infrastructure/warehouse-source-activation.repository";

export { validateWarehouseSourceActivation } from "./domain/warehouse-source-activation";
