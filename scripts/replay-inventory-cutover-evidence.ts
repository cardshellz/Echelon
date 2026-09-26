/** Offline, hash-pinned cutover regression proof. No DB, provider or apply mode. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openingSourceSchema, requiredOpeningItems } from "../shared/types/inventory-cutover-opening";
import { cutoverReconstructionEvidenceSchema, type CutoverReconstructionEvidence } from "../shared/types/inventory-cutover-reconstruction";
import { planCutoverReconstruction, reconstructionEvidenceHash, reconstructionHash } from "../server/modules/inventory-planning/domain/inventory-cutover-reconstruction";

const id = z.number().int().positive();
const policyRowSchema = z.object({
  line_id: z.string().regex(/^[1-9][0-9]*$/), product_variant_id: id.nullable(), catalog_product_id: id.nullable(),
  inventory_tracking: z.boolean().nullable(), source_sku: z.string().nullable(),
  wms_item_id: id.nullable(), wms_variant_id: id.nullable(), wms_catalog_product_id: id.nullable(),
  wms_inventory_tracking: z.boolean().nullable(), wms_sku: z.string().nullable(), quantity: z.number().int().nullable(),
});
const packetSchema = z.object({ source: openingSourceSchema, productionWrites: z.literal(false),
  diagnostics: z.object({ read_only: z.literal("on"), policyRows: z.array(policyRowSchema) }) });

/** Supplemental fields must be from the same immutable capture and agree with
 * its existing identities/quantities. They enrich evidence, never rewrite it. */
export function includeCapturedOrderPolicies(raw: unknown): CutoverReconstructionEvidence {
  const packet = packetSchema.parse(raw);
  assert.equal(reconstructionEvidenceHash(packet.source.evidence), packet.source.evidenceHash, "Captured source evidence hash changed");
  const evidence = packet.source.evidence;
  const byLine = new Map<string, z.infer<typeof policyRowSchema>[]>();
  const byItem = new Map<number, z.infer<typeof policyRowSchema>>();
  for (const row of packet.diagnostics.policyRows) {
    const rows = byLine.get(row.line_id) ?? []; rows.push(row); byLine.set(row.line_id, rows);
    if (row.wms_item_id !== null) {
      assert.ok(!byItem.has(row.wms_item_id), "Duplicate supplemental WMS owner");
      byItem.set(row.wms_item_id, row);
    }
  }
  assert.equal(byLine.size, evidence.acceptedOmsDemand.length, "Supplemental OMS census is incomplete or contains extra lines");
  const enriched = cutoverReconstructionEvidenceSchema.parse({ ...evidence,
    acceptedOmsDemand: evidence.acceptedOmsDemand.map(line => {
      const rows = byLine.get(line.lineId); assert.ok(rows?.length, "Missing accepted-line policy evidence");
      for (const row of rows) {
        assert.equal(row.product_variant_id, line.productVariantId); assert.equal(row.source_sku, line.sku);
        assert.equal(row.inventory_tracking, rows[0].inventory_tracking); assert.equal(row.catalog_product_id, rows[0].catalog_product_id);
        if (line.inventoryTracking !== undefined) assert.equal(line.inventoryTracking, row.inventory_tracking);
        if (line.catalogProductId !== undefined) assert.equal(line.catalogProductId, row.catalog_product_id);
      }
      return { ...line, inventoryTracking: rows[0].inventory_tracking, catalogProductId: rows[0].catalog_product_id };
    }),
    items: evidence.items.map(item => {
      const row = byItem.get(item.id); if (!row) return item;
      assert.equal(row.line_id, item.omsOrderLineId); assert.equal(row.wms_variant_id, item.productId);
      assert.equal(row.wms_sku, item.sku); assert.equal(row.quantity, item.quantity);
      if (item.inventoryTracking !== undefined) assert.equal(item.inventoryTracking, row.wms_inventory_tracking);
      if (item.catalogProductId !== undefined) assert.equal(item.catalogProductId, row.wms_catalog_product_id);
      byItem.delete(item.id);
      return { ...item, inventoryTracking: row.wms_inventory_tracking, catalogProductId: row.wms_catalog_product_id };
    }),
  });
  assert.equal(byItem.size, 0, "Supplemental policy names an uncaptured WMS owner");
  return enriched;
}

