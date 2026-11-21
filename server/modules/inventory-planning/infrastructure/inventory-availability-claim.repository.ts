import type { PoolClient } from "pg";

import type {
  CanonicalAvailabilityClaimBuildHandoffCommand,
  CanonicalAvailabilityClaimBuildHandoffResult,
  CanonicalAvailabilityClaimCommand,
  CanonicalAvailabilityClaimDisplacementCommand,
  CanonicalAvailabilityClaimDisplacementResult,
  CanonicalAvailabilityClaimOperationExecutionCommand,
  CanonicalAvailabilityClaimOperationExecutionResult,
  CanonicalAvailabilityClaimPickCommand,
  CanonicalAvailabilityClaimPickResult,
  CanonicalAvailabilityClaimReleaseCommand,
  CanonicalAvailabilityClaimReplacementCommand,
  CanonicalAvailabilityClaimReplacementResult,
  CanonicalAvailabilityClaimResult,
  CanonicalAvailabilityClaimUnpickCommand,
  CanonicalAvailabilityCycleCountReconciliationCommand,
  CanonicalAvailabilityCycleCountReconciliationResult,
  CanonicalAvailabilityReservationStatusCommand,
  CanonicalAvailabilityReservationStatusProjection,
} from "@shared/types/inventory-availability-claims";
import { canonicalJson } from "@shared/utils/canonical-json";
import { pool } from "../../../db";
import { InventoryQuantityError } from "../../inventory/domain/quantity-ledger";
import { costEvidenceTransactionFromPg } from "../../inventory/infrastructure/cost-evidence-pg";
import { lockInventoryCostGraph } from "../../inventory/infrastructure/cost-evidence.repository";
import type { AssemblyWorkOwner } from "../../warehouse/cutover-work.api";
import type { CanonicalClaimBuildMutationPort } from "../application/canonical-claim-build.port";
import type {
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimTransactionClient,
} from "../application/canonical-claim-inventory.port";
import type { CanonicalClaimPickerObservationReviewPort } from "../application/canonical-claim-picker-observation-review.port";
import type { InventoryAvailabilityClaimStore } from "../application/inventory-availability-claim.port";
import {
  executeReconcileCycleCount,
  selectCycleCountDisplacedClaims,
  type CycleCountOpenClaimAtLevel,
} from "./claim-repository/claim-cycle-count";
import { executeDisplaceForConfirmedShipment } from "./claim-repository/claim-displacement-operations";
import {
  executeBuildClaimOperation,
  executeHandoffBuildOperation,
  executePackageClaimOperation,
} from "./claim-repository/claim-operation-commands";
import {
  loadClaimById,
  loadClaimProductIds,
  lockGraphProducts,
  requireCanonicalAuthority,
} from "./claim-repository/claim-order-and-locks";
import {
  executeClaimOrder,
  executeReleaseOrderClaim,
  executeReplaceOrderClaim,
} from "./claim-repository/claim-order-commands";
import {
  executePickClaimLine,
  executeUnpickClaimLine,
} from "./claim-repository/claim-pick-commands";
import {
  InventoryAvailabilityClaimRepositoryError,
  MAX_GRAPH_PRODUCTS,
  positiveInteger,
  rows,
  uniqueSorted,
  type ClaimRepositoryDependencies,
  type ClientPool,
} from "./claim-repository/claim-primitives";
import {
  executeGetReservationStatus,
  persistReconstructedCutoverClaim,
} from "./claim-repository/claim-status-and-cutover";

export {
  InventoryAvailabilityClaimRepositoryError,
  persistReconstructedCutoverClaim,
  selectCycleCountDisplacedClaims,
  type CycleCountOpenClaimAtLevel,
};

// Bound the transaction's locked orders while leaving ordinary free-stock moves unchanged.
const MAX_TRANSFER_CLAIMS = 500;

/**
 * Inventory's transfer transaction already holds the shared cost graph lock.
 * Reuse the claim owner's validated model graph and lock hierarchy before any
 * inventory row is locked. No connection or transaction is opened here.
 */
