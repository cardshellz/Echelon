import { describe, expect, it } from "vitest";
import { proposeHistoricalWork } from "../../domain/inventory-cutover-history-proposal";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { HISTORY_HASH, HISTORY_TIME, historyFixture, resealHistoryFixture } from "../fixtures/inventory-cutover-history.fixture";

describe("non-executable historical work proposal", () => {
  it("proposes a fingerprinted complete batch without changing evidence or claiming production readiness", () => {
    const { source, facts } = historyFixture(), before = structuredClone({ source, facts });
    const result = proposeHistoricalWork(source, facts);
    expect(result).toMatchObject({
      executable: false, productionReady: false, blockers: [],
      groups: { settled_order_notification: 1, closed_shipment_intention: 1 }, preservedCurrentOrderItemIds: [11]
    });
    expect(result.decisions[1].sourceItemIds).toEqual([91]);
    expect({ source, facts }).toEqual(before);
    expect(proposeHistoricalWork(source, facts)).toEqual(result);
    facts.receipts[0].attemptsHash = "b".repeat(64);
    expect(proposeHistoricalWork(source, facts).proposalHash).not.toBe(result.proposalHash);
  });
  it("separates fulfilled digital notifications from stock demand without changing the order header", () => {
    const { source, facts } = historyFixture();
    facts.receipts[0].matchedOrders[0].status = "confirmed";
    facts.receipts[0].matchedOrders[0].lines[0].requiresShipping = false;
    expect(proposeHistoricalWork(source, facts).groups.fulfilled_digital_notification).toBe(1);
  });
  it("keeps unknown channel identity explicit rather than matching an external order ID across channels", () => {
    const { source, facts } = historyFixture(); Object.assign(facts.receipts[0], { sourceChannelId: null, linkedOrderId: null, matchedOrders: [] });
    const result = proposeHistoricalWork(source, facts);
    expect(result.groups.unresolved_channel_quarantine).toBe(1); expect(result.uncertainties).toHaveLength(1);
    expect(result.productionReady).toBe(false);
  });
  it.each(["lease", "missing_lease", "review_lease", "future", "quantity", "unknown_shipping", "owner", "channel", "scope", "unscoped_owner", "open_header", "no_lines"])("keeps unsafe receipt %s out of the batch", kind => {
    const { source, facts } = historyFixture(), r = facts.receipts[0], o = r.matchedOrders[0];
    if (kind === "lease") Object.assign(r, { status: "processing", leaseTokenPresent: true, leaseExpiresAt: "2026-09-28T00:00:00.000Z" });
    if (kind === "missing_lease") r.status = "processing";
    if (kind === "review_lease") r.leaseTokenPresent = true;
    if (kind === "future") r.createdAt = "2026-09-28T00:00:00.000Z";
    if (kind === "quantity") o.lines[0].fulfillmentStatus = "pending";
    if (kind === "unknown_shipping") { o.lines[0].requiresShipping = null; o.lines[0].fulfillmentStatus = "pending"; }
    if (kind === "owner") r.linkedOrderId = "99";
    if (kind === "channel") o.channelId = 37;
    if (kind === "scope") o.externalOrderId = "other";
    if (kind === "unscoped_owner") r.sourceChannelId = null;
    if (kind === "open_header") o.status = "confirmed";
    if (kind === "no_lines") o.lines = [];
    resealHistoryFixture(source, facts);
    const result = proposeHistoricalWork(source, facts);
    expect(result.blockers.length).toBeGreaterThan(0); expect(result.decisions.some(row => row.kind === "receipt")).toBe(false);
  });
  it("recognizes an expired lease but still requires a fenced audited retirement", () => {
    const { source, facts } = historyFixture(); Object.assign(facts.receipts[0], { status: "processing", leaseTokenPresent: true, leaseExpiresAt: HISTORY_TIME });
    resealHistoryFixture(source, facts);
    expect(proposeHistoricalWork(source, facts)).toMatchObject({ blockers: [], productionReady: false });
  });
  it.each(["current", "unknown", "owner_mismatch", "open_physical", "open_pick", "replacement", "unfinished", "labeled"])("preserves shipment %s for review", kind => {
    const { source, facts } = historyFixture(), s = facts.shipments[0];
    if (kind === "current") { s.orderId = 1; s.sources[0].owner!.orderId = 1; }
    if (kind === "unknown") s.orderStatus = null;
    if (kind === "owner_mismatch") s.sources[0].owner!.id = 22;
    if (kind === "open_physical") s.physicalStatuses = ["review"];
    if (kind === "open_pick") s.openPickCorrections = 1;
    if (kind === "replacement") s.sources[0].purpose = "replacement";
    if (kind === "unfinished") { s.status = "queued"; s.sources[0].owner!.fulfilledQuantity = 0; }
    if (kind === "labeled") s.status = "labeled";
    resealHistoryFixture(source, facts);
    const result = proposeHistoricalWork(source, facts);
    expect(result.blockers.length).toBeGreaterThan(0); expect(result.decisions.some(row => row.kind === "shipment")).toBe(false);
  });
  it("proposes retirement of obsolete queued posting debt without marking it shipped", () => {
    const { source, facts } = historyFixture(); facts.shipments[0].status = "queued"; resealHistoryFixture(source, facts);
    expect(proposeHistoricalWork(source, facts).groups.terminal_order_posting_debt).toBe(1);
    expect(source.evidence.sourceItems[0].shipmentStatus).toBe("queued");
  });
  it.each(["empty", "voided_package", "cancelled_replacement"])("retains closed %s intentions as history, not a new stock movement", kind => {
    const { source, facts } = historyFixture(), s = facts.shipments[0];
    if (kind === "empty") s.sources = [];
    if (kind === "voided_package") s.physicalStatuses = ["voided"];
    if (kind === "cancelled_replacement") Object.assign(s.sources[0], { purpose: "replacement", orderItemId: null, replacementForOrderItemId: 21 });
    resealHistoryFixture(source, facts);
    expect(proposeHistoricalWork(source, facts)).toMatchObject({ blockers: [], groups: { closed_shipment_intention: 1 } });
  });
  it.each(["exact", "different_package", "adjusted", "wrong_line", "wrong_variant", "duplicate_physical"])("requires exact original package proof for a correction: %s", kind => {
    const { source, facts } = historyFixture(), s = facts.shipments[0], item = s.sources[0];
    Object.assign(s, { status: "queued", purpose: "replacement", externalFulfillmentId: "shipstation_shipment:original" });
    Object.assign(item, { purpose: "omission_correction", orderItemId: null, correctionForSourceItemId: 80 });
    item.correctedPhysicalItems = [{
      id: "200", provider: "shipstation", providerShipmentId: "original", status: "shipped",
      sourceItemId: 80, orderItemId: 21, variantId: 101, quantity: 1, adjustmentQuantity: 0, rowHash: HISTORY_HASH
    }];
    const p = item.correctedPhysicalItems[0];
    if (kind === "different_package") p.providerShipmentId = "different";
    if (kind === "adjusted") p.adjustmentQuantity = -1;
    if (kind === "wrong_line") p.orderItemId = 22;
    if (kind === "wrong_variant") p.variantId = 102;
    if (kind === "duplicate_physical") item.correctedPhysicalItems.push({ ...p, id: "201" });
    resealHistoryFixture(source, facts);
    const result = proposeHistoricalWork(source, facts);
    expect(result.groups.duplicate_correction_intention).toBe(kind === "exact" ? 1 : undefined);
    expect(result.blockers.length).toBe(kind === "exact" ? 0 : 1);
  });
  it.each(["stale_source", "different_snapshot", "duplicate_receipt", "duplicate_source", "source_change", "omitted_source", "receipt_status"])("rejects %s evidence", kind => {
    const { source, facts } = historyFixture();
    if (kind === "stale_source") source.evidenceHash = "b".repeat(64);
    if (kind === "different_snapshot") facts.capturedAt = "2026-09-27T14:00:00.000Z";
    if (kind === "duplicate_receipt") facts.receipts.push({ ...facts.receipts[0] });
    if (kind === "duplicate_source") {
      source.evidence.sourceItems.push({ ...source.evidence.sourceItems[0] });
      source.evidenceHash = reconstructionEvidenceHash(source.evidence); facts.sourceEvidenceHash = source.evidenceHash;
    }
    if (kind === "source_change") facts.shipments[0].sources[0].quantity = 2;
    if (kind === "omitted_source") {
      source.evidence.sourceItems.push({ ...source.evidence.sourceItems[0], id: 92 });
      source.evidenceHash = reconstructionEvidenceHash(source.evidence); facts.sourceEvidenceHash = source.evidenceHash;
      // Even validly sealed inputs cannot omit a member of a selected header.
    }
    if (kind === "receipt_status") facts.receipts[0].status = "pending";
    expect(() => proposeHistoricalWork(source, facts)).toThrow();
  });
});
