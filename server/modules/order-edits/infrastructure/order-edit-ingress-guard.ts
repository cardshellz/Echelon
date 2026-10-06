import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { wmsOmsOrderIdSql } from "../../oms/oms-wms-order-link.sql";
import { orderEditSnapshotSchema } from "../application/order-edit-provider.schema";
import type { OrderEditSnapshot } from "../application/order-edit-provider";
import { acquireOrderEditWarehouseHold } from "../../wms/order-edit-hold.commands";
import { enqueueShipStationHoldSyncInTransaction } from "../../oms/shipstation-hold-retry.command";
import { OrderEditError } from "../domain/order-edit-error";

interface Transaction {
  execute(statement: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}
export interface OrderEditIngressDecision {
  skipLines: boolean;
  skipOrder: boolean;
}
const allow = { skipLines: false, skipOrder: false };
const skip = { skipLines: true, skipOrder: true };
const binding = wmsOmsOrderIdSql({
  source: sql.raw("wo.source"),
  omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
  legacySourceTableId: sql.raw("wo.source_table_id"),
});
const payloadSchema = z.object({
  updated_at: z.string().datetime({ offset: true }),
  financial_status: z.string().optional(),
  cancelled_at: z.unknown().optional(),
  current_total_price: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
  line_items: z.array(
    z.object({
      id: z.union([z.string(), z.number().int().safe()]),
      variant_id: z.union([z.string(), z.number().int().safe()]).nullable(),
      current_quantity: z.number().int().nonnegative().safe(),
      price: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    }),
  ),
});
function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
}

