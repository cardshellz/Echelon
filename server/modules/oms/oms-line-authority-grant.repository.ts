import type { PoolClient } from "pg";
import {
  DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
  deriveOmsLineAuthority,
  type OmsLineAuthorityState,
} from "./oms-line-authority";
import { buildOmsLineAuthorityEvent } from "./oms-line-authority-ledger";

/**
 * OMS line authority for a dropship order its vendor has paid for.
 *
 * Channel ingestion derives line authority from the channel's paid event
 * (oms.service.ts, buildLineAuthorityState). A dropship order has no such
 * event: acceptance creates its OMS lines with no authority
 * (authority_fulfillable_quantity is 0, its column default from migration 106)
 * and pays for the order by debiting the vendor's wallet. Acceptance calls this
 * in that same transaction. Without it, a WMS sync finds nothing the order may
 * fulfill, and reconcileExistingWmsOrderLines cuts a staged WMS order to zero.
 *
 * OMS owns these tables (BOUNDARIES.md). The caller passes its open
 * transaction so the grant commits or rolls back with the payment.
 */

/** A pg client inside the caller's open transaction. */
export type OmsLineAuthorityGrantClient = Pick<PoolClient, "query">;

export interface GrantDropshipAcceptanceLineAuthorityInput {
  omsOrderId: number;
  /** Stable id of the acceptance that paid for the order; stored on the line and its ledger event. */
  sourceEventId: string;
  /** The acceptance clock's time, recorded as when authority was granted. */
  authorizedAt: Date;
}

export interface GrantedOmsLineAuthority {
  omsOrderLineId: number;
  previousAuthorityFulfillableQuantity: number;
  authorityFulfillableQuantity: number;
  /** False when the line already carried this exact grant, so nothing was written. */
  changed: boolean;
}

export type OmsLineAuthorityGrantErrorCode =
  | "OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT"
  | "OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_FOUND"
  | "OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_PAID"
  | "OMS_LINE_AUTHORITY_GRANT_NO_LINES"
  | "OMS_LINE_AUTHORITY_GRANT_LINE_ADJUSTED"
  | "OMS_LINE_AUTHORITY_GRANT_WRITE_MISSED";

/** Every code is permanent: retrying against the same rows fails the same way. */
export class OmsLineAuthorityGrantError extends Error {
  constructor(
    readonly code: OmsLineAuthorityGrantErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "OmsLineAuthorityGrantError";
  }
}

// oms_order_line_authority_events.source_event_id and
// oms_order_lines.authorized_by_event_id are VARCHAR(100) (migration 107).
const SOURCE_EVENT_ID_MAX_LENGTH = 100;

interface OrderRow {
  id: string | number;
  financial_status: string | null;
}

interface LineRow {
  id: string | number;
  quantity: number;
  fulfillable_quantity: number | null;
  channel_observed_quantity: number;
  paid_quantity: number;
  authority_fulfillable_quantity: number;
  cancelled_quantity: number;
  refunded_quantity: number;
  authorization_status: string;
  authorized_at: Date | null;
  authorized_by_event_id: string | null;
  authority_source_topic: string | null;
}

export async function grantDropshipAcceptanceLineAuthorityWithClient(
  client: OmsLineAuthorityGrantClient,
  input: GrantDropshipAcceptanceLineAuthorityInput,
): Promise<GrantedOmsLineAuthority[]> {
  const parsed = parseInput(input);
  const order = await lockOrder(client, parsed.omsOrderId);
  const lines = await lockLines(client, parsed.omsOrderId);
  if (lines.length === 0) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_NO_LINES",
      "A paid dropship OMS order has no lines to authorize.",
      { omsOrderId: parsed.omsOrderId },
    );
  }

  const granted: GrantedOmsLineAuthority[] = [];
  for (const line of lines) {
    granted.push(await grantLine(client, { ...parsed, financialStatus: order.financial_status }, line));
  }
  return granted;
}