export async function lockCanonicalClaimsForInventoryTransfer(
  rawClient: CanonicalClaimTransactionClient,
  input: { productVariantId: number; fromLocationId: number; toLocationId: number },
): Promise<void> {
  // The adapter exposes only query; these helpers never use PoolClient lifecycle methods.
  const client = rawClient as PoolClient;
  await requireCanonicalAuthority(client);
  const discover = async () => rows(await client.query(
    `SELECT DISTINCT claim.id::text, claim.order_id
     FROM inventory.availability_claims claim
     JOIN inventory.availability_claim_resources resource ON resource.claim_id=claim.id
     WHERE claim.status='active' AND resource.source_variant_id=$1 AND resource.warehouse_location_id=$2
       AND resource.claimed_qty-resource.released_qty-resource.consumed_qty-resource.picked_qty>0
     ORDER BY claim.order_id,claim.id::text LIMIT $3`,
    [input.productVariantId, input.fromLocationId, MAX_TRANSFER_CLAIMS + 1],
  ));
  const preliminary = await discover();
  if (preliminary.length > MAX_TRANSFER_CLAIMS) {
    throw new InventoryQuantityError(
      "TRANSFER_CLAIM_LIMIT",
      "This bin has too many reservations for one transfer; review its orders first.",
    );
  }
  const products = new Set<number>();
  for (const row of preliminary) {
    const claim = await loadClaimById(client, BigInt(row.id), false);
    if (!claim || claim.status !== "active") {
      throw new InventoryQuantityError("TRANSFER_CLAIM_CHANGED", "The bin's reservations changed. Refresh and retry.");
    }
    for (const productId of await loadClaimProductIds(client, claim)) products.add(productId);
  }
  const variant = rows(await client.query(
    "SELECT product_id FROM catalog.product_variants WHERE id=$1",
    [input.productVariantId],
  ))[0];
  if (!variant) throw new InventoryQuantityError("TRANSFER_VARIANT_MISSING", "The transfer SKU no longer exists.");
  products.add(positiveInteger(variant.product_id, "transfer.productId"));
  if (products.size > MAX_GRAPH_PRODUCTS) {
    throw new InventoryQuantityError(
      "TRANSFER_CLAIM_GRAPH_LIMIT",
      "The reservations span too many product models for one transfer; review their orders first.",
    );
  }
  await lockGraphProducts(client, [...products].sort((a, b) => a - b));
  await client.query(
    `SELECT warehouse_location_id FROM inventory.location_promise_policy_heads
     WHERE warehouse_location_id=ANY($1::int[]) ORDER BY warehouse_location_id FOR SHARE`,
    [[input.fromLocationId, input.toLocationId].sort((a, b) => a - b)],
  );
  for (const orderId of uniqueSorted(preliminary.map((row) => positiveInteger(row.order_id, "transfer.orderId")))) {
    await client.query("SELECT id FROM wms.orders WHERE id=$1 FOR UPDATE", [orderId]);
    await client.query("SELECT id FROM wms.order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [orderId]);
  }
  for (const row of preliminary) {
    const claim = await loadClaimById(client, BigInt(row.id), true);
    if (!claim || claim.status !== "active") {
      throw new InventoryQuantityError("TRANSFER_CLAIM_CHANGED", "The bin's reservations changed. Refresh and retry.");
    }
  }
  if (canonicalJson(preliminary) !== canonicalJson(await discover())) {
    throw new InventoryQuantityError("TRANSFER_CLAIM_CHANGED", "The bin's reservations changed. Refresh and retry.");
  }
}

export class PostgresInventoryAvailabilityClaimRepository implements InventoryAvailabilityClaimStore {
  constructor(
    private readonly inventoryWriter: CanonicalClaimInventoryMutationPort,
    private readonly connectionPool: ClientPool = pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly buildWriter?: CanonicalClaimBuildMutationPort,
    private readonly observationReviewWriter?: CanonicalClaimPickerObservationReviewPort,
    private readonly workOwner?: AssemblyWorkOwner,
  ) {}

  private deps(): ClaimRepositoryDependencies {
    return {
      inventoryWriter: this.inventoryWriter,
      connectionPool: this.connectionPool,
      clock: this.clock,
      buildWriter: this.buildWriter,
      observationReviewWriter: this.observationReviewWriter,
      workOwner: this.workOwner,
      lockCostGraph: (client) => lockInventoryCostGraph(costEvidenceTransactionFromPg(client)),
    };
  }

  async getReservationStatus(
    rawCommand: CanonicalAvailabilityReservationStatusCommand,
  ): Promise<CanonicalAvailabilityReservationStatusProjection> {
    return executeGetReservationStatus(this.deps(), rawCommand);
  }

  async claimOrder(
    rawCommand: CanonicalAvailabilityClaimCommand,
  ): Promise<CanonicalAvailabilityClaimResult> {
    return executeClaimOrder(this.deps(), rawCommand);
  }

  async replaceOrderClaim(
    rawCommand: CanonicalAvailabilityClaimReplacementCommand,
  ): Promise<CanonicalAvailabilityClaimReplacementResult> {
    return executeReplaceOrderClaim(this.deps(), rawCommand);
  }

  async displaceForConfirmedShipment(
    rawCommand: CanonicalAvailabilityClaimDisplacementCommand,
  ): Promise<CanonicalAvailabilityClaimDisplacementResult> {
    return executeDisplaceForConfirmedShipment(this.deps(), rawCommand);
  }

  async reconcileCycleCount(
    rawCommand: CanonicalAvailabilityCycleCountReconciliationCommand,
  ): Promise<CanonicalAvailabilityCycleCountReconciliationResult> {
    return executeReconcileCycleCount(this.deps(), rawCommand);
  }

  async pickClaimLine(
    rawCommand: CanonicalAvailabilityClaimPickCommand,
  ): Promise<CanonicalAvailabilityClaimPickResult> {
    return executePickClaimLine(this.deps(), rawCommand);
  }

  async unpickClaimLine(
    rawCommand: CanonicalAvailabilityClaimUnpickCommand,
  ): Promise<CanonicalAvailabilityClaimPickResult> {
    return executeUnpickClaimLine(this.deps(), rawCommand);
  }

  async handoffBuildOperation(
    rawCommand: CanonicalAvailabilityClaimBuildHandoffCommand,
  ): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
    return executeHandoffBuildOperation(this.deps(), rawCommand);
  }

  async executeBuildOperation(
    rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    return executeBuildClaimOperation(this.deps(), rawCommand);
  }

  async executePackageOperation(
    rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    return executePackageClaimOperation(this.deps(), rawCommand);
  }

  async releaseOrderClaim(
    rawCommand: CanonicalAvailabilityClaimReleaseCommand,
  ): Promise<CanonicalAvailabilityClaimResult> {
    return executeReleaseOrderClaim(this.deps(), rawCommand);
  }
}
