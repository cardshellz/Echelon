import { describe, expect, it } from "vitest";
import { includeCapturedOrderPolicies } from "../../../../../scripts/replay-inventory-cutover-evidence";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";

function packet() {
  const evidence = reconstructionEvidence();
  evidence.acceptedOmsDemand = [{ lineId: "11", orderId: "9", sku: null, productVariantId: 101,
    authorizedQty: "6", materializedQty: "6", authorizationStatus: "authorized" }];
  return { productionWrites: false, source: { contractVersion: "inventory_cutover_opening_source_v1",
    capturedAt: "2026-09-26T18:15:44.330Z", runtimeAuthority: "legacy", authorityRevision: "1",
    configurationRunId: null, labels: [], latestVerification: null, evidenceHash: reconstructionEvidenceHash(evidence), evidence },
  diagnostics: { read_only: "on", policyRows: [{ line_id: "11", product_variant_id: 101, catalog_product_id: 20,
    inventory_tracking: false, source_sku: null, wms_item_id: 11, wms_variant_id: 101,
    wms_catalog_product_id: 20, wms_inventory_tracking: false, wms_sku: "P5", quantity: 6 }] } };
}

describe("hash-pinned offline cutover policy replay", () => {
  it("only adds captured policy facts and never mutates its immutable input", () => {
    const input = packet(), before = structuredClone(input);
    const evidence = includeCapturedOrderPolicies(input);
    expect(evidence.items[0]).toMatchObject({ inventoryTracking: false, catalogProductId: 20 });
    expect(evidence.acceptedOmsDemand[0]).toMatchObject({ inventoryTracking: false, catalogProductId: 20 });
    expect(input).toEqual(before);
  });
  it.each(["hash", "missing", "duplicate", "foreign_item", "wrong_quantity", "wrong_variant", "wrong_source_sku", "policy_overwrite"]) (
    "rejects %s instead of making unsupported evidence", kind => {
      const input = packet();
      if (kind === "hash") input.source.evidenceHash = "f".repeat(64);
      if (kind === "missing") input.diagnostics.policyRows = [];
      if (kind === "duplicate") input.diagnostics.policyRows.push({ ...input.diagnostics.policyRows[0] });
      if (kind === "foreign_item") input.diagnostics.policyRows[0].wms_item_id = 99;
      if (kind === "wrong_quantity") input.diagnostics.policyRows[0].quantity = 5;
      if (kind === "wrong_variant") input.diagnostics.policyRows[0].wms_variant_id = 102;
      if (kind === "wrong_source_sku") input.source.evidence.acceptedOmsDemand[0].sku = "WRONG";
      if (kind === "policy_overwrite") {
        input.source.evidence.items[0].inventoryTracking = true;
        input.source.evidenceHash = reconstructionEvidenceHash(input.source.evidence);
      }
      expect(() => includeCapturedOrderPolicies(input)).toThrow();
    },
  );
});
