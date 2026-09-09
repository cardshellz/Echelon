import { describe, expect, it } from "vitest";
import { createOpeningWorksheet, OPENING_DOCUMENT_LIMIT_BYTES, parseOpeningDocument } from "../../inventory-cutover-opening-document";
import { openingSource, openingVerification } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

describe("complete opening worksheet transport size", () => {
  it("round-trips a complete 9000-line worksheet with 341 levels, 2371 lots and 4277 original cost references below 10MiB", () => {
    const source = openingSource(); const template = structuredClone(source.evidence);
    source.evidence.orders = Array.from({ length: 9_000 }, (_, index) => ({ ...template.orders[0], id: index + 1,
      externalOrderId: `synthetic-order-${index + 1}`, omsFulfillmentOrderId: `synthetic-fo-${index + 1}` }));
    source.evidence.items = Array.from({ length: 9_000 }, (_, index) => ({ ...template.items[0], id: index + 1,
      orderId: index + 1, sourceItemId: `synthetic-line-${index + 1}`, omsOrderLineId: String(index + 1) }));
    source.evidence.levels = Array.from({ length: 341 }, (_, index) => ({ ...template.levels[0], id: index + 1, warehouseLocationId: index + 1 }));
    source.evidence.lots = Array.from({ length: 2_371 }, (_, index) => ({ ...template.lots[0], id: index + 1, warehouseLocationId: index % 341 + 1 }));
    source.evidence.costs = Array.from({ length: 4_277 }, (_, index) => ({ ...template.costs[0], id: index + 1,
      orderId: index + 1, orderItemId: index + 1, inventoryLotId: index % 2_371 + 1 }));
    source.labels = [...source.evidence.orders.map(order => ({ kind: "order" as const, id: String(order.id), label: `Order #SYN-${order.id}` })),
      ...source.evidence.levels.map(level => ({ kind: "location" as const, id: String(level.warehouseLocationId), label: `Bin SYN-${level.id}` }))];
    const exported = createOpeningWorksheet(source);
    const document = JSON.parse(exported);
    expect(exported).not.toContain("\n");
    expect(new TextEncoder().encode(JSON.stringify(document, null, 2)).byteLength).toBeGreaterThan(OPENING_DOCUMENT_LIMIT_BYTES);
    expect(new TextEncoder().encode(exported).byteLength).toBeLessThan(OPENING_DOCUMENT_LIMIT_BYTES);
    expect(document.recordedReference.items).toHaveLength(9_000);
    expect(document.recordedReference.costs).toHaveLength(4_277);
    expect(document.verification.owners).toHaveLength(9_000);

    // Transport proof only: these synthetic observations exercise complete input
    // shape and sizing. The separate domain tests establish custody arithmetic.
    document.verification = { ...openingVerification(), expectedEvidenceHash: source.evidenceHash,
      expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
      levels: source.evidence.levels, lots: source.evidence.lots,
      owners: source.evidence.items.map((item, index) => ({ orderId: item.orderId, orderItemId: item.id,
        remainingQty: "6", reservedQty: "3", pickedQty: "0", allocations: [{ inventoryLevelId: index % 341 + 1,
          lots: [{ inventoryLotId: index % 2_371 + 1, reservedQty: "3", pickedQty: "0", originalCostIds: [] }] }] })) };
    const completed = JSON.stringify(document);
    expect(new TextEncoder().encode(completed).byteLength).toBeLessThan(OPENING_DOCUMENT_LIMIT_BYTES);
    const imported = parseOpeningDocument(completed, source);
    expect(imported.owners).toHaveLength(9_000);
    expect(imported.levels).toHaveLength(341);
    expect(imported.lots).toHaveLength(2_371);
    expect(document.recordedReference.costs).toHaveLength(4_277);
  });
});
