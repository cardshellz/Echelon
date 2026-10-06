import type { Pool, PoolClient } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { wmsOmsOrderIdSql } from "../../oms/oms-wms-order-link.sql";
import { OrderEditError } from "../domain/order-edit-error";
import type { OrderEditSnapshot } from "../application/order-edit-provider";
import type { OrderEditReleaseProof } from "../application/order-edit-store";
import { getOmsLineMaterializableQuantity } from "../../oms/oms-line-authority";
import {
  acquireOrderEditWarehouseHold,
  releaseOrderEditWarehouseHold,
} from "../../wms/order-edit-hold.commands";

const positiveId = z.number().int().positive().safe();
const operationIdSchema = z.string().uuid();
const orderSchema = z.object({
  id: positiveId,
  channel_id: positiveId.nullable(),
  warehouse_status: z.string(),
  on_hold: z.number().int(),
  order_edit_operation_id: z.string().uuid().nullable(),
  assigned_picker_id: z.string().nullable(),
  started_at: z.unknown().nullable(),
  picked_count: z.number().int().nonnegative(),
  combined_group_id: positiveId.nullable(),
  cancelled: z.boolean(),
  has_pick_work: z.boolean(),
  has_label: z.boolean(),
});
type WarehouseOrder = z.infer<typeof orderSchema>;
const shipmentSchema = z.object({
  id: positiveId,
  order_id: positiveId,
  provider_order_id: positiveId.nullable(),
  shipping_engine: z.string().nullable(),
  status: z.string(),
  held: z.boolean(),
  requires_review: z.boolean(),
});
type Shipment = z.infer<typeof shipmentSchema>;
const dialect = new PgDialect();
const binding = dialect.sqlToQuery(
  wmsOmsOrderIdSql({
    source: sql.raw("wo.source"),
    omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
    legacySourceTableId: sql.raw("wo.source_table_id"),
  }),
).sql;