/** The stable authority source id for one dropship intake's acceptance. */
export function dropshipAcceptanceAuthorityEventId(intakeId: number): string {
  if (!Number.isSafeInteger(intakeId) || intakeId <= 0) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT",
      "A dropship acceptance authority id needs a positive intake id.",
      { intakeId },
    );
  }
  return `dropship-acceptance:intake:${intakeId}`;
}

function parseInput(input: GrantDropshipAcceptanceLineAuthorityInput): GrantDropshipAcceptanceLineAuthorityInput {
  const invalid = (field: string, value: unknown): OmsLineAuthorityGrantError =>
    new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT",
      `OMS line authority grant input ${field} is invalid.`,
      { field, value: value instanceof Date ? value.toString() : value ?? null },
    );
  if (!Number.isSafeInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw invalid("omsOrderId", input.omsOrderId);
  }
  const sourceEventId = typeof input.sourceEventId === "string" ? input.sourceEventId.trim() : "";
  if (sourceEventId.length === 0 || sourceEventId.length > SOURCE_EVENT_ID_MAX_LENGTH) {
    throw invalid("sourceEventId", input.sourceEventId);
  }
  if (!(input.authorizedAt instanceof Date) || Number.isNaN(input.authorizedAt.getTime())) {
    throw invalid("authorizedAt", input.authorizedAt);
  }
  return { omsOrderId: input.omsOrderId, sourceEventId, authorizedAt: input.authorizedAt };
}

async function lockOrder(client: OmsLineAuthorityGrantClient, omsOrderId: number): Promise<OrderRow> {
  const result = await client.query<OrderRow>(
    `SELECT id, financial_status
     FROM oms.oms_orders
     WHERE id = $1
     FOR UPDATE`,
    [omsOrderId],
  );
  const order = result.rows[0];
  if (!order) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_FOUND",
      "The dropship OMS order to authorize was not found.",
      { omsOrderId },
    );
  }
  // Authority is permission to fulfill paid quantity. The caller marks the
  // order paid first; anything else here means the payment step did not run.
  if (String(order.financial_status ?? "").toLowerCase() !== "paid") {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_PAID",
      "Dropship OMS line authority requires a paid OMS order.",
      { omsOrderId, financialStatus: order.financial_status },
    );
  }
  return order;
}

async function lockLines(client: OmsLineAuthorityGrantClient, omsOrderId: number): Promise<LineRow[]> {
  const result = await client.query<LineRow>(
    `SELECT id, quantity, fulfillable_quantity, channel_observed_quantity,
            paid_quantity, authority_fulfillable_quantity, cancelled_quantity,
            refunded_quantity, authorization_status, authorized_at,
            authorized_by_event_id, authority_source_topic
     FROM oms.oms_order_lines
     WHERE order_id = $1
     ORDER BY id
     FOR UPDATE`,
    [omsOrderId],
  );
  return result.rows;
}

