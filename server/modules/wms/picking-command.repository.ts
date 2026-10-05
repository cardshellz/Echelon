import { createHash } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { orderItems, type OrderItem } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { IntegrityError, ValidationError } from "@shared/errors";
import type { db } from "../../db";
import type { CanonicalClaimTransactionClient } from "../inventory-planning/application/canonical-claim-inventory.port";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import {
  canonicalAvailabilityClaimPickCommandSchema,
  canonicalAvailabilityClaimUnpickCommandSchema,
  canonicalAvailabilityClaimPickResultSchema,
} from "@shared/types/inventory-availability-claims";

export type PickingCommandTransaction = Pick<
  typeof db,
  "select" | "update" | "insert" | "delete"
> & {
  execute(
    query: ReturnType<typeof sql>,
  ): PromiseLike<{ rows: Record<string, unknown>[] }>;
};
type Transaction = PickingCommandTransaction;
type Database = Transaction & {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
};
const keySchema = z.string().regex(/^wms-(pick|unpick):[a-f0-9-]{36}$/);
export const pickingReceiptItemSchema = createSelectSchema(orderItems).extend({
  pickedAt: z.coerce.date().nullable(),
});
const beforeSchema = pickingReceiptItemSchema;
const requestSchema = z
  .object({
    action: z.enum(["pick", "unpick"]),
    itemId: z.number().int().positive(),
    actor: z.string().min(1),
    params: z.record(z.unknown()),
  })
  .strict();
const recordSchema = z
  .object({
    command_key: keySchema,
    request_payload: requestSchema,
    order_id: z.number().int().positive(),
    order_item_id: z.number().int().positive(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    before_item: beforeSchema,
    canonical_request: z.record(z.unknown()).nullable(),
    physical_receipt: z.record(z.unknown()).nullable(),
    followup_result: z.record(z.unknown()).nullable(),
    committed_at: z.coerce.date().nullable(),
    completed_at: z.coerce.date().nullable(),
  })
  .passthrough();
export type PickingCommandRecord = z.infer<typeof recordSchema>;

function timestamp(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new ValidationError("Invalid picking command clock");
  return now;
}
export function pickingCommandKey(
  action: "pick" | "unpick",
  commandId: string,
): string {
  return keySchema.parse(
    `wms-${action}:${z.string().uuid().parse(commandId).toLowerCase()}`,
  );
}

export async function readPickingCommand(
  database: Transaction,
  key: string,
): Promise<PickingCommandRecord | null> {
  keySchema.parse(key);
  const result = await database.execute(
    sql`SELECT * FROM wms.picking_commands WHERE command_key=${key}`,
  );
  return result.rows.length === 0 ? null : recordSchema.parse(result.rows[0]);
}

/** Freeze the original server snapshot before execution; retries never recompute an intent from changed progress. */
export async function preparePickingCommand(
  database: Database,
  key: string,
  request: z.input<typeof requestSchema>,
  clock: () => Date,
): Promise<PickingCommandRecord> {
  keySchema.parse(key);
  const payload = requestSchema.parse(request);
  if (!key.startsWith(`wms-${payload.action}:`))
    throw new ValidationError(
      "Picking command action differs from its identity",
    );
  const {
    deviceType: _device,
    sessionId: _session,
    ...intent
  } = payload.params;
  const requestHash = createHash("sha256")
    .update(canonicalJson({ ...payload, params: intent }))
    .digest("hex");
  return database.transaction(async (tx) => {
    const existing = await readPickingCommand(tx, key);
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new IntegrityError(
          "Picking command identity was reused with different input",
          { reason: "picking_command_conflict", commandKey: key },
        );
      return existing;
    }
    const [item] = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, payload.itemId))
      .limit(1);
    if (!item)
      throw new IntegrityError("Picking command item does not exist", {
        orderItemId: payload.itemId,
      });
    await tx.execute(sql`INSERT INTO wms.picking_commands(command_key,order_id,order_item_id,request_hash,request_payload,before_item,created_at)
      VALUES (${key},${item.orderId},${item.id},${requestHash},${JSON.stringify(payload)}::jsonb,${JSON.stringify(item)}::jsonb,${timestamp(clock)})
      ON CONFLICT(command_key) DO NOTHING`);
    const stored = await readPickingCommand(tx, key);
    if (!stored || stored.request_hash !== requestHash)
      throw new IntegrityError("Concurrent picking command input conflict", {
        commandKey: key,
      });
    return stored;
  });
}