export interface OrderEditWarehouseProvider {
  isConfigured(): boolean;
  /** Owns the existing per-shipment push lock and verifies provider readback. */
  synchronizeOrderEditShipment(input: {
    shipmentId: number;
    operationId: string;
    mode: "hold" | "verify" | "synchronize" | "release";
  }): Promise<void>;
}
export interface OrderEditWarehouseInspection {
  editable: boolean;
  reasons: string[];
  status: string;
  wmsOrderIds: number[];
}
async function readReleaseProof(
  client: PoolClient,
  omsOrderId: number,
  operationId: string,
  ownership: "owned" | "none" = "owned",
  allocationRequired = false,
): Promise<OrderEditReleaseProof> {
  const source = await client.query(
    "SELECT id,channel_id,external_order_id,status,financial_status,updated_at FROM oms.oms_orders WHERE id=$1 FOR UPDATE",
    [omsOrderId],
  );
  if (source.rows.length !== 1)
    throw new OrderEditError(
      "ORDER_EDIT_ORDER_MISSING",
      "The source order is unavailable.",
    );
  // Match store.save: OMS -> shared runtime authority -> WMS -> claims.
  // Canonical claim writers do not acquire OMS; they acquire authority before WMS.
  const authority = allocationRequired
    ? (
        await client.query(`SELECT authority,activation_run_id,revision
    FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE`)
      ).rows
    : [];
  if (
    allocationRequired &&
    (authority.length !== 1 ||
      authority[0].authority !== "canonical" ||
      authority[0].activation_run_id == null)
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_INVENTORY_PENDING",
      "Canonical inventory allocation is unavailable.",
    );
  }
  if (ownership === "none") {
    // Only an operation that never attempted a commit or external hold can be
    // abandoned without changing warehouse state, even if picking has started.
    const operation = await client.query(
      `SELECT document->>'commitStartedAt' AS commit_started_at,
      document ? 'commitStartedAt' AS has_commit_intent FROM oms.order_edit_operations
      WHERE id=$1 AND oms_order_id=$2 AND status NOT IN ('completed','recovered','failed','expired') FOR UPDATE`,
      [operationId, omsOrderId],
    );
    const provider = await client.query(
      "SELECT shipment_id FROM oms.order_edit_provider_holds WHERE operation_id=$1 ORDER BY shipment_id FOR UPDATE",
      [operationId],
    );
    if (
      operation.rows.length !== 1 ||
      operation.rows[0].has_commit_intent !== true ||
      operation.rows[0].commit_started_at !== null ||
      provider.rows.length !== 0
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_RELEASE_NOT_UNCHANGED",
        "This edit may have changed provider state and requires hold reconciliation.",
      );
    }
  }
  const orders = await client.query(
    `SELECT wo.id,wo.order_edit_operation_id,wo.warehouse_status,wo.on_hold,
    wo.started_at,wo.assigned_picker_id,wo.picked_count,wo.cancelled_at FROM wms.orders wo
    WHERE ${binding}=$1 ORDER BY wo.id FOR UPDATE OF wo`,
    [omsOrderId],
  );
  if (
    (ownership === "owned" && !orders.rows.length) ||
    orders.rows.some(
      (row) =>
        row.order_edit_operation_id !==
        (ownership === "none" ? null : operationId),
    )
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_RELEASE_OWNER_CHANGED",
      "Every warehouse partition must remain owned by this edit.",
    );
  }
  const wmsOrderIds = orders.rows.map((row) => positiveId.parse(row.id));
  const shipments = await client.query(
    `SELECT id,status,held,requires_review,shipstation_order_id,engine_order_ref,
    tracking_number,shipped_at FROM wms.outbound_shipments WHERE order_id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [wmsOrderIds],
  );
  const items = await client.query(
    `SELECT id,order_id,oms_order_line_id,product_variant_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold
    FROM wms.order_items WHERE order_id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [wmsOrderIds],
  );
  const lines = await client.query(
    `SELECT id,external_line_item_id,product_variant_id,quantity,paid_quantity,authority_fulfillable_quantity
    FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id FOR UPDATE`,
    [omsOrderId],
  );
  const shipmentIds = shipments.rows.map((row) => positiveId.parse(row.id));
  const shipmentItems = await client.query(
    `SELECT id,shipment_id,order_item_id,qty FROM wms.outbound_shipment_items
    WHERE shipment_id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [shipmentIds],
  );
  if (
    allocationRequired &&
    items.rows.some(
      (item) =>
        item.status !== "cancelled" &&
        item.quantity > 0 &&
        (!item.product_variant_id ||
          !lines.rows.some(
            (line) =>
              String(line.id) === String(item.oms_order_line_id) &&
              line.product_variant_id === item.product_variant_id,
          )),
    )
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_INVENTORY_PENDING",
      "Warehouse and source product identities do not match.",
    );
  }
  const allocation = allocationRequired
    ? await readAllocationProof(client, wmsOrderIds, items.rows)
    : null;
  return {
    wmsOrderIds,
    shipmentIds,
    ...(ownership === "none" ? { ownership } : {}),
    ...(allocationRequired ? { allocationRequired: true } : {}),
    contentFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          source: source.rows,
          orders: orders.rows,
          shipments: shipments.rows,
          items: items.rows,
          lines: lines.rows,
          shipmentItems: shipmentItems.rows,
          authority,
          allocation,
        }),
      )
      .digest("hex"),
  };
}

async function readAllocationProof(
  client: PoolClient,
  orderIds: number[],
  items: Array<Record<string, unknown>>,
) {
  // Every canonical replacement, pick and release locks its WMS header first.
  // Keep the claim lineage in the proof so a later reallocation cannot silently
  // consume provider verification from an earlier inventory plan.
  const claims = (
    await client.query(
      `SELECT id,order_id,status,revision,plan_status,runtime_authority_revision,activation_run_id,plan_hash
    FROM inventory.availability_claims WHERE order_id=ANY($1::int[]) AND status='active' ORDER BY id FOR UPDATE`,
      [orderIds],
    )
  ).rows;
  const ids = claims.map((claim) => String(claim.id));
  const claimLines = (
    await client.query(
      `SELECT id,claim_id,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty,
    released_target_qty,consumed_target_qty,picked_target_qty FROM inventory.availability_claim_lines
    WHERE claim_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [ids],
    )
  ).rows;
  const resources = (
    await client.query(
      `SELECT * FROM inventory.availability_claim_resources
    WHERE claim_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [ids],
    )
  ).rows;
  const lots = (
    await client.query(
      `SELECT * FROM inventory.availability_claim_lot_allocations
    WHERE claim_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [ids],
    )
  ).rows;
  const openItems = items.filter(
    (item) => item.status !== "cancelled" && Number(item.quantity) > 0,
  );
  const quantities = new Map(
    openItems.map((item) => [
      positiveId.parse(item.id),
      BigInt(z.number().int().positive().safe().parse(item.quantity)),
    ]),
  );
  const claimById = new Map(claims.map((claim) => [String(claim.id), claim]));
  if (
    new Set(claims.map((claim) => claim.order_id)).size !== claims.length ||
    openItems.some(
      (item) =>
        !claims.some(
          (claim) =>
            claim.order_id === item.order_id &&
            claim.plan_status === "satisfied",
        ),
    )
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_INVENTORY_PENDING",
      "Every edited item must have a satisfied inventory allocation.",
    );
  }
  const units = z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
    .transform((value) => BigInt(value));
  for (const line of claimLines) {
    const id = positiveId.parse(line.order_item_id);
    const quantity = quantities.get(id);
    const claim = claimById.get(String(line.claim_id));
    if (
      quantity === undefined ||
      !openItems.some(
        (item) =>
          item.id === id &&
          item.order_id === claim?.order_id &&
          item.product_variant_id === line.target_variant_id,
      ) ||
      units.parse(line.requested_qty) !== quantity ||
      units.parse(line.planned_qty) !== quantity ||
      [
        line.shortfall_qty,
        line.released_target_qty,
        line.consumed_target_qty,
        line.picked_target_qty,
      ].some((value) => units.parse(value) !== BigInt(0))
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_INVENTORY_PENDING",
        "Inventory allocation no longer matches the edited items.",
      );
    }
    quantities.delete(id);
  }
  if (quantities.size)
    throw new OrderEditError(
      "ORDER_EDIT_INVENTORY_PENDING",
      "An edited item has no inventory allocation.",
    );
  return { claims, claimLines, resources, lots };
}