function pinnedJson(path: string, expected: string): unknown {
  assert.match(expected, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(resolve(path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, "Input artifact fingerprint changed");
  return JSON.parse(bytes.toString("utf8"));
}

function main(args: readonly string[]): void {
  const [captureFile, captureHash, previousPlanFile, previousPlanHash, outputFile, extra] = args;
  assert.ok(captureFile && captureHash && previousPlanFile && previousPlanHash && outputFile && !extra,
    "Usage: replay-inventory-cutover-evidence <capture> <sha256> <prior-plan> <sha256> <new-output-file>");
  const packet = packetSchema.parse(pinnedJson(captureFile, captureHash));
  const previous = z.object({ evidenceHash: z.string(), blockers: z.array(z.object({ code: z.string(), subject: z.string(), message: z.string() })),
    orders: z.array(z.unknown()) }).parse(pinnedJson(previousPlanFile, previousPlanHash));
  assert.equal(previous.evidenceHash, packet.source.evidenceHash, "Prior plan does not belong to this source");
  const evidence = includeCapturedOrderPolicies(packet);
  const current = planCutoverReconstruction(evidence);
  const blockerKey = (row: { code: string; subject: string }) => `${row.code}:${row.subject}`;
  const beforeKeys = new Set(previous.blockers.map(blockerKey)), afterKeys = new Set(current.blockers.map(blockerKey));
  const required = requiredOpeningItems(evidence);
  const group = (codes: readonly string[]) => codes.reduce<Record<string, number>>((counts, code) => {
    counts[code] = (counts[code] ?? 0) + 1; return counts;
  }, {});
  const output = { schemaVersion: "inventory_cutover_evidence_replay_v1", productionWrites: false, executable: false,
    sourceCaptureHash: captureHash, previousPlanHash, capturedAt: packet.source.capturedAt,
    originalEvidenceHash: packet.source.evidenceHash, enrichedEvidenceHash: current.evidenceHash,
    removedBlockers: previous.blockers.filter(row => !afterKeys.has(blockerKey(row))),
    addedBlockers: current.blockers.filter(row => !beforeKeys.has(blockerKey(row))),
    plannedInventoryOrdersUnchanged: reconstructionHash(previous.orders) === reconstructionHash(current.orders),
    remainingStrictBlockers: group(current.blockers.map(row => row.code)),
    requiredOpeningOwnerCount: required.length,
    requiredUnstartedOwnerCount: required.filter(item => item.pickedQuantity === 0 && item.fulfilledQuantity === 0).length,
    // Only accepted demand had supplemental policy fields in old captures.
    // Fresh runtime captures include saved policy on every WMS census item.
    acceptedDemandPolicyCount: evidence.acceptedOmsDemand.length,
    wmsPolicyCount: evidence.items.filter(item => item.inventoryTracking !== undefined).length,
    inventoryItemCount: evidence.items.length,
    caveat: "This is a regression replay, not a verified opening or cutover authorization. Historical findings and current obligations remain separate." };
  assert.equal(reconstructionEvidenceHash(packet.source.evidence), packet.source.evidenceHash, "Replay mutated source evidence");
  const bytes = JSON.stringify(output, null, 2) + "\n";
  writeFileSync(resolve(outputFile), bytes, { flag: "wx" });
  console.log(JSON.stringify({ outputFile: resolve(outputFile), sha256: createHash("sha256").update(bytes).digest("hex"), ...output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ code: "CUTOVER_EVIDENCE_REPLAY_FAILED", message: error instanceof Error ? error.message : "Unknown error" })); process.exitCode = 1; }
}
