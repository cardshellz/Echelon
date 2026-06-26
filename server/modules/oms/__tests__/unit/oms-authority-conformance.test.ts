import { describe, expect, it } from "vitest";

import {
  deriveOmsLineAuthority,
  getOmsLineMaterializableQuantity,
  getOmsLineRemainingMaterializableQuantity,
} from "../../oms-line-authority";
import { buildOmsLineAuthorityEvent } from "../../oms-line-authority-ledger";

const NOW = new Date("2026-06-26T14:00:00.000Z");

describe("OMS/WMS authority conformance :: Shopify event ordering", () => {
  it("keeps orders/updated-before-paid lines visible but not WMS-materializable until paid evidence arrives", () => {
    const updateOnly = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:update-before-paid",
      sourceInboxId: 101,
      financialStatus: "paid",
      quantity: 2,
      fulfillableQuantity: 2,
      now: NOW,
    });

    expect(updateOnly).toMatchObject({
      channelObservedQuantity: 2,
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
      authorizationStatus: "seen",
      authorizedAt: null,
      authorizedByEventId: null,
    });
    expect(getOmsLineMaterializableQuantity(updateOnly)).toBe(0);
    expect(getOmsLineRemainingMaterializableQuantity({
      ...updateOnly,
      wmsMaterializedQuantity: 0,
    })).toBe(0);

    const paidAfterUpdate = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:paid-after-update",
      sourceInboxId: 102,
      financialStatus: "paid",
      quantity: 2,
      fulfillableQuantity: 2,
      previous: updateOnly,
      now: new Date("2026-06-26T14:05:00.000Z"),
    });

    expect(paidAfterUpdate).toMatchObject({
      channelObservedQuantity: 2,
      paidQuantity: 2,
      authorityFulfillableQuantity: 2,
      authorizationStatus: "authorized",
      authorizedByEventId: "webhook_inbox:paid-after-update",
    });
    expect(getOmsLineRemainingMaterializableQuantity({
      ...paidAfterUpdate,
      wmsMaterializedQuantity: 0,
    })).toBe(2);
  });

  it("keeps duplicate paid/create authority idempotent after WMS materialization consumes the line", () => {
    const firstPaid = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:paid-1",
      sourceInboxId: 201,
      financialStatus: "paid",
      quantity: 2,
      fulfillableQuantity: 2,
      now: NOW,
    });
    const duplicatePaid = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:paid-1",
      sourceInboxId: 201,
      financialStatus: "paid",
      quantity: 2,
      fulfillableQuantity: 2,
      previous: firstPaid,
      now: NOW,
    });

    expect(duplicatePaid).toMatchObject({
      paidQuantity: firstPaid.paidQuantity,
      authorityFulfillableQuantity: firstPaid.authorityFulfillableQuantity,
      authorizedByEventId: firstPaid.authorizedByEventId,
    });
    expect(getOmsLineRemainingMaterializableQuantity({
      ...duplicatePaid,
      wmsMaterializedQuantity: 2,
    })).toBe(0);

    const firstEvent = buildOmsLineAuthorityEvent({
      orderId: 301,
      orderLineId: 401,
      eventType: "line_inserted",
      sourceEventId: "webhook_inbox:paid-1",
      authority: firstPaid,
    });
    const duplicateEvent = buildOmsLineAuthorityEvent({
      orderId: 301,
      orderLineId: 401,
      eventType: "line_inserted",
      sourceEventId: "webhook_inbox:paid-1",
      authority: duplicatePaid,
    });

    expect(duplicateEvent.eventKey).toBe(firstEvent.eventKey);
  });

  it("does not authorize a newly added Shopify edit line from update-only evidence", () => {
    const unpaidEditLine = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:edit-added-unpaid",
      sourceInboxId: 301,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      now: NOW,
    });

    expect(unpaidEditLine).toMatchObject({
      channelObservedQuantity: 1,
      paidQuantity: 0,
      authorityFulfillableQuantity: 0,
      authorizationStatus: "seen",
    });
    expect(getOmsLineMaterializableQuantity(unpaidEditLine)).toBe(0);
  });

  it("authorizes a newly added Shopify edit line only when paid evidence arrives with an auditable source event", () => {
    const seenEditLine = deriveOmsLineAuthority({
      sourceTopic: "orders/updated",
      sourceEventId: "webhook_inbox:edit-added-seen",
      sourceInboxId: 401,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      now: NOW,
    });
    const paidEditLine = deriveOmsLineAuthority({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:edit-added-paid",
      sourceInboxId: 402,
      financialStatus: "paid",
      quantity: 1,
      fulfillableQuantity: 1,
      previous: seenEditLine,
      now: new Date("2026-06-26T14:10:00.000Z"),
    });

    const event = buildOmsLineAuthorityEvent({
      orderId: 501,
      orderLineId: 601,
      eventType: "line_updated",
      sourceEventId: "webhook_inbox:edit-added-paid",
      previous: {
        channelObservedQuantity: seenEditLine.channelObservedQuantity,
        paidQuantity: seenEditLine.paidQuantity,
        authorityFulfillableQuantity: seenEditLine.authorityFulfillableQuantity,
        authorizationStatus: seenEditLine.authorizationStatus,
      },
      authority: paidEditLine,
    });

    expect(paidEditLine).toMatchObject({
      channelObservedQuantity: 1,
      paidQuantity: 1,
      authorityFulfillableQuantity: 1,
      authorizationStatus: "authorized",
      authorizedByEventId: "webhook_inbox:edit-added-paid",
    });
    expect(event).toMatchObject({
      sourceTopic: "orders/paid",
      sourceEventId: "webhook_inbox:edit-added-paid",
      previousAuthorityFulfillableQuantity: 0,
      authorityFulfillableQuantity: 1,
      authorizedByEventId: "webhook_inbox:edit-added-paid",
    });
    expect(getOmsLineRemainingMaterializableQuantity({
      ...paidEditLine,
      wmsMaterializedQuantity: 0,
    })).toBe(1);
  });
});
