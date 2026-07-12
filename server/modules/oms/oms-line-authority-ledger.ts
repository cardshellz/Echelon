import {
  omsOrderLineAuthorityEvents,
  type InsertOmsOrderLineAuthorityEvent,
} from "@shared/schema";
import type {
  OmsLineAuthorityState,
} from "./oms-line-authority";

export type OmsLineAuthorityEventType =
  | "line_inserted"
  | "line_updated"
  | "line_removed";

export interface OmsLineAuthorityPreviousState {
  channelObservedQuantity?: number | null;
  paidQuantity?: number | null;
  authorityFulfillableQuantity?: number | null;
  authorizationStatus?: string | null;
}

export interface BuildOmsLineAuthorityEventInput {
  orderId: number;
  orderLineId: number;
  eventType: OmsLineAuthorityEventType;
  authority: OmsLineAuthorityState;
  sourceEventId?: string | null;
  previous?: OmsLineAuthorityPreviousState | null;
  cancelledQuantity?: number;
  refundedQuantity?: number;
}

export interface RecordOmsLineAuthorityEventInput extends BuildOmsLineAuthorityEventInput {
  db: any;
}

function requireNonNegativeInteger(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`OMS line authority event ${field} must be a non-negative integer (got ${String(value)})`);
  }
  return normalized;
}

function compactEventPart(value: string | number | null | undefined): string {
  const text = String(value ?? "none");
  return text.replace(/[|\s]+/g, "_").slice(0, 120);
}

export function buildOmsLineAuthorityEvent(
  input: BuildOmsLineAuthorityEventInput,
): InsertOmsOrderLineAuthorityEvent {
  const sourceEventId = input.sourceEventId ?? input.authority.authorizedByEventId ?? null;
  const previousChannelObservedQuantity = requireNonNegativeInteger(
    input.previous?.channelObservedQuantity,
    "previous.channelObservedQuantity",
  );
  const previousPaidQuantity = requireNonNegativeInteger(
    input.previous?.paidQuantity,
    "previous.paidQuantity",
  );
  const previousAuthorityFulfillableQuantity = requireNonNegativeInteger(
    input.previous?.authorityFulfillableQuantity,
    "previous.authorityFulfillableQuantity",
  );
  const cancelledQuantity = requireNonNegativeInteger(
    input.cancelledQuantity ?? 0,
    "cancelledQuantity",
  ) ?? 0;
  const refundedQuantity = requireNonNegativeInteger(
    input.refundedQuantity ?? 0,
    "refundedQuantity",
  ) ?? 0;

  const eventKey = [
    "oms-line-authority",
    `type:${compactEventPart(input.eventType)}`,
    `line:${compactEventPart(input.orderLineId)}`,
    `topic:${compactEventPart(input.authority.authoritySourceTopic)}`,
    `source:${compactEventPart(sourceEventId ?? input.authority.authoritySourceInboxId)}`,
    `observed:${input.authority.channelObservedQuantity}`,
    `paid:${input.authority.paidQuantity}`,
    `fulfillable:${input.authority.authorityFulfillableQuantity}`,
    `cancelled:${cancelledQuantity}`,
    `refunded:${refundedQuantity}`,
    `status:${compactEventPart(input.authority.authorizationStatus)}`,
  ].join("|");

  return {
    eventKey,
    eventType: input.eventType,
    orderId: input.orderId,
    orderLineId: input.orderLineId,
    sourceTopic: input.authority.authoritySourceTopic,
    sourceEventId,
    sourceInboxId: input.authority.authoritySourceInboxId,
    previousChannelObservedQuantity,
    previousPaidQuantity,
    previousAuthorityFulfillableQuantity,
    previousAuthorizationStatus: input.previous?.authorizationStatus ?? null,
    channelObservedQuantity: input.authority.channelObservedQuantity,
    paidQuantity: input.authority.paidQuantity,
    authorityFulfillableQuantity: input.authority.authorityFulfillableQuantity,
    cancelledQuantity,
    refundedQuantity,
    authorizationStatus: input.authority.authorizationStatus,
    authorizedAt: input.authority.authorizedAt,
    authorizedByEventId: input.authority.authorizedByEventId,
  };
}

export async function recordOmsLineAuthorityEvent(
  input: RecordOmsLineAuthorityEventInput,
): Promise<void> {
  const event = buildOmsLineAuthorityEvent(input);
  await input.db
    .insert(omsOrderLineAuthorityEvents)
    .values(event)
    .onConflictDoNothing({ target: omsOrderLineAuthorityEvents.eventKey });
}