/** Caller must update operation terminal state + audit in THIS SAME transaction. */
export async function finalizeOrderEditWarehouseRelease(
  client: PoolClient,
  omsOrderId: number,
  operationId: string,
  proof: OrderEditReleaseProof,
): Promise<void> {
  positiveId.parse(omsOrderId);
  operationIdSchema.parse(operationId);
  z.object({
    wmsOrderIds: z.array(positiveId),
    shipmentIds: z.array(positiveId),
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    ownership: z.enum(["owned", "none"]).optional(),
    allocationRequired: z.boolean().optional(),
  })
    .strict()
    .parse(proof);
  const current = await readReleaseProof(
    client,
    omsOrderId,
    operationId,
    proof.ownership ?? "owned",
    proof.allocationRequired ?? false,
  );
  if (
    current.contentFingerprint !== proof.contentFingerprint ||
    current.wmsOrderIds.join(",") !== proof.wmsOrderIds.join(",") ||
    current.shipmentIds.join(",") !== proof.shipmentIds.join(",")
  )
    throw new OrderEditError(
      "ORDER_EDIT_RELEASE_CHANGED",
      "Warehouse state changed after provider verification; verify the edit again.",
    );
  if (proof.ownership === "none") return;
  const released = await releaseOrderEditWarehouseHold(client, {
    operationId,
    wmsOrderIds: current.wmsOrderIds,
  });
  if (released !== current.wmsOrderIds.length)
    throw new OrderEditError(
      "ORDER_EDIT_RELEASE_OWNER_CHANGED",
      "Warehouse hold ownership changed.",
    );
}

/** Pure pre-picking cutoff. A prior pick/unpick still has started_at and stays blocked. */
export function orderEditWarehouseBlockers(
  rows: readonly WarehouseOrder[],
  operationId?: string,
): string[] {
  const reasons = new Set<string>();
  if (!rows.length) reasons.add("Warehouse order is not available.");
  for (const row of rows) {
    if (
      row.cancelled ||
      !["pending", "ready", "on_hold"].includes(row.warehouse_status)
    )
      reasons.add("The order is no longer waiting to be picked.");
    if (
      row.started_at !== null ||
      row.assigned_picker_id !== null ||
      row.picked_count !== 0 ||
      row.has_pick_work
    )
      reasons.add("Picking has already started.");
    if (row.has_label)
      reasons.add("A shipping label or shipment already exists.");
    if (row.combined_group_id !== null)
      reasons.add("Combined warehouse orders require staff review.");
    if (
      row.order_edit_operation_id !== null &&
      row.order_edit_operation_id !== operationId
    )
      reasons.add("Another order edit holds this order.");
  }
  return [...reasons];
}

