import { describe, expect, it } from "vitest";
import {
  buildInvoiceSchedulePresetNote,
  computePoLinearStageStates,
  computeShipmentDeliverySteps,
} from "../po-linear-workspace-helpers";

describe("UI-2 Linear PO Workspace & 1-Click Shipment Helpers", () => {
  describe("computeShipmentDeliverySteps", () => {
    it("returns exact server-valid transition paths to fast-forward a shipment to delivered", () => {
      expect(computeShipmentDeliverySteps("draft")).toEqual(["book", "in-transit", "delivered"]);
      expect(computeShipmentDeliverySteps("booked")).toEqual(["in-transit", "delivered"]);
      expect(computeShipmentDeliverySteps("in_transit")).toEqual(["delivered"]);
      expect(computeShipmentDeliverySteps("at_port")).toEqual(["customs-clearance", "delivered"]);
      expect(computeShipmentDeliverySteps("customs_clearance")).toEqual(["delivered"]);
      expect(computeShipmentDeliverySteps("delivered")).toEqual([]);
      expect(computeShipmentDeliverySteps("closed")).toEqual([]);
      expect(computeShipmentDeliverySteps("cancelled")).toEqual([]);
    });
  });

  describe("computePoLinearStageStates", () => {
    it("marks Stage 1 as current for a draft PO with lines and later stages as upcoming", () => {
      const stages = computePoLinearStageStates({
        poStatus: "draft",
        physicalStatus: "draft",
        linesCount: 2,
        totalOrderedPieces: 5000,
        totalReceivedPieces: 0,
        linkedShipmentsCount: 0,
        allShipmentsDeliveredOrLater: false,
        financialCompletionSupported: false,
        financialReviewRequired: false,
        linkedInvoicesCount: 0,
        inventoryCostingStatus: "no_costs",
        costReviewLinesCount: 0,
        unallocatedChargeCount: 0,
      });

      expect(stages.map((s) => [s.id, s.state])).toEqual([
        ["order", "current"],
        ["bills", "upcoming"],
        ["shipping", "upcoming"],
        ["receiving", "upcoming"],
        ["cogs", "upcoming"],
      ]);
    });

    it("advances order to done and bills + shipping to current once PO is sent", () => {
      const stages = computePoLinearStageStates({
        poStatus: "sent",
        physicalStatus: "sent",
        linesCount: 3,
        totalOrderedPieces: 10000,
        totalReceivedPieces: 0,
        linkedShipmentsCount: 1,
        allShipmentsDeliveredOrLater: false,
        financialCompletionSupported: false,
        financialReviewRequired: false,
        linkedInvoicesCount: 0,
        inventoryCostingStatus: "no_costs",
        costReviewLinesCount: 0,
        unallocatedChargeCount: 0,
      });

      expect(stages.map((s) => [s.id, s.state])).toEqual([
        ["order", "done"],
        ["bills", "current"],
        ["shipping", "current"],
        ["receiving", "upcoming"],
        ["cogs", "current"],
      ]);
    });

    it("marks shipping done and receiving current when container is delivered at dock", () => {
      const stages = computePoLinearStageStates({
        poStatus: "acknowledged",
        physicalStatus: "in_transit",
        linesCount: 2,
        totalOrderedPieces: 2000,
        totalReceivedPieces: 0,
        linkedShipmentsCount: 1,
        allShipmentsDeliveredOrLater: true,
        financialCompletionSupported: false,
        financialReviewRequired: true,
        linkedInvoicesCount: 1,
        inventoryCostingStatus: "review_required",
        costReviewLinesCount: 1,
        unallocatedChargeCount: 0,
      });

      expect(stages.map((s) => [s.id, s.state])).toEqual([
        ["order", "done"],
        ["bills", "attention"],
        ["shipping", "done"],
        ["receiving", "current"],
        ["cogs", "attention"],
      ]);
    });

    it("marks all 5 stages done when fully received, settled, and landed costs applied", () => {
      const stages = computePoLinearStageStates({
        poStatus: "received",
        physicalStatus: "received",
        linesCount: 2,
        totalOrderedPieces: 2000,
        totalReceivedPieces: 2000,
        linkedShipmentsCount: 1,
        allShipmentsDeliveredOrLater: true,
        financialCompletionSupported: true,
        financialReviewRequired: false,
        linkedInvoicesCount: 1,
        inventoryCostingStatus: "applied",
        costReviewLinesCount: 0,
        unallocatedChargeCount: 0,
      });

      expect(stages.every((s) => s.state === "done")).toBe(true);
    });
  });

  describe("buildInvoiceSchedulePresetNote", () => {
    it("computes exact 30% / 50% / 70% / 100% USD schedule notes without cent drift", () => {
      const p30 = buildInvoiceSchedulePresetNote("deposit_30", "PO-2026-101", 100000);
      const p70 = buildInvoiceSchedulePresetNote("balance_70", "PO-2026-101", 100000);
      expect(p30.targetCents + p70.targetCents).toBe(100000);
      expect(p30.note).toContain("$300.00 of $1,000.00");
      expect(p70.note).toContain("$700.00 remaining of $1,000.00");

      const p50 = buildInvoiceSchedulePresetNote("deposit_50", "PO-2026-101", 33333);
      expect(p50.targetCents).toBe(16667);
      expect(buildInvoiceSchedulePresetNote("full", "PO-2026-101", 33333).note).toBe("");
    });
  });
});
