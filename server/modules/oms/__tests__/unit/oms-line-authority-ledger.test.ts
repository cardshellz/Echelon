import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { deriveOmsLineAuthority } from "../../oms-line-authority";
import { buildOmsLineAuthorityEvent } from "../../oms-line-authority-ledger";

const OMS_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../oms.service.ts"),
  "utf8",
);

const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf8",
);

describe("OMS line authority ledger", () => {
  it("builds an idempotent append-only event from authority state", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:10",
      sourceInboxId: 10,
      financialStatus: "paid",
      quantity: 3,
      fulfillableQuantity: 2,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const event = buildOmsLineAuthorityEvent({
      orderId: 101,
      orderLineId: 202,
      eventType: "line_inserted",
      sourceEventId: "webhook_inbox:10",
      authority,
    });

    expect(event).toMatchObject({
      eventType: "line_inserted",
      orderId: 101,
      orderLineId: 202,
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:10",
      sourceInboxId: 10,
      channelObservedQuantity: 3,
      paidQuantity: 3,
      authorityFulfillableQuantity: 2,
      authorizationStatus: "authorized",
      authorizedByEventId: "webhook_inbox:10",
    });
    expect(event.eventKey).toContain("line:202");
    expect(event.eventKey).toContain("source:webhook_inbox:10");
  });

  it("records previous authority snapshots for update auditability", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:11",
      sourceInboxId: 11,
      financialStatus: "paid",
      quantity: 1,
      previous: {
        paidQuantity: 4,
        authorityFulfillableQuantity: 4,
        authorizationStatus: "authorized",
        authorizedAt: new Date("2026-06-25T12:00:00.000Z"),
        authorizedByEventId: "webhook_inbox:10",
      },
    });

    const event = buildOmsLineAuthorityEvent({
      orderId: 101,
      orderLineId: 202,
      eventType: "line_updated",
      sourceEventId: "webhook_inbox:11",
      previous: {
        channelObservedQuantity: 4,
        paidQuantity: 4,
        authorityFulfillableQuantity: 4,
        authorizationStatus: "authorized",
      },
      authority,
    });

    expect(event).toMatchObject({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:11",
      previousChannelObservedQuantity: 4,
      previousPaidQuantity: 4,
      previousAuthorityFulfillableQuantity: 4,
      previousAuthorizationStatus: "authorized",
      channelObservedQuantity: 1,
      paidQuantity: 1,
      authorityFulfillableQuantity: 1,
    });
  });

  it("includes line disposition counters in both the event and idempotency key", () => {
    const authority = deriveOmsLineAuthority({
      sourceTopic: "refunds/create",
      sourceEventId: "refund:1036275548319",
      financialStatus: "paid",
      quantity: 25,
      fulfillableQuantity: 0,
      now: new Date("2026-07-10T16:00:00.000Z"),
    });

    const event = buildOmsLineAuthorityEvent({
      orderId: 242960,
      orderLineId: 110466,
      eventType: "line_updated",
      authority,
      cancelledQuantity: 0,
      refundedQuantity: 25,
    });

    expect(event.cancelledQuantity).toBe(0);
    expect(event.refundedQuantity).toBe(25);
    expect(event.eventKey).toContain("cancelled:0");
    expect(event.eventKey).toContain("refunded:25");
  });

  it("keeps authority state writes paired with ledger writes in service and webhook paths", () => {
    expect(OMS_SERVICE_SRC).toMatch(/recordOmsLineAuthorityEvent/);
    expect(OMS_SERVICE_SRC).toMatch(/eventType: "line_inserted"/);
    expect(OMS_SERVICE_SRC).toMatch(/eventType: "line_updated"/);
    expect(OMS_SERVICE_SRC).toMatch(/db\.transaction\(async \(tx: any\) => \{[\s\S]*recordOmsLineAuthorityEvent/);

    expect(OMS_WEBHOOKS_SRC).toMatch(/recordOmsLineAuthorityEvent/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/eventType: "line_inserted"/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/eventType: "line_updated"/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/eventType: "line_removed"/);
  });
});