/**
 * The operation record is the durable retry owner; provider uncertainty never
 * clears this dedicated hold. Manual order/shipment holds are never changed.
 * Lock order is OMS header -> bound WMS headers -> shipment headers.
 */
export class OrderEditWarehouseGateway {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly provider: OrderEditWarehouseProvider,
    private readonly synchronize: (
      omsOrderId: number,
      snapshot: OrderEditSnapshot,
      operationId: string,
    ) => Promise<void>,
  ) {}

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }

  private async evidence(
    client: PoolClient,
    omsOrderId: number,
  ): Promise<{ orders: WarehouseOrder[]; shipments: Shipment[] }> {
    positiveId.parse(omsOrderId);
    const source = await client.query(
      "SELECT id,channel_id FROM oms.oms_orders WHERE id=$1 FOR UPDATE",
      [omsOrderId],
    );
    if (source.rows.length !== 1)
      throw new OrderEditError(
        "ORDER_EDIT_ORDER_MISSING",
        "The source order is unavailable.",
      );
    const result = await client.query(
      `SELECT wo.id, wo.channel_id, wo.warehouse_status, wo.on_hold,
      wo.order_edit_operation_id, wo.assigned_picker_id, wo.started_at, wo.picked_count, wo.combined_group_id,
      (wo.cancelled_at IS NOT NULL) AS cancelled,
      EXISTS(SELECT 1 FROM wms.order_items oi WHERE oi.order_id=wo.id
        AND (oi.picked_quantity<>0 OR oi.fulfilled_quantity<>0 OR oi.status NOT IN ('pending','cancelled'))) AS has_pick_work,
      EXISTS(SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id=wo.id
        AND (os.status NOT IN ('planned','queued','on_hold','cancelled','voided') OR os.tracking_number IS NOT NULL OR os.shipped_at IS NOT NULL)) AS has_label
      FROM wms.orders wo WHERE ${binding}=$1 ORDER BY wo.id FOR UPDATE OF wo`,
      [omsOrderId],
    );
    const orders = z.array(orderSchema).parse(result.rows);
    if (orders.some((order) => order.channel_id !== source.rows[0].channel_id))
      throw new OrderEditError(
        "ORDER_EDIT_CHANNEL_MISMATCH",
        "Warehouse and source channel identities differ.",
      );
    const shipments = z.array(shipmentSchema).parse(
      (
        await client.query(
          `SELECT id, order_id,
      COALESCE(shipstation_order_id, CASE WHEN shipping_engine='shipstation' AND engine_order_ref ~ '^[0-9]+$'
        AND length(engine_order_ref)<10 THEN engine_order_ref::integer END) AS provider_order_id,
      shipping_engine, status, held, requires_review FROM wms.outbound_shipments
      WHERE order_id=ANY($1::int[]) AND status NOT IN ('cancelled','voided') ORDER BY id FOR UPDATE`,
          [orders.map((order) => order.id)],
        )
      ).rows,
    );
    if (
      shipments.some(
        (shipment) =>
          shipment.requires_review ||
          !["planned", "queued", "on_hold"].includes(shipment.status) ||
          (shipment.shipping_engine !== null &&
            shipment.shipping_engine !== "shipstation"),
      )
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_SHIPMENT_NOT_EDITABLE",
        "A warehouse shipment requires review or is no longer editable.",
      );
    }
    return { orders, shipments };
  }

  private requireEditable(
    orders: WarehouseOrder[],
    operationId?: string,
  ): void {
    const reasons = orderEditWarehouseBlockers(orders, operationId);
    if (reasons.length)
      throw new OrderEditError("ORDER_EDIT_PICKING_CUTOFF", reasons.join(" "));
  }

  async inspect(omsOrderId: number): Promise<OrderEditWarehouseInspection> {
    return this.transaction(async (client) => {
      const { orders } = await this.evidence(client, omsOrderId);
      const reasons = orderEditWarehouseBlockers(orders);
      return {
        editable: reasons.length === 0,
        reasons,
        status: orders.map((order) => order.warehouse_status).join(", "),
        wmsOrderIds: orders.map((order) => order.id),
      };
    });
  }

  private async heldEvidence(
    omsOrderId: number,
    operationId: string,
    acquire = false,
  ): Promise<Shipment[]> {
    operationIdSchema.parse(operationId);
    return this.transaction(async (client) => {
      const { orders, shipments } = await this.evidence(client, omsOrderId);
      this.requireEditable(orders, operationId);
      const operation = await client.query(
        `SELECT id FROM oms.order_edit_operations WHERE id=$1 AND oms_order_id=$2
        AND status NOT IN ('completed','recovered','failed','expired') FOR UPDATE`,
        [operationId, omsOrderId],
      );
      if (operation.rows.length !== 1)
        throw new OrderEditError(
          "ORDER_EDIT_HOLD_OWNER_INVALID",
          "The active edit no longer owns this order.",
        );
      if (acquire) {
        const acquired = await acquireOrderEditWarehouseHold(client, {
          operationId,
          wmsOrderIds: orders.map((order) => order.id),
        });
        if (acquired !== orders.length)
          throw new OrderEditError(
            "ORDER_EDIT_HOLD_OWNER_INVALID",
            "The active edit no longer owns every warehouse order.",
          );
      } else if (
        orders.some((order) => order.order_edit_operation_id !== operationId)
      ) {
        throw new OrderEditError(
          "ORDER_EDIT_HOLD_MISSING",
          "Every warehouse order must remain held by this edit.",
        );
      }
      return shipments;
    });
  }

  private async providerPhase(
    shipments: Shipment[],
    operationId: string,
    mode: "hold" | "verify" | "synchronize" | "release",
  ): Promise<void> {
    for (const shipment of shipments) {
      // Even an unlinked shipment must pass the provider's push lock: a push
      // may have started before acquisition and not persisted its identity yet.
      if (shipment.provider_order_id !== null && !this.provider.isConfigured())
        throw new OrderEditError(
          "ORDER_EDIT_SHIPPING_UNAVAILABLE",
          "Shipping verification is unavailable; the order remains held.",
        );
      await this.provider.synchronizeOrderEditShipment({
        shipmentId: shipment.id,
        operationId,
        mode,
      });
    }
  }

  async acquire(omsOrderId: number, operationId: string): Promise<void> {
    const shipments = await this.heldEvidence(omsOrderId, operationId, true);
    await this.providerPhase(shipments, operationId, "hold");
    await this.assertHeld(omsOrderId, operationId);
  }
  async assertHeld(omsOrderId: number, operationId: string): Promise<void> {
    await this.providerPhase(
      await this.heldEvidence(omsOrderId, operationId),
      operationId,
      "verify",
    );
  }

  private async assertContents(
    client: PoolClient,
    omsOrderId: number,
    expected: OrderEditSnapshot,
  ): Promise<void> {
    const source = (
      await client.query(
        "SELECT channel_id,external_order_id FROM oms.oms_orders WHERE id=$1",
        [omsOrderId],
      )
    ).rows[0];
    if (
      source?.channel_id !== expected.channelId ||
      String(source.external_order_id).replace(
        /^gid:\/\/shopify\/Order\//,
        "",
      ) !== expected.orderId.replace(/^gid:\/\/shopify\/Order\//, "")
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_SOURCE_CHANGED",
        "The source order identity changed.",
      );
    }
    const actual = (
      await client.query(
        `SELECT ol.external_line_item_id, ol.authority_fulfillable_quantity,
      COALESCE(SUM(CASE WHEN oi.status<>'cancelled' THEN oi.quantity ELSE 0 END),0)::integer AS warehouse_quantity
      FROM oms.oms_order_lines ol LEFT JOIN wms.order_items oi ON oi.oms_order_line_id=ol.id
      WHERE ol.order_id=$1 GROUP BY ol.id,ol.external_line_item_id,ol.authority_fulfillable_quantity`,
        [omsOrderId],
      )
    ).rows;
    const quantities = new Map(
      expected.lines.map((line) => [
        line.id.replace(/^gid:\/\/shopify\/LineItem\//, ""),
        line.quantity,
      ]),
    );
    const seen = new Set<string>();
    for (const row of actual) {
      const key = String(row.external_line_item_id).replace(
        /^gid:\/\/shopify\/LineItem\//,
        "",
      );
      // OMS quantity records purchased history, including subsequently removed
      // units. Only explicit paid fulfillment authority can release current work.
      const authority = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .safeParse(row.authority_fulfillable_quantity);
      const materializable = authority.success
        ? getOmsLineMaterializableQuantity({
            authorityFulfillableQuantity: authority.data,
          })
        : null;
      if (
        seen.has(key) ||
        materializable === null ||
        (quantities.get(key) ?? 0) !== materializable ||
        materializable !== Number(row.warehouse_quantity)
      ) {
        throw new OrderEditError(
          "ORDER_EDIT_CONTENTS_NOT_RECONCILED",
          "Order quantities have not reconciled across Shopify, OMS and the warehouse.",
        );
      }
      seen.add(key);
      quantities.delete(key);
    }
    if ([...quantities.values()].some((quantity) => quantity !== 0))
      throw new OrderEditError(
        "ORDER_EDIT_CONTENTS_NOT_RECONCILED",
        "An edited line is missing from the warehouse.",
      );
  }

  async reconcileAndRelease(
    omsOrderId: number,
    operationId: string,
    expected: OrderEditSnapshot,
  ): Promise<OrderEditReleaseProof> {
    if (!expected.fullyPaid || expected.outstandingCents !== 0)
      throw new OrderEditError(
        "ORDER_EDIT_PAYMENT_REQUIRED",
        "Payment must be fully reconciled before fulfillment resumes.",
      );
    // A prior release may have reached the provider before the local terminal
    // transaction failed. Reassert our saved hold ownership before retrying.
    await this.providerPhase(
      await this.heldEvidence(omsOrderId, operationId),
      operationId,
      "hold",
    );
    await this.assertHeld(omsOrderId, operationId);
    await this.synchronize(omsOrderId, expected, operationId);
    await this.transaction(async (client) => {
      await this.evidence(client, omsOrderId);
      await this.assertContents(client, omsOrderId, expected);
    });
    const shipments = await this.heldEvidence(omsOrderId, operationId);
    await this.providerPhase(shipments, operationId, "synchronize");
    return this.releaseOwned(omsOrderId, operationId, expected);
  }

  async releaseUnchanged(
    omsOrderId: number,
    operationId: string,
  ): Promise<OrderEditReleaseProof> {
    positiveId.parse(omsOrderId);
    operationIdSchema.parse(operationId);
    const neverHeld = await this.transaction(async (client) => {
      await client.query(
        "SELECT id FROM oms.oms_orders WHERE id=$1 FOR UPDATE",
        [omsOrderId],
      );
      const rows = await client.query(
        `SELECT wo.order_edit_operation_id FROM wms.orders wo
        WHERE ${binding}=$1 ORDER BY wo.id FOR UPDATE OF wo`,
        [omsOrderId],
      );
      if (rows.rows.some((row) => row.order_edit_operation_id !== null))
        return null;
      return readReleaseProof(client, omsOrderId, operationId, "none");
    });
    if (neverHeld) return neverHeld;
    await this.providerPhase(
      await this.heldEvidence(omsOrderId, operationId),
      operationId,
      "hold",
    );
    await this.assertHeld(omsOrderId, operationId);
    return this.releaseOwned(omsOrderId, operationId);
  }

  private async releaseOwned(
    omsOrderId: number,
    operationId: string,
    expected?: OrderEditSnapshot,
  ): Promise<OrderEditReleaseProof> {
    const shipments = await this.heldEvidence(omsOrderId, operationId);
    const before = await this.transaction((client) =>
      readReleaseProof(
        client,
        omsOrderId,
        operationId,
        "owned",
        expected !== undefined,
      ),
    );
    await this.providerPhase(shipments, operationId, "release");
    return this.transaction(async (client) => {
      const proof = await readReleaseProof(
        client,
        omsOrderId,
        operationId,
        "owned",
        expected !== undefined,
      );
      if (proof.contentFingerprint !== before.contentFingerprint)
        throw new OrderEditError(
          "ORDER_EDIT_RELEASE_CHANGED",
          "Order or inventory allocation changed during provider release.",
        );
      const current = await this.evidence(client, omsOrderId);
      this.requireEditable(current.orders, operationId);
      if (
        current.orders.some(
          (order) => order.order_edit_operation_id !== operationId,
        ) ||
        current.shipments.map((item) => item.id).join(",") !==
          shipments.map((item) => item.id).join(",")
      ) {
        throw new OrderEditError(
          "ORDER_EDIT_RELEASE_CHANGED",
          "Warehouse ownership changed during release; reconciliation is required.",
        );
      }
      if (expected) await this.assertContents(client, omsOrderId, expected);
      // Keep the dedicated hold until the operation owner atomically stores its
      // terminal state and consumes this exact proof in the same transaction.
      return proof;
    });
  }
}