/** Matching fulfillment/tracking events may advance metadata, never regrant old purchased quantities. */
export function matchesCertifiedOrderEditContent(
  payload: unknown,
  snapshot: OrderEditSnapshot,
): boolean {
  const parsed = payloadSchema.safeParse(payload);
  if (
    !parsed.success ||
    cents(parsed.data.current_total_price) !== BigInt(snapshot.totalCents)
  )
    return false;
  const expected = new Map(
    snapshot.lines.map((line) => [
      line.id.replace(/^gid:\/\/shopify\/LineItem\//, ""),
      line,
    ]),
  );
  const seen = new Set<string>();
  for (const line of parsed.data.line_items) {
    const id = String(line.id);
    const current = expected.get(id);
    if (
      seen.has(id) ||
      (!current && line.current_quantity !== 0) ||
      (current &&
        (line.current_quantity !== current.quantity ||
          (current.quantity > 0 &&
            (String(line.variant_id) !==
              current.variantId.replace(
                /^gid:\/\/shopify\/ProductVariant\//,
                "",
              ) ||
              cents(line.price) !== BigInt(current.originalUnitPriceCents)))))
    )
      return false;
    seen.add(id);
    expected.delete(id);
  }
  return ![...expected.values()].some((line) => line.quantity > 0);
}

/** Call inside the writer's transaction BEFORE locking/writing OMS lines. */
export async function guardOrderEditShopifyIngress(
  tx: Transaction,
  omsOrderId: number,
  payload: unknown,
  now: Date,
): Promise<OrderEditIngressDecision> {
  z.number().int().positive().safe().parse(omsOrderId);
  z.date().parse(now);
  await tx.execute(
    sql`SELECT id FROM oms.oms_orders WHERE id=${omsOrderId} FOR UPDATE`,
  );
  const result = await tx.execute(
    sql`SELECT operation_id,source_updated_at,snapshot FROM oms.order_edit_paid_projections WHERE oms_order_id=${omsOrderId}`,
  );
  if (!result.rows.length) return allow;
  const projection = result.rows[0];
  const snapshot = orderEditSnapshotSchema.parse(projection.snapshot);
  const raw =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const observed =
    typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
  const certified = z.coerce
    .date()
    .parse(projection.source_updated_at)
    .getTime();
  // Unknown/older observations have no authority to supersede certified state.
  if (!Number.isFinite(observed) || observed < certified) return skip;
  const orders =
    await tx.execute(sql`SELECT wo.id,wo.order_edit_operation_id,wo.started_at,wo.assigned_picker_id,wo.picked_count,wo.warehouse_status
    FROM wms.orders wo WHERE ${binding}=${omsOrderId} ORDER BY wo.id FOR UPDATE OF wo`);
  const operations =
    await tx.execute(sql`SELECT id,status,document,version,connection_id FROM oms.order_edit_operations
    WHERE oms_order_id=${omsOrderId} AND status NOT IN ('completed','recovered','expired','failed') FOR UPDATE`);
  const active = operations.rows[0];
  const activeDocument = active?.document as
    | { baseline?: { fingerprint?: string } }
    | undefined;
  const newOwnedEdit =
    active &&
    active.id !== projection.operation_id &&
    activeDocument?.baseline?.fingerprint === snapshot.fingerprint &&
    orders.rows.length > 0 &&
    orders.rows.every((order) => order.order_edit_operation_id === active.id);
  const physicalWorkStarted = orders.rows.some(
    (order) =>
      order.started_at !== null ||
      order.assigned_picker_id !== null ||
      Number(order.picked_count) !== 0 ||
      !["pending", "ready", "on_hold"].includes(String(order.warehouse_status)),
  );
  if (newOwnedEdit) {
    // A distinct edit must observe added lines while its own hold protects all
    // fulfillment. Refund/cancel and post-pick reconciliation retain their owners.
    await tx.execute(
      sql`SELECT set_config('echelon.order_edit_ingress_allowed',${String(omsOrderId)},true)`,
    );
    return allow;
  }
  if (observed === certified) return skip;
  if (physicalWorkStarted || Boolean(raw.cancelled_at)) {
    await tx.execute(
      sql`SELECT set_config('echelon.order_edit_ingress_allowed',${String(omsOrderId)},true)`,
    );
    return allow;
  }
  if (matchesCertifiedOrderEditContent(payload, snapshot))
    return { skipLines: true, skipOrder: false };
  // A previous partial refund is not fresh disposition authority. New refund
  // identities permit metadata progression while refunds/create owns line cuts.
  const knownRefunds = new Set(
    snapshot.refunds.map((refund) =>
      refund.id.replace(/^gid:\/\/shopify\/Refund\//, ""),
    ),
  );
  const newRefund =
    Array.isArray(raw.refunds) &&
    raw.refunds.some((refund) => {
      const value = z
        .object({
          id: z.union([
            z.string().regex(/^\d+$/),
            z.number().int().positive().safe(),
          ]),
        })
        .safeParse(refund);
      return value.success && !knownRefunds.has(String(value.data.id));
    });
  if (newRefund) return { skipLines: true, skipOrder: false };
  // An operation still synchronizing its own certified snapshot stays held.
  // A completed operation reopens only for a new pre-picking contradiction.
  const owner =
    active ??
    (
      await tx.execute(
        sql`SELECT id,status,document,version,connection_id FROM oms.order_edit_operations WHERE id=${String(projection.operation_id)}::uuid FOR UPDATE`,
      )
    ).rows[0];
  if (!owner) throw new Error("Certified order edit owner is missing");
  const before = z.record(z.unknown()).parse(owner.document);
  const after = {
    ...before,
    status: "review_required",
    version: Number(owner.version) + 1,
    updatedAt: now.toISOString(),
    error: {
      code: "ORDER_EDIT_NEWER_SOURCE_CONFLICT",
      message:
        "Shopify reported a newer order change after the verified edit. Review the order before fulfillment.",
    },
  };
  if (owner.status !== "review_required") {
    await tx.execute(
      sql`UPDATE oms.order_edit_operations SET status='review_required',version=${after.version},document=${JSON.stringify(after)}::jsonb,updated_at=${now} WHERE id=${String(owner.id)}::uuid`,
    );
    await tx.execute(sql`INSERT INTO oms.order_edit_events(operation_id,connection_id,actor_id,action,before_state,after_state,occurred_at)
      VALUES(${String(owner.id)}::uuid,${Number(owner.connection_id)},NULL,'newer_source_conflict',${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${now})`);
  }
  for (const order of orders.rows) {
    const acquired = await acquireOrderEditWarehouseHold(tx, {
      operationId: String(owner.id),
      wmsOrderIds: [Number(order.id)],
    });
    if (acquired !== 1)
      throw new OrderEditError(
        "ORDER_EDIT_HOLD_OWNER_INVALID",
        "The conflicting order is no longer owned by this edit.",
      );
    await enqueueShipStationHoldSyncInTransaction(tx, {
      wmsOrderId: Number(order.id),
      requestedMode: "hold",
      reason: "Newer Shopify content conflicts with certified order edit",
      now,
    });
  }
  return skip;
}
