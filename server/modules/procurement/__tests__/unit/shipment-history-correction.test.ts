import { describe, expect, it } from "vitest";
import { historyContext, historyInput } from "../../../../../test/fixtures/shipment-history-correction";
import { shipmentHistoryInputSchema } from "@shared/procurement/shipment-history-correction";
import { historyCorrectionBlock, planShipmentHistoryCorrection, shipmentHistoryIssues } from "../../domain/shipment-history-correction";

const now = new Date("2026-10-23T12:00:00Z");
const protectedVersion = "b".repeat(64);
describe("shipment history correction policy", () => {
  it("reclassifies only the reviewed manifest, keeping conflicting receipts and exact charges visible", () => {
    const context = historyContext(), original = structuredClone(context);
    const review = planShipmentHistoryCorrection(context, historyInput(), protectedVersion, now);
    expect(review).toMatchObject({ plannedPiecesBefore: 100000, plannedPiecesAfter: 0, shippedPiecesBefore: 0, shippedPiecesAfter: 100000,
      lines: context.lines, receipts: context.receipts, charges: [{ currency: "USD", cents: 165191 }], issues: context.issues, protectedRecordsVersion: protectedVersion });
    expect(context).toEqual(original);
  });
  it("can confirm departure without inventing delivery", () => {
    expect(planShipmentHistoryCorrection(historyContext(), { ...historyInput(), status: "in_transit", deliveredOn: null }, protectedVersion, now).after)
      .toEqual({ status: "in_transit", departedOn: "2026-03-12", deliveredOn: null });
  });
  it.each(["closed", "costing", "delivered", "cancelled", "unknown"])("cannot reopen or bypass the %s workflow", status => {
    const context = historyContext(); context.current.status = status; context.blockedReason = historyCorrectionBlock(status, 1);
    expect(() => planShipmentHistoryCorrection(context, historyInput(), protectedVersion, now)).toThrow(/History correction is available before delivery/);
  });
  it("requires current admin authority and the reviewed source version", () => {
    expect(() => planShipmentHistoryCorrection({ ...historyContext(), canApprove: false }, historyInput(), protectedVersion, now)).toThrow(/Administrator/);
    expect(() => planShipmentHistoryCorrection(historyContext(), historyInput("c".repeat(64)), protectedVersion, now)).toThrow(/changed/);
  });
  it.each([
    { departedOn: "2026-10-24" }, { deliveredOn: "2026-03-11" }, { deliveredOn: "2027-01-01" },
    { deliveredOn: null }, { status: "in_transit" as const, deliveredOn: "2026-03-19" },
  ])("rejects unsupported document dates %j", patch => {
    expect(() => planShipmentHistoryCorrection(historyContext(), { ...historyInput(), ...patch }, protectedVersion, now)).toThrow(/date/i);
  });
  it("never moves transit backwards or accepts an empty manifest", () => {
    const context = historyContext(); context.current.status = "at_port";
    expect(() => planShipmentHistoryCorrection(context, { ...historyInput(), status: "in_transit", deliveredOn: null }, protectedVersion, now)).toThrow(/backwards/);
    expect(historyCorrectionBlock("booked", 0)).toMatch(/documented shipment lines/);
  });
  it("validates exact calendar dates, affirmative evidence, unknown fields and quantities at the boundary", () => {
    for (const input of [{ ...historyInput(), departedOn: "2026-02-30" }, { ...historyInput(), evidenceConfirmed: false }, { ...historyInput(), pieces: 200000 }]) {
      expect(shipmentHistoryInputSchema.safeParse(input).success).toBe(false);
    }
    const context = historyContext(); context.lines = [context.lines[0], { ...context.lines[0], id: 202, pieces: Number.MAX_SAFE_INTEGER }];
    expect(() => planShipmentHistoryCorrection(context, historyInput(), protectedVersion, now)).toThrow(/supported piece count/);
  });
  it("does not accuse a split shipment when other shipped pieces explain the received total", () => {
    const context = historyContext();
    const lines = [{ ...context.lines[0], postedReceiptPieces: 200000, otherShippedPieces: 100000 }];
    expect(shipmentHistoryIssues(lines, [], 42)).toEqual([]);
    expect(shipmentHistoryIssues(context.lines, context.receipts, 42)).toHaveLength(3);
  });
});
