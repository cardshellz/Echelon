import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  orderEditConnectionSchema,
  orderEditQuoteInputSchema,
  orderEditSettingsInputSchema,
  orderEditStatusSchema,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditSettingsInput } from "@shared/order-edits/order-edit.contract";
import type {
  OrderEditRecord,
  OrderEditStore,
  OrderEditOrderReference,
  OrderEditReleaseProof,
} from "../application/order-edit-store";
import { OrderEditError } from "../domain/order-edit-error";
import { unchangedFulfilledOrderEdit } from "../application/order-edit-evidence";
import { finalizeOrderEditWarehouseRelease } from "./order-edit-warehouse.gateway";
import { appendOrderEditAudit } from "./order-edit-audit.writer";
import {
  orderEditSnapshotSchema,
  orderEditQuoteSchema,
  orderEditRefundIntentSchema,
} from "../application/order-edit-provider.schema";

const referenceSchema = z.object({
  omsOrderId: z.coerce.number().int().positive().safe(),
  channelId: z.number().int().positive(),
  connectionId: z.number().int().positive(),
  externalOrderId: z.string().min(1),
  externalCustomerId: z.string().nullable(),
  orderNumber: z.string(),
  customerName: z.string(),
  customerEmail: z.string().nullable(),
  activeOperationId: z.string().uuid().nullable(),
});
const documentSchema = z
  .object({
    id: z.string().uuid(),
    omsOrderId: z.number().int().positive().safe(),
    connectionId: z.number().int().positive(),
    requestKey: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    actorId: z.string().min(1),
    status: orderEditStatusSchema,
    version: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    input: orderEditQuoteInputSchema,
    baseline: orderEditSnapshotSchema,
    quote: orderEditQuoteSchema.nullable(),
    paymentWindowMinutes: z.number().int().positive(),
    quoteDeadline: z.string().datetime(),
    paymentDeadline: z.string().datetime().nullable(),
    commitKey: z.string().uuid().nullable(),
    commitStartedAt: z.string().datetime().nullable(),
    refundIntent: orderEditRefundIntentSchema.nullable(),
    refundStartedAt: z.string().datetime().nullable(),
    lastSnapshot: orderEditSnapshotSchema.nullable(),
    recoveryStartedAt: z.string().datetime().nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.input.omsOrderId !== record.omsOrderId ||
      record.input.connectionId !== record.connectionId ||
      record.input.requestKey !== record.requestKey ||
      record.baseline.connectionId !== record.connectionId ||
      (record.quote !== null &&
        (record.quote.operationId !== record.id ||
          record.quote.connectionId !== record.connectionId ||
          record.quote.channelId !== record.baseline.channelId ||
          record.quote.orderId !== record.baseline.orderId ||
          record.quote.baselineFingerprint !== record.baseline.fingerprint ||
          JSON.stringify(record.quote.plan) !==
            JSON.stringify({
              changes: record.input.changes,
              additions: record.input.additions,
            }))) ||
      (record.refundIntent !== null &&
        (record.refundIntent.operationId !== record.id ||
          record.refundIntent.connectionId !== record.connectionId ||
          record.refundIntent.orderId !== record.baseline.orderId ||
          record.refundIntent.channelId !== record.baseline.channelId ||
          record.quote === null ||
          record.refundIntent.amountCents !==
            record.baseline.netPaidCents - record.quote.totalCents)) ||
      (record.lastSnapshot !== null &&
        (record.lastSnapshot.orderId !== record.baseline.orderId ||
          record.lastSnapshot.connectionId !== record.connectionId ||
          record.lastSnapshot.channelId !== record.baseline.channelId))
    ) {
      context.addIssue({
        code: "custom",
        message: "Persisted operation identities do not match",
      });
    }
    if (
      (record.commitStartedAt === null) !== (record.commitKey === null) ||
      (record.refundIntent === null) !== (record.refundStartedAt === null) ||
      (record.commitStartedAt !== null &&
        (record.quote === null || record.paymentDeadline === null)) ||
      ((record.refundIntent !== null || record.recoveryStartedAt !== null) &&
        record.commitStartedAt === null) ||
      (record.status === "ready" && record.quote === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Persisted financial intent is incomplete",
      });
    }
  });
const connectionSelect = `SELECT cc.id AS "connectionId", c.id AS "channelId", c.name, cc.shop_domain AS "shopDomain",
  s.payment_window_minutes AS "paymentWindowMinutes", COALESCE(s.enabled,false) AS enabled
  FROM channels.channels c JOIN channels.channel_connections cc ON cc.channel_id=c.id
  LEFT JOIN oms.order_edit_settings s ON s.connection_id=cc.id
  WHERE c.provider='shopify' AND c.status='active' AND cc.shop_domain IS NOT NULL`;
