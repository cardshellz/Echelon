/**
 * Published internal Inventory interface for Warehouse Work Execution,
 * Assembly Packing Readiness, and WMS Recipe Build Promise workflows.
 */
export { lockPackingReplenishmentBlockers } from "./application/packing-replenishment-reader";
export { BuildDomainError } from "./domain/build.domain";
export { CanonicalClaimInventoryMutationError } from "./infrastructure/canonical-claim-inventory.repository";
export type { BuildUseCases } from "./application/build.use-cases";
export type { BuildOrderCompletedContext } from "./infrastructure/build-execution.repository";
export { RecipeCapacityError, type RecipeDemandPlan } from "./domain/recipe-capacity.domain";
export type { RecipeCapacityService } from "./recipe-capacity.service";
