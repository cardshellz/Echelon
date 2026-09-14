import { and, eq, sql } from "drizzle-orm";

import { idempotencyKeys, syncSettings } from "@shared/schema";
import {
  inventoryPublicationGlobalControlResultSchema,
  type InventoryPublicationGlobalControlResult,
} from "@shared/types/inventory-publication-global-control";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import type {
  InventoryPublicationGlobalControlCommand,
  InventoryPublicationGlobalControlStore,
} from "../application/inventory-publication-global-control.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE } from "./quantity-publication-admission.repository";

type Database = typeof db;
export type InventoryPublicationGlobalControlTransaction = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

const IDEMPOTENCY_LOCK_NAMESPACE = 918420;
const RECEIPT_PREFIX = "inventory-publication-global-control:";

export class PostgresInventoryPublicationGlobalControlStore
implements InventoryPublicationGlobalControlStore {
  constructor(private readonly database: Database = db) {}

  async change(
    command: InventoryPublicationGlobalControlCommand,
  ): Promise<InventoryPublicationGlobalControlResult> {
    return this.database.transaction((transaction) =>
      applyInventoryPublicationGlobalControlInsideTransaction(transaction, command));
  }
}

/**
 * Applies the switch through the transaction that owns both the exclusive
 * provider-admission fence and the settings row. The legacy control route uses
 * this entry point inside its authority-pinned transaction so no second pool
 * client can observe or mutate a different authority epoch.
 */
export async function applyInventoryPublicationGlobalControlInsideTransaction(
  transaction: InventoryPublicationGlobalControlTransaction,
  command: InventoryPublicationGlobalControlCommand,
): Promise<InventoryPublicationGlobalControlResult> {
  const receiptKey = `${RECEIPT_PREFIX}${command.idempotencyKey}`;
  await transaction.execute(sql`
    SELECT pg_advisory_xact_lock(${IDEMPOTENCY_LOCK_NAMESPACE}, hashtext(${receiptKey}))
  `);
  const replay = await loadReplay(transaction, receiptKey, command.requestHash);
  if (replay) return replay;

  const acquired = rows(await transaction.execute(sql`
    SELECT pg_try_advisory_xact_lock(${QUANTITY_PUBLICATION_LOCK_NAMESPACE}, 0) AS acquired
  `))[0]?.acquired === true;
  if (!acquired) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "PUBLICATION_GLOBAL_CONTROL_BUSY",
      "A quantity publication is in flight. Retry after it finishes; the control was not changed.",
    );
  }

  const settingsRows = rows(await transaction.execute(sql`
    SELECT id, global_enabled, sweep_interval_minutes, revision
    FROM channels.sync_settings
    WHERE singleton_key = TRUE
    FOR UPDATE
  `));
  if (settingsRows.length !== 1) {
    throw new InventoryAvailabilityMasterDataError(
      503,
      "PUBLICATION_GLOBAL_CONTROL_INVALID",
      "Exactly one global publication-control row is required; no setting was changed.",
      [`rowCount: ${settingsRows.length}`],
    );
  }
  const current = settingsRows[0]!;
  const currentRevision = positiveRevision(current.revision);
  if (currentRevision !== command.expectedRevision) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "PUBLICATION_GLOBAL_CONTROL_STALE",
      "The global publication control changed. Reload it before trying again.",
    );
  }
  const before = {
    globalEnabled: current.global_enabled === true,
    sweepIntervalMinutes: boundedInterval(current.sweep_interval_minutes),
    revision: currentRevision,
  };
  const after = {
    globalEnabled: command.globalEnabled ?? before.globalEnabled,
    sweepIntervalMinutes: command.sweepIntervalMinutes ?? before.sweepIntervalMinutes,
  };
  if (
    before.globalEnabled === after.globalEnabled
    && before.sweepIntervalMinutes === after.sweepIntervalMinutes
  ) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "PUBLICATION_GLOBAL_CONTROL_UNCHANGED",
      "The global publication control already has the requested values.",
    );
  }

  await transaction.insert(idempotencyKeys).values({
    key: receiptKey,
    requestHash: command.requestHash,
    responseBody: null,
    createdAt: command.occurredAt,
    expiresAt: null,
  });
  const updated = await transaction.update(syncSettings).set({
    globalEnabled: after.globalEnabled,
    sweepIntervalMinutes: after.sweepIntervalMinutes,
    revision: sql`${syncSettings.revision} + 1`,
    changedBy: command.actorId,
    changeReason: command.changeReason,
    updatedAt: command.occurredAt,
  }).where(and(
    eq(syncSettings.singletonKey, true),
    eq(syncSettings.revision, BigInt(currentRevision)),
  )).returning({ revision: syncSettings.revision });
  if (updated.length !== 1) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "PUBLICATION_GLOBAL_CONTROL_CONCURRENT_CHANGE",
      "A concurrent publication-control change prevented this command. Reload and retry.",
    );
  }

  const result = inventoryPublicationGlobalControlResultSchema.parse({
    ...after,
    revision: updated[0]!.revision.toString(),
    changedBy: command.actorId,
    changeReason: command.changeReason,
    changedAt: command.occurredAt.toISOString(),
    alreadyApplied: false,
  });
  await persistAuditEvent(transaction, {
    actor: command.actorId,
    action: "inventory_availability.publication_global_control.changed",
    target: "channels.sync_settings:global",
    changes: { before, after: { ...after, revision: result.revision } },
    context: {
      reason: command.changeReason,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
    },
  }, { timestamp: command.occurredAt, emitStructuredLog: false });
  await transaction.update(idempotencyKeys).set({
    responseBody: { commandType: "inventory_publication_global_control_change", result },
  }).where(eq(idempotencyKeys.key, receiptKey));
  return result;
}

async function loadReplay(
  transaction: InventoryPublicationGlobalControlTransaction,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationGlobalControlResult | null> {
  const receipt = (await transaction.select({
    requestHash: idempotencyKeys.requestHash,
    responseBody: idempotencyKeys.responseBody,
  }).from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey)).limit(1))[0];
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "PUBLICATION_GLOBAL_CONTROL_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different inputs.",
    );
  }
  const response = receipt.responseBody as Record<string, unknown> | null;
  const parsed = inventoryPublicationGlobalControlResultSchema.safeParse(response?.result);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "PUBLICATION_GLOBAL_CONTROL_RECEIPT_INVALID",
      "The prior publication-control command has an incomplete receipt.",
    );
  }
  return { ...parsed.data, alreadyApplied: true };
}

function rows(result: unknown): Record<string, any>[] {
  if (Array.isArray(result)) return result as Record<string, any>[];
  if (result && typeof result === "object" && "rows" in result) {
    const value = (result as { rows?: unknown }).rows;
    if (Array.isArray(value)) return value as Record<string, any>[];
  }
  return [];
}

function positiveRevision(value: unknown): string {
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text)) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "PUBLICATION_GLOBAL_CONTROL_REVISION_INVALID",
      "The stored publication-control revision is invalid.",
    );
  }
  return text;
}

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_440) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "PUBLICATION_GLOBAL_CONTROL_INTERVAL_INVALID",
      "The stored publication-control sweep interval is invalid.",
    );
  }
  return parsed;
}