const orderSelect = `SELECT o.id AS "omsOrderId", o.channel_id AS "channelId", cc.id AS "connectionId", o.external_order_id AS "externalOrderId",
  o.external_customer_id AS "externalCustomerId", COALESCE(o.external_order_number,o.external_order_id) AS "orderNumber",
  COALESCE(o.customer_name,'') AS "customerName", o.customer_email AS "customerEmail", edit.id AS "activeOperationId"
  FROM oms.oms_orders o JOIN channels.channel_connections cc ON cc.channel_id=o.channel_id
  LEFT JOIN oms.order_edit_operations edit ON edit.oms_order_id=o.id AND edit.connection_id=cc.id
    AND edit.status NOT IN ('completed','recovered','failed','expired')
  JOIN channels.channels c ON c.id=o.channel_id WHERE cc.id=$1 AND c.provider='shopify' AND c.status='active'`;

export class PostgresOrderEditStore implements OrderEditStore {
  constructor(private readonly pool: Pool) {}
  async connections() {
    return z
      .array(orderEditConnectionSchema)
      .parse(
        (await this.pool.query(connectionSelect + " ORDER BY c.id,cc.id")).rows,
      );
  }
  async settings(connectionId: number) {
    const rows = (
      await this.pool.query(connectionSelect + " AND cc.id=$1", [connectionId])
    ).rows;
    if (rows.length !== 1)
      throw new OrderEditError(
        "ORDER_EDIT_CONNECTION_UNAVAILABLE",
        "The Shopify connection is unavailable.",
        404,
      );
    return orderEditConnectionSchema.parse(rows[0]);
  }
  async saveSettings(
    connectionId: number,
    input: OrderEditSettingsInput,
    actorId: string,
    now: Date,
  ) {
    const validated = orderEditSettingsInputSchema.parse(input);
    await this.settings(connectionId);
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`order-edit-settings:${connectionId}`],
      );
      const before =
        (
          await client.query(
            "SELECT payment_window_minutes,enabled FROM oms.order_edit_settings WHERE connection_id=$1 FOR UPDATE",
            [connectionId],
          )
        ).rows[0] ?? null;
      await client.query(
        `INSERT INTO oms.order_edit_settings(connection_id,payment_window_minutes,enabled,updated_by,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(connection_id) DO UPDATE SET payment_window_minutes=$2,enabled=$3,updated_by=$4,updated_at=$5`,
        [
          connectionId,
          validated.paymentWindowMinutes,
          validated.enabled,
          actorId,
          now,
        ],
      );
      await appendOrderEditAudit(client, {
        operationId: null,
        connectionId,
        actorId,
        action: "settings_saved",
        before,
        after: validated,
        occurredAt: now,
      });
    });
    return this.settings(connectionId);
  }
  async findOrders(connectionId: number, search: string) {
    await this.settings(connectionId);
    const normalized = search.trim().replace(/^#/, "");
    if (!normalized || normalized.length > 100) return [];
    // Exact order-number lookup is channel-scoped and bounded; customer names are never an ownership key.
    return z
      .array(referenceSchema)
      .parse(
        (
          await this.pool.query(
            orderSelect +
              " AND (o.external_order_number=$2 OR o.external_order_number=$3 OR o.external_order_id=$2) ORDER BY o.id DESC LIMIT 50",
            [connectionId, normalized, `#${normalized}`],
          )
        ).rows,
      );
  }
  async orderReference(
    connectionId: number,
    omsOrderId: number,
  ): Promise<OrderEditOrderReference> {
    const rows = (
      await this.pool.query(orderSelect + " AND o.id=$2", [
        connectionId,
        omsOrderId,
      ])
    ).rows;
    if (rows.length !== 1)
      throw new OrderEditError(
        "ORDER_EDIT_ORDER_UNAVAILABLE",
        "This order is not available for the selected Shopify connection.",
        404,
      );
    return referenceSchema.parse(rows[0]);
  }
  async withOrderLock<T>(
    omsOrderId: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let destroyClient = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [`order-edit:${omsOrderId}`],
        )
      ).rows[0].locked;
      if (!locked)
        throw new OrderEditError(
          "ORDER_EDIT_BUSY",
          "This order is already being updated. Check its status before trying again.",
        );
      return await work();
    } finally {
      try {
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [`order-edit:${omsOrderId}`],
          );
      } catch (error) {
        destroyClient = true;
        throw error;
      } finally {
        client.release(destroyClient);
      }
    }
  }
  async findByRequestKey(key: string) {
    const row = (
      await this.pool.query(
        "SELECT document FROM oms.order_edit_operations WHERE request_key=$1",
        [key],
      )
    ).rows[0];
    return row ? this.parseRecord(row.document) : null;
  }
  async get(id: string) {
    const row = (
      await this.pool.query(
        "SELECT document FROM oms.order_edit_operations WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row)
      throw new OrderEditError(
        "ORDER_EDIT_NOT_FOUND",
        "The saved order edit was not found.",
        404,
      );
    return this.parseRecord(row.document);
  }
  async create(record: OrderEditRecord) {
    this.parseRecord(record);
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO oms.order_edit_operations(id,oms_order_id,connection_id,request_key,request_hash,actor_id,status,version,document,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          record.id,
          record.omsOrderId,
          record.connectionId,
          record.requestKey,
          record.requestHash,
          record.actorId,
          record.status,
          record.version,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        ],
      );
      await this.audit(client, record, null, record.actorId, "created");
    });
  }
  async save(
    record: OrderEditRecord,
    previousVersion: number,
    actorId: string | null,
    action: string,
    releaseProof?: OrderEditReleaseProof,
  ) {
    this.parseRecord(record);
    await this.transaction(async (client) => {
      // Match the warehouse gateway's OMS-first lock order. Completion and hold
      // removal are one transaction; future partitions then see terminal state.
      await client.query(
        "SELECT id FROM oms.oms_orders WHERE id=$1 FOR UPDATE",
        [record.omsOrderId],
      );
      const before = (
        await client.query(
          "SELECT document,version FROM oms.order_edit_operations WHERE id=$1 FOR UPDATE",
          [record.id],
        )
      ).rows[0];
      if (
        !before ||
        before.version !== previousVersion ||
        record.version !== previousVersion + 1
      )
        throw new OrderEditError(
          "ORDER_EDIT_CONCURRENT_CHANGE",
          "This order edit changed. Reload its status.",
        );
      if (
        ["completed", "recovered", "expired", "failed"].includes(record.status)
      ) {
        if (!releaseProof)
          throw new OrderEditError(
            "ORDER_EDIT_RELEASE_PROOF_REQUIRED",
            "Warehouse release must be verified before this edit can finish.",
          );
        if (
          releaseProof.fulfilledCancellation &&
          (record.status !== "expired" ||
            record.commitStartedAt ||
            record.commitKey ||
            record.refundIntent ||
            record.refundStartedAt ||
            record.recoveryStartedAt ||
            !record.lastSnapshot ||
            !unchangedFulfilledOrderEdit(record.lastSnapshot, record.baseline))
        ) {
          throw new OrderEditError(
            "ORDER_EDIT_FULFILLED_CANCEL_INVALID",
            "Only an unchanged, fully fulfilled, unsubmitted edit can use completed-order cleanup.",
          );
        }
        if (
          ["completed", "recovered"].includes(record.status) &&
          releaseProof.allocationRequired !== true
        )
          throw new OrderEditError(
            "ORDER_EDIT_ALLOCATION_PROOF_REQUIRED",
            "Revised inventory allocation must be verified before this edit can finish.",
          );
        await finalizeOrderEditWarehouseRelease(
          client,
          record.omsOrderId,
          record.id,
          releaseProof,
        );
      } else if (releaseProof)
        throw new OrderEditError(
          "ORDER_EDIT_RELEASE_STATE_INVALID",
          "A nonterminal edit cannot release warehouse ownership.",
        );
      await client.query(
        "UPDATE oms.order_edit_operations SET status=$2,version=$3,document=$4,updated_at=$5 WHERE id=$1",
        [
          record.id,
          record.status,
          record.version,
          JSON.stringify(record),
          record.updatedAt,
        ],
      );
      await this.audit(client, record, before.document, actorId, action);
    });
  }
  async pending(limit: number, now: Date) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid order edit worker limit");
    // Unsubmitted, unexpired quotes need no work and must not starve payment or
    // refund reconciliation when a store has many simultaneous edit sessions.
    return (
      await this.pool.query<{ id: string }>(
        `SELECT id FROM oms.order_edit_operations
      WHERE status NOT IN ('completed','recovered','failed','expired','review_required')
        AND (document->>'commitStartedAt' IS NOT NULL OR (document->>'quoteDeadline')::timestamptz <= $2)
      ORDER BY updated_at,id LIMIT $1`,
        [limit, now],
      )
    ).rows.map((row) => row.id);
  }
  private parseRecord(value: unknown): OrderEditRecord {
    return documentSchema.parse(value);
  }
  private async audit(
    client: PoolClient,
    record: OrderEditRecord,
    before: unknown,
    actorId: string | null,
    action: string,
  ) {
    await appendOrderEditAudit(client, {
      operationId: record.id,
      connectionId: record.connectionId,
      actorId,
      action,
      before,
      after: record,
      occurredAt: record.updatedAt,
    });
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
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
}