async function grantLine(
  client: OmsLineAuthorityGrantClient,
  input: GrantDropshipAcceptanceLineAuthorityInput & { financialStatus: string | null },
  line: LineRow,
): Promise<GrantedOmsLineAuthority> {
  const omsOrderLineId = toSafeId(line.id);
  // deriveOmsLineAuthority authorizes the whole observed quantity. A line that
  // was already part-cancelled or refunded needs a person, not a full grant.
  if (line.cancelled_quantity > 0 || line.refunded_quantity > 0) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_LINE_ADJUSTED",
      "A dropship OMS line was cancelled or refunded before its order was paid.",
      {
        omsOrderId: input.omsOrderId,
        omsOrderLineId,
        cancelledQuantity: line.cancelled_quantity,
        refundedQuantity: line.refunded_quantity,
      },
    );
  }

  const previous = {
    channelObservedQuantity: line.channel_observed_quantity,
    paidQuantity: line.paid_quantity,
    authorityFulfillableQuantity: line.authority_fulfillable_quantity,
    authorizationStatus: line.authorization_status,
  };
  const authority = deriveOmsLineAuthority({
    sourceTopic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
    sourceEventId: input.sourceEventId,
    financialStatus: input.financialStatus,
    quantity: line.quantity,
    fulfillableQuantity: line.fulfillable_quantity,
    previous: {
      ...previous,
      cancelledQuantity: line.cancelled_quantity,
      refundedQuantity: line.refunded_quantity,
      authorizedAt: line.authorized_at,
      authorizedByEventId: line.authorized_by_event_id,
    },
    now: input.authorizedAt,
  });
  const result = {
    omsOrderLineId,
    previousAuthorityFulfillableQuantity: line.authority_fulfillable_quantity,
    authorityFulfillableQuantity: authority.authorityFulfillableQuantity,
  };
  if (lineAlreadyCarriesGrant(line, authority)) {
    return { ...result, changed: false };
  }

  const updated = await client.query(
    `UPDATE oms.oms_order_lines
     SET channel_observed_quantity = $2,
         paid_quantity = $3,
         authority_fulfillable_quantity = $4,
         authorization_status = $5,
         authorized_at = $6,
         authorized_by_event_id = $7,
         authority_source_topic = $8,
         authority_source_inbox_id = $9,
         updated_at = $6
     WHERE id = $1`,
    [
      omsOrderLineId,
      authority.channelObservedQuantity,
      authority.paidQuantity,
      authority.authorityFulfillableQuantity,
      authority.authorizationStatus,
      authority.authorizedAt,
      authority.authorizedByEventId,
      authority.authoritySourceTopic,
      authority.authoritySourceInboxId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_WRITE_MISSED",
      "A locked dropship OMS line was not updated by its authority grant.",
      { omsOrderId: input.omsOrderId, omsOrderLineId, rowCount: updated.rowCount },
    );
  }

  const event = buildOmsLineAuthorityEvent({
    orderId: input.omsOrderId,
    orderLineId: omsOrderLineId,
    eventType: "line_updated",
    authority,
    sourceEventId: input.sourceEventId,
    previous,
    cancelledQuantity: line.cancelled_quantity,
    refundedQuantity: line.refunded_quantity,
  });
  // The event key is a pure function of the line and its new authority, so a
  // replay of the same grant appends nothing.
  await client.query(
    `INSERT INTO oms.oms_order_line_authority_events
      (event_key, event_type, order_id, order_line_id, source_topic,
       source_event_id, source_inbox_id, previous_channel_observed_quantity,
       previous_paid_quantity, previous_authority_fulfillable_quantity,
       previous_authorization_status, channel_observed_quantity, paid_quantity,
       authority_fulfillable_quantity, cancelled_quantity, refunded_quantity,
       authorization_status, authorized_at, authorized_by_event_id, created_at)
     VALUES ($1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10,
       $11, $12, $13,
       $14, $15, $16,
       $17, $18, $19, $20)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      event.eventKey,
      event.eventType,
      event.orderId,
      event.orderLineId,
      event.sourceTopic,
      event.sourceEventId,
      event.sourceInboxId,
      event.previousChannelObservedQuantity,
      event.previousPaidQuantity,
      event.previousAuthorityFulfillableQuantity,
      event.previousAuthorizationStatus,
      event.channelObservedQuantity,
      event.paidQuantity,
      event.authorityFulfillableQuantity,
      event.cancelledQuantity,
      event.refundedQuantity,
      event.authorizationStatus,
      event.authorizedAt,
      event.authorizedByEventId,
      input.authorizedAt,
    ],
  );
  return { ...result, changed: true };
}

function lineAlreadyCarriesGrant(line: LineRow, authority: OmsLineAuthorityState): boolean {
  return line.authorized_by_event_id === authority.authorizedByEventId
    && line.authority_source_topic === authority.authoritySourceTopic
    && line.channel_observed_quantity === authority.channelObservedQuantity
    && line.paid_quantity === authority.paidQuantity
    && line.authority_fulfillable_quantity === authority.authorityFulfillableQuantity
    && line.authorization_status === authority.authorizationStatus;
}

// oms_order_lines.id is BIGINT, which node-postgres returns as a string.
function toSafeId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new OmsLineAuthorityGrantError(
      "OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT",
      "An OMS order line id is not a positive safe integer.",
      { omsOrderLineId: String(value) },
    );
  }
  return id;
}
