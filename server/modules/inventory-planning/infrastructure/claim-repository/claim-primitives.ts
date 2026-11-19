import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  canonicalAvailabilityClaimBuildHandoffResultSchema,
  canonicalAvailabilityClaimOperationExecutionResultSchema,
  canonicalAvailabilityClaimPickResultSchema,
  canonicalAvailabilityClaimReplacementResultSchema,
  canonicalAvailabilityClaimResultSchema,
  type CanonicalAvailabilityClaimBuildHandoffResult,
  type CanonicalAvailabilityClaimOperationExecutionResult,
  type CanonicalAvailabilityClaimPickResult,
  type CanonicalAvailabilityClaimReplacementResult,
  type CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";
import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { AssemblyWorkOwner } from "../../../warehouse/cutover-work.api";
import type { CanonicalClaimBuildMutationPort } from "../../application/canonical-claim-build.port";
import type { CanonicalClaimInventoryMutationPort } from "../../application/canonical-claim-inventory.port";
import type { CanonicalClaimPickerObservationReviewPort } from "../../application/canonical-claim-picker-observation-review.port";

export type ClientPool = Pick<Pool, "connect">;
export type QueryResult = { rows: any[]; rowCount?: number | null };

export const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
export const LEGACY_RESERVATION_LOCK_NAMESPACE = 918410;
export const MAX_GRAPH_PRODUCTS = 1_000;
export const MAX_CYCLE_COUNT_DISPLACED_CLAIMS = 1_000;
export const MAX_SERIALIZATION_ATTEMPTS = 3;
/** Matches the `reason` bound of the canonical claim command schemas. */
export const MAX_COMMAND_REASON_LENGTH = 1000;

export type OrderLine = {
  orderItemId: number;
  targetVariantId: number;
  rootProductId: number;
  requestedQty: number;
};

export type LockedOrder = {
  orderId: number;
  warehouseId: number | null;
  warehouseStatus: string;
  onHold: boolean;
  lines: OrderLine[];
};

export type RuntimeAuthority = {
  activationRunId: bigint;
  revision: bigint;
};

export type ClaimAuditCommand = {
  actor: string;
  reason: string;
};

export type ClaimLifecycleDisposition = "release" | "cancel" | "supersede";

export type PersistedClaim = {
  id: bigint;
  claimKey: string;
  orderId: number;
  revision: number;
  runtimeAuthorityRevision: bigint;
  planHash: string;
  plan: ClaimPlanDto;
};

export type FulfillmentClaim = PersistedClaim & {
  status: "active" | "released" | "cancelled" | "superseded" | "failed";
};

export type FulfillmentClaimLot = {
  id: bigint;
  inventoryLotId: number;
  claimedQty: bigint;
  releasedQty: bigint;
  consumedQty: bigint;
  pickedQty: bigint;
  unitCostMills: bigint;
  poUnitCostMills: bigint;
  packagingUnitCostMills: bigint;
  landedUnitCostMills: bigint;
};

export type FulfillmentClaimResource = {
  id: bigint;
  inventoryLevelId: number;
  warehouseId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  claimedQty: bigint;
  releasedQty: bigint;
  consumedQty: bigint;
  pickedQty: bigint;
  lots: FulfillmentClaimLot[];
};

export type FulfillmentClaimLine = {
  id: bigint;
  orderItemId: number;
  targetVariantId: number;
  plannedQty: bigint;
  releasedTargetQty: bigint;
  consumedTargetQty: bigint;
  pickedTargetQty: bigint;
  resources: FulfillmentClaimResource[];
};

export type ClaimRepositoryDependencies = {
  readonly inventoryWriter: CanonicalClaimInventoryMutationPort;
  readonly connectionPool: ClientPool;
  readonly clock: () => Date;
  readonly buildWriter?: CanonicalClaimBuildMutationPort;
  readonly observationReviewWriter?: CanonicalClaimPickerObservationReviewPort;
  readonly workOwner?: AssemblyWorkOwner;
  readonly lockCostGraph: (client: PoolClient) => Promise<void>;
  readonly isPackageConversionInline: (
    client: PoolClient,
    input: {
      destinationVariantId: number;
      warehouseId: number;
      outputQty: bigint;
      method: "case_break" | "package_conversion";
    },
  ) => Promise<boolean>;
};

export class InventoryAvailabilityClaimRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityClaimRepositoryError";
  }
}

export function rows(result: QueryResult): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

export function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

export function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

export function positiveBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= BigInt(0)) throw new Error("not positive");
    return parsed;
  } catch (cause) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive bigint`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export function nonnegativeBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0)) throw new Error("negative");
    return parsed;
  } catch (cause) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative bigint`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export function databaseText(value: unknown, field: string, maximum: number): string {
  const parsed = String(value ?? "").trim();
  if (parsed.length === 0 || parsed.length > maximum) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be nonblank and no longer than ${maximum} characters`,
      { field, value },
    );
  }
  return parsed;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code === "40001"
    || code === "40P01"
    || code === "INVENTORY_LEVEL_CREATION_CONFLICT"
    || code === "CYCLE_COUNT_CLAIM_SET_CHANGED"
    || code === "CYCLE_COUNT_ORDER_DEMAND_CHANGED"
    || code === "CYCLE_COUNT_TRANSFORMATION_GRAPH_CHANGED") return true;
  return code === "23505"
    && String((error as { constraint?: unknown })?.constraint ?? "")
      === "availability_claim_commands_idempotency_uq";
}

export async function rollback(client: PoolClient, originalError: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Canonical claim transaction and rollback both failed.",
    );
  }
  throw originalError;
}

export function openResourceQty(resource: FulfillmentClaimResource): bigint {
  return resource.claimedQty - resource.releasedQty - resource.consumedQty - resource.pickedQty;
}

export function openLotQty(lot: FulfillmentClaimLot): bigint {
  return lot.claimedQty - lot.releasedQty - lot.consumedQty - lot.pickedQty;
}

export function resultFromClaim(
  orderId: number,
  claim: PersistedClaim,
  idempotentReplay: boolean,
): CanonicalAvailabilityClaimResult {
  return canonicalAvailabilityClaimResultSchema.parse({
    outcome: "claimed",
    claimId: claim.id.toString(),
    claimKey: claim.claimKey,
    orderId,
    revision: claim.revision,
    runtimeAuthorityRevision: claim.runtimeAuthorityRevision.toString(),
    plan: claim.plan,
    idempotentReplay,
  });
}

export function replacementResult(
  supersededClaim: PersistedClaim,
  replacementClaim: PersistedClaim,
  released: { releasedResourceQty: bigint; releasedLotQty: bigint },
  idempotentReplay: boolean,
): CanonicalAvailabilityClaimReplacementResult {
  return canonicalAvailabilityClaimReplacementResultSchema.parse({
    outcome: "replaced",
    orderId: supersededClaim.orderId,
    supersededClaimId: supersededClaim.id.toString(),
    supersededClaimKey: supersededClaim.claimKey,
    supersededRevision: supersededClaim.revision,
    replacementClaim: {
      claimId: replacementClaim.id.toString(),
      claimKey: replacementClaim.claimKey,
      revision: replacementClaim.revision,
      runtimeAuthorityRevision: replacementClaim.runtimeAuthorityRevision.toString(),
      plan: replacementClaim.plan,
    },
    releasedResourceQty: released.releasedResourceQty.toString(),
    releasedLotQty: released.releasedLotQty.toString(),
    idempotentReplay,
  });
}

export async function loadCommandReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimResult | null> {
  const row = rows(await client.query(
    `SELECT request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical claim idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

export async function loadReplacementReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimReplacementResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== "replace" || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical claim replacement idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimReplacementResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

export async function loadOperationExecutionReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
  expectedCommandType: "execute" | "execute_build",
): Promise<CanonicalAvailabilityClaimOperationExecutionResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== expectedCommandType || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical operation idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimOperationExecutionResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

export async function loadBuildHandoffReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimBuildHandoffResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== "handoff_build" || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical build-handoff idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimBuildHandoffResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

export async function loadPickReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
  expectedCommandType: "pick" | "pick_observation" | "unpick",
): Promise<CanonicalAvailabilityClaimPickResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== expectedCommandType || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical fulfillment idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimPickResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}