export async function freezeCanonicalPickingRequest(
  database: Database,
  key: string,
  rawRequest: Record<string, unknown>,
  claimRefresh?: { fromClaimId: string; toClaimId: string; occurredAt: Date },
): Promise<Record<string, unknown>> {
  keySchema.parse(key);
  const request = (
    key.startsWith("wms-pick:")
      ? canonicalAvailabilityClaimPickCommandSchema
      : canonicalAvailabilityClaimUnpickCommandSchema
  ).parse(rawRequest);
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT command_key FROM wms.picking_commands WHERE command_key=${key} FOR UPDATE`,
    );
    await tx.execute(sql`UPDATE wms.picking_commands SET canonical_request=${JSON.stringify(request)}::jsonb
      WHERE command_key=${key} AND canonical_request IS NULL AND physical_receipt IS NULL`);
    const command = await readPickingCommand(tx, key);
    if (!command?.canonical_request)
      throw new IntegrityError("Canonical picking request was not recorded", {
        commandKey: key,
      });
    if (
      request.idempotencyKey !== key ||
      request.orderItemId !== command.order_item_id ||
      request.actor !== command.request_payload.actor
    )
      throw new IntegrityError(
        "Canonical picking request differs from its prepared identity",
        { commandKey: key },
      );
    const frozen = command.canonical_request;
    if (command.physical_receipt || key.startsWith("wms-unpick:"))
      return frozen;
    if (claimRefresh) {
      z.date().parse(claimRefresh.occurredAt);
      const { claimId: originalClaim, ...originalIntent } = frozen;
      const { claimId: nextClaim, ...nextIntent } = request;
      if (
        originalClaim !== claimRefresh.fromClaimId ||
        nextClaim !== claimRefresh.toClaimId ||
        frozen.locationStrategy !== "strict" ||
        canonicalJson(originalIntent) !== canonicalJson(nextIntent)
      ) {
        throw new IntegrityError(
          "The refreshed claim changed the frozen physical pick intent",
          { commandKey: key },
        );
      }
      // Only the existing server refresh path can advance a claim after its
      // strict pick rolled back. No source, quantity, actor or WMS work changes.
      await tx.execute(
        sql`UPDATE wms.picking_commands SET canonical_request=${JSON.stringify(request)}::jsonb WHERE command_key=${key} AND physical_receipt IS NULL`,
      );
      await persistAuditEvent(
        tx,
        {
          actor: request.actor,
          action: "wms.picking_command_claim_refreshed",
          target: key,
          changes: {
            before: { claimId: originalClaim },
            after: { claimId: nextClaim },
          },
        },
        { timestamp: claimRefresh.occurredAt },
      );
      return request;
    }
    // The same source, claim and WMS before/after intent survive strategy retries.
    // Only the server's existing authorized reconciliation sequence may advance.
    const strategies = [
      "strict",
      "reconcile_recorded_stock",
      "reconcile_picker_observation",
    ];
    const nextStrategy = strategies.indexOf(
      String(
        "locationStrategy" in request ? request.locationStrategy : undefined,
      ),
    );
    const previousStrategy = strategies.indexOf(
      String(frozen.locationStrategy),
    );
    if (previousStrategy < 0 || nextStrategy < 0)
      throw new IntegrityError("Invalid canonical picker strategy", {
        commandKey: key,
      });
    if (nextStrategy <= previousStrategy) return frozen;
    const {
      locationStrategy: _strategy,
      observation: _observation,
      ...originalIntent
    } = frozen;
    const nextPick: Record<string, unknown> = request;
    const {
      locationStrategy: _next,
      observation: _nextObservation,
      ...nextIntent
    } = nextPick;
    if (canonicalJson(originalIntent) !== canonicalJson(nextIntent))
      throw new IntegrityError(
        "Canonical picker intent changed during reconciliation",
        { commandKey: key },
      );
    const advanced = {
      ...frozen,
      locationStrategy: nextPick.locationStrategy,
      ...(nextPick.observation ? { observation: nextPick.observation } : {}),
    };
    await tx.execute(sql`UPDATE wms.picking_commands SET canonical_request=${JSON.stringify(advanced)}::jsonb
      WHERE command_key=${key} AND physical_receipt IS NULL`);
    return advanced;
  });
}

/** Existing physical owners serialize movement and receipt writes. Do not hold
 * an extra pool connection while asking those owners to start a transaction. */
export async function executePickingCommand<T>(
  database: Database,
  key: string,
  work: (command: PickingCommandRecord) => Promise<T>,
): Promise<T> {
  const command = await readPickingCommand(database, key);
  if (!command)
    throw new IntegrityError("Picking command intent disappeared", {
      commandKey: key,
    });
  return work(command);
}

export async function commitPickingReceipt(
  tx: Transaction,
  key: string,
  receipt: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  keySchema.parse(key);
  z.date().parse(occurredAt);
  const item = pickingReceiptItemSchema.parse(receipt.item);
  const result =
    await tx.execute(sql`UPDATE wms.picking_commands SET physical_receipt=${JSON.stringify(receipt)}::jsonb, committed_at=${occurredAt}
    WHERE command_key=${key} AND order_id=${item.orderId} AND order_item_id=${item.id} AND physical_receipt IS NULL RETURNING command_key`);
  if (result.rows.length !== 1)
    throw new IntegrityError(
      "Picking command receipt already exists or intent is missing",
      { commandKey: key },
    );
}

/** Called only by the canonical transaction owner, alongside its movement and command receipt. */
export async function commitCanonicalPickingReceipt(
  client: CanonicalClaimTransactionClient,
  key: string,
  receipt: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  if (!key.startsWith("wms-pick:") && !key.startsWith("wms-unpick:")) return;
  keySchema.parse(key);
  z.date().parse(occurredAt);
  const request = (
    key.startsWith("wms-pick:")
      ? canonicalAvailabilityClaimPickCommandSchema
      : canonicalAvailabilityClaimUnpickCommandSchema
  ).parse(receipt.canonicalRequest);
  const pickResult = canonicalAvailabilityClaimPickResultSchema.parse(
    receipt.canonicalResult,
  );
  if (
    request.orderItemId !== pickResult.orderItemId ||
    request.idempotencyKey !== key
  )
    throw new IntegrityError(
      "Canonical receipt identity differs from its command",
      { commandKey: key },
    );
  const result = await client.query(
    `UPDATE wms.picking_commands SET physical_receipt=$2::jsonb, committed_at=$3
    WHERE command_key=$1 AND order_id=$4 AND order_item_id=$5 AND request_payload->>'actor'=$6 AND physical_receipt IS NULL RETURNING command_key`,
    [
      key,
      JSON.stringify(receipt),
      occurredAt,
      pickResult.orderId,
      pickResult.orderItemId,
      request.actor,
    ],
  );
  if (result.rows.length !== 1)
    throw new IntegrityError(
      "Canonical picking intent is missing, mismatched or already committed",
      { commandKey: key },
    );
}

/** Replay stable effects outside a transaction, then serialize result and WMS projection together. */
export async function deliverPickingFollowup<
  TSchema extends z.ZodType<Record<string, unknown>>,
>(
  database: Database,
  key: string,
  handler: (command: PickingCommandRecord) => Promise<unknown>,
  resultSchema: TSchema,
  clock: () => Date,
  onDelivered?: (
    tx: Transaction,
    command: PickingCommandRecord,
  ) => Promise<void>,
): Promise<z.output<TSchema> | null> {
  try {
    const snapshot = await readPickingCommand(database, key);
    if (!snapshot?.physical_receipt) return null;
    if (snapshot.completed_at)
      return resultSchema.parse(snapshot.followup_result);
    const result = resultSchema.parse(await handler(snapshot));
    return await database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT command_key FROM wms.picking_commands WHERE command_key=${key} FOR UPDATE`,
      );
      const command = await readPickingCommand(tx, key);
      if (!command?.physical_receipt)
        throw new IntegrityError("Committed picking evidence disappeared", {
          commandKey: key,
        });
      if (command.completed_at)
        return resultSchema.parse(command.followup_result);
      await tx.execute(sql`UPDATE wms.picking_commands SET followup_result=${JSON.stringify(result)}::jsonb,
        completed_at=${timestamp(clock)},last_error=NULL,attempt_count=attempt_count+1 WHERE command_key=${key}`);
      if (onDelivered) await onDelivered(tx, command);
      return result;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.execute(sql`UPDATE wms.picking_commands SET last_error=${message.slice(0, 2000)},attempt_count=attempt_count+1
      WHERE command_key=${key} AND completed_at IS NULL`);
    console.error(
      JSON.stringify({
        event: "picking_followup_pending",
        commandKey: key,
        message,
      }),
    );
    return null;
  }
}

export async function pendingPickingCommandKeys(
  database: Transaction,
  limit = 20,
): Promise<string[]> {
  z.number().int().positive().max(100).parse(limit);
  const result =
    await database.execute(sql`SELECT command_key FROM wms.picking_commands
    WHERE physical_receipt IS NOT NULL AND completed_at IS NULL ORDER BY committed_at,command_key LIMIT ${limit}`);
  return result.rows.map((row) => keySchema.parse(row.command_key));
}

export function pickingCommandBeforeItem(
  command: PickingCommandRecord,
): OrderItem {
  return beforeSchema.parse(command.before_item) as OrderItem;
}
