import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OMS_ORDERS_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/OmsOrders.tsx"),
  "utf8",
);
const FLOW_MONITOR_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/FlowMonitor.tsx"),
  "utf8",
);
const OMS_ROUTES_SOURCE = readFileSync(
  resolve(__dirname, "../../../../routes/oms.routes.ts"),
  "utf8",
);
const REPLACEMENT_MIGRATION_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../migrations/0587_shipment_replacement_authority.sql"),
  "utf8",
);
const OMISSION_CORRECTION_MIGRATION_SOURCE = readFileSync(
  resolve(__dirname, "../../../../../migrations/183_omission_correction_shipment_item_authority.sql"),
  "utf8",
);
const SHIPMENT_ROLLUP_SOURCE = readFileSync(
  resolve(__dirname, "../../../orders/shipment-rollup.ts"),
  "utf8",
);

describe("Control Tower flow action ownership", () => {
  it("keeps cross-system health off the OMS order-list request path", () => {
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/health');
    expect(OMS_ORDERS_SOURCE).not.toContain('OMS/WMS Flow Health');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-inbox/');
    expect(OMS_ORDERS_SOURCE).not.toContain('/api/oms/ops/webhook-retry/');
    expect(OMS_ORDERS_SOURCE).toContain('href="/oms/flow-monitor"');
  });

  it("renders replay controls from existing Control Tower evidence", () => {
    expect(FLOW_MONITOR_SOURCE).toContain("resolveFlowReplayAction(selectedIssue, replayStatus");
    expect(FLOW_MONITOR_SOURCE).toContain("replayMutation.mutate(replayAction)");
    expect(FLOW_MONITOR_SOURCE).toContain('hasPermission("operations", "triage")');
  });

  it("shows durable replay outcomes and polls while replay work is pending", () => {
    expect(FLOW_MONITOR_SOURCE).toContain("Recent replay activity");
    expect(FLOW_MONITOR_SOURCE).toContain('item.outcome === "queued" || item.outcome === "retrying"');
    expect(FLOW_MONITOR_SOURCE).toContain("Live {bucketQuery.data?.rows.length.toLocaleString()");
    expect(FLOW_MONITOR_SOURCE).toContain("normally within five minutes");
    expect(OMS_ROUTES_SOURCE).toContain('res.setHeader("Cache-Control", "private, no-store")');
  });

  it("requires the Control Tower triage permission at every replay endpoint", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-inbox\/:id\/replay"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toMatch(
      /webhook-retry\/:id\/requeue"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toMatch(
      /reconciliation\/remediate"[\s\S]{0,160}requirePermission\("operations", "triage"\)/,
    );
  });

  it("classifies unmapped physical shipments without assuming every label is a reship", () => {
    expect(FLOW_MONITOR_SOURCE).toContain('selectedIssue.code === "UNMAPPED_ENGINE_SPLIT"');
    expect(FLOW_MONITOR_SOURCE).toContain("Classify package");
    expect(FLOW_MONITOR_SOURCE).toContain("Resolve as voided label");
    expect(FLOW_MONITOR_SOURCE).toContain("Record shipment");
    expect(FLOW_MONITOR_SOURCE).not.toContain("A replacement package was shipped");
    expect(FLOW_MONITOR_SOURCE).not.toContain("Match remaining fulfillment");
    expect(FLOW_MONITOR_SOURCE).not.toContain("Keep under review");
    expect(FLOW_MONITOR_SOURCE).toContain('hasPermission("inventory", "adjust")');
  });

  it("guards physical-package mutations with triage and inventory permissions", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /shipstation-unmapped\/adopt-reship"[\s\S]{0,180}requirePermission\("operations", "triage"\)/,
    );
    expect(OMS_ROUTES_SOURCE).toContain('hasPermission(userId, "inventory", "adjust")');
    expect(OMS_ROUTES_SOURCE).toContain('error: "Permission denied: inventory:adjust"');
  });

  it("uses triage-only authority for the verified no-inventory voided-label disposition", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /shipstation-unmapped\/resolve-voided-label"[\s\S]{0,180}requirePermission\("operations", "triage"\)/,
    );
    expect(FLOW_MONITOR_SOURCE).toContain(
      "The exception was closed without changing inventory or fulfillment.",
    );
  });

  it("uses triage-only authority for provider-declared return labels", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /shipstation-unmapped\/resolve-return-label"[\s\S]{0,180}requirePermission\("operations", "triage"\)/,
    );
    expect(FLOW_MONITOR_SOURCE).toContain("ShipStation reports a return label");
    expect(FLOW_MONITOR_SOURCE).toContain("Resolve return label");
    expect(FLOW_MONITOR_SOURCE).toContain(
      "Its immutable package link remains for audit, while return direction excludes it from outbound dispatch authority.",
    );
  });

  it("links exact provider-package echoes without inventory adjustment authority", () => {
    expect(OMS_ROUTES_SOURCE).toMatch(
      /shipstation-unmapped\/resolve-provider-echo"[\s\S]{0,180}requirePermission\("operations", "triage"\)/,
    );
    expect(FLOW_MONITOR_SOURCE).toContain("Link provider evidence");
    expect(FLOW_MONITOR_SOURCE).toContain(
      "Inventory, customer fulfillment, and sales-channel fulfillment remain unchanged.",
    );
  });

  it("keeps replacement inventory lineage outside customer fulfillment authority", () => {
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("shipment_purpose");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("replaces_shipment_id");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("replacement_for_order_item_id");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain("ON DELETE RESTRICT");
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain(
      "shipment_purpose = 'customer_fulfillment'",
    );
    expect(REPLACEMENT_MIGRATION_SOURCE).toContain(
      "CHECK (order_item_id IS NULL OR replacement_for_order_item_id IS NULL)",
    );
    expect(SHIPMENT_ROLLUP_SOURCE).toContain(
      "COALESCE(shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'",
    );
  });
  it("classifies an original packing omission without repeating inventory or fulfillment authority", () => {
    expect(FLOW_MONITOR_SOURCE).toContain('value="packing_omission"');
    expect(FLOW_MONITOR_SOURCE).toContain("Item was missing from original box");
    expect(FLOW_MONITOR_SOURCE).toContain("Missing from original box - already deducted");
    expect(FLOW_MONITOR_SOURCE).toContain('lineDisposition: manualLineDispositions');
    expect(FLOW_MONITOR_SOURCE).toContain('lineDisposition: providerLineDispositions');
    expect(FLOW_MONITOR_SOURCE).toContain('value === "packing_omission"');

    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "correction_for_shipment_item_id",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "correction_for_physical_shipment_item_id",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "shipment_item_purpose = 'omission_correction'",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "outbound_shipment_items_omission_inventory_proof_chk",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "outbound_shipment_items_omission_source_ambiguity_chk",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain(
      "trg_enforce_physical_shipment_item_correction_lineage",
    );
    expect(OMISSION_CORRECTION_MIGRATION_SOURCE).toContain("ON DELETE RESTRICT");
  });
  it("supports operator-confirmed mixed replacement contents without discarding provider evidence", () => {
    expect(FLOW_MONITOR_SOURCE).toContain('contentsAuthority: actualContentsMode ? "operator" : "provider"');
    expect(FLOW_MONITOR_SOURCE).toContain("Use ShipStation contents");
    expect(FLOW_MONITOR_SOURCE).toContain("Confirm actual contents");
    expect(FLOW_MONITOR_SOURCE).toContain("ShipStation reported");
    expect(FLOW_MONITOR_SOURCE).toContain("...selectedManualItems.map");
    expect(FLOW_MONITOR_SOURCE).toContain("...catalogItems.map");
    expect(FLOW_MONITOR_SOURCE).toContain("Courtesy replacement or free item");
    expect(OMS_ROUTES_SOURCE).toContain("contentsAuthority: req.body?.contentsAuthority");
  });
});
