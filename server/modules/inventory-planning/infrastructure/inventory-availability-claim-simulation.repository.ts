import type { Pool, PoolClient } from "pg";

import type {
  ClaimSupplySnapshotDto,
  ClaimPlanDto,
  ClaimPlanRequestDto,
} from "@shared/types/inventory-availability-planner";
import {
  plannerClaimSimulationRunSchema,
  type PlannerClaimSimulationRun,
} from "@shared/types/inventory-availability-phase4";

import { pool } from "../../../db";
import { parseClaimSupplySnapshot } from "../domain/inventory-availability-planner";
import type {
  InventoryAvailabilityClaimSimulationStore,
  PersistClaimSimulationInput,
} from "../application/inventory-availability-claim-simulation.service";

type ClientPool = Pick<Pool, "connect">;

export class InventoryAvailabilityClaimSimulationRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityClaimSimulationRepositoryError";
  }
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Classified below.
    }
  }
  throw new InventoryAvailabilityClaimSimulationRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    `${field} must be a JSON object.`,
    { field },
  );
}

function iso(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new InventoryAvailabilityClaimSimulationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a timestamp.`,
      { field, value },
    );
  }
  return parsed.toISOString();
}

function validateInput(input: PersistClaimSimulationInput): PersistClaimSimulationInput & {
  snapshot: ClaimSupplySnapshotDto;
  claim: ClaimPlanRequestDto;
  plan: ClaimPlanDto;
} {
  const snapshot = parseClaimSupplySnapshot(input.snapshot);
  if (input.plan.snapshotFingerprint !== snapshot.snapshotFingerprint) {
    throw new InventoryAvailabilityClaimSimulationRepositoryError(
      "CLAIM_PLAN_SNAPSHOT_MISMATCH",
      "The claim plan does not reference the captured supply snapshot.",
    );
  }
  if (input.claim.requestKey !== input.plan.requestKey) {
    throw new InventoryAvailabilityClaimSimulationRepositoryError(
      "CLAIM_PLAN_REQUEST_MISMATCH",
      "The claim plan does not reference the captured request.",
    );
  }
  if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
    throw new InventoryAvailabilityClaimSimulationRepositoryError(
      "INVALID_COMPLETION_TIME",
      "Claim-simulation completion time must be a valid Date.",
    );
  }
  return { ...input, snapshot };
}

function mapRun(row: Record<string, any>, alreadyApplied: boolean): PlannerClaimSimulationRun {
  return plannerClaimSimulationRunSchema.parse({
    simulationRunId: String(row.id),
    requestHash: String(row.request_hash),
    requestedBy: String(row.requested_by),
    reason: String(row.reason),
    capturedAt: iso(row.captured_at, "claimSimulation.capturedAt"),
    completedAt: iso(row.completed_at, "claimSimulation.completedAt"),
    claim: jsonObject(row.request_payload, "claimSimulation.requestPayload"),
    plan: jsonObject(row.plan_payload, "claimSimulation.planPayload"),
    legacyLivePathRetained: true,
    operationalWriteAttempted: false,
    alreadyApplied,
  });
}

async function inTransaction<T>(
  connectionPool: ClientPool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Claim-simulation persistence and rollback both failed.",
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresInventoryAvailabilityClaimSimulationRepository
implements InventoryAvailabilityClaimSimulationStore {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async persistClaimSimulation(input: PersistClaimSimulationInput): Promise<PlannerClaimSimulationRun> {
    const validated = validateInput(input);
    return inTransaction(this.connectionPool, async (client) => {
      const inserted = (await client.query<{ id: string }>(
        `INSERT INTO inventory.planner_claim_simulation_runs (
           request_key, request_hash, request_payload, root_product_ids,
           snapshot_fingerprint, snapshot_payload, plan_status, plan_payload,
           blocker_codes, idempotency_key, reason, requested_by,
           operational_write_attempted, captured_at, completed_at
         ) VALUES (
           $1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb,
           $9::jsonb, $10, $11, $12, false, $13, $14
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          validated.claim.requestKey,
          validated.requestHash,
          JSON.stringify(validated.claim),
          JSON.stringify(validated.snapshot.rootProducts.map((root) => root.productId)),
          validated.snapshot.snapshotFingerprint,
          JSON.stringify(validated.snapshot),
          validated.plan.status,
          JSON.stringify(validated.plan),
          JSON.stringify([...new Set(validated.plan.blockers.map((blocker) => blocker.code))].sort()),
          validated.idempotencyKey,
          validated.reason,
          validated.requestedBy,
          validated.snapshot.capturedAt,
          validated.completedAt.toISOString(),
        ],
      )).rows[0];

      const row = (await client.query<Record<string, any>>(
        `SELECT id, request_hash, request_payload, plan_payload, requested_by,
                reason, captured_at, completed_at
         FROM inventory.planner_claim_simulation_runs
         WHERE id = COALESCE($1::bigint, (
           SELECT id FROM inventory.planner_claim_simulation_runs WHERE idempotency_key = $2
         ))
         FOR SHARE`,
        [inserted?.id ?? null, validated.idempotencyKey],
      )).rows[0];
      if (!row) {
        throw new InventoryAvailabilityClaimSimulationRepositoryError(
          "IDEMPOTENCY_CONFLICT_NOT_VISIBLE",
          "The idempotency key conflicted but the existing claim simulation was not visible.",
          { idempotencyKey: validated.idempotencyKey },
        );
      }
      if (String(row.request_hash) !== validated.requestHash) {
        throw new InventoryAvailabilityClaimSimulationRepositoryError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key already belongs to a different claim simulation request.",
          { idempotencyKey: validated.idempotencyKey },
        );
      }
      return mapRun(row, !inserted);
    });
  }
}
