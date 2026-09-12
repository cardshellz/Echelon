import { webcrypto } from "node:crypto";
import Papa from "papaparse";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningSpreadsheets, OPENING_SPREADSHEET_LIMIT_BYTES,
  parseOpeningSpreadsheets } from "../../inventory-cutover-opening-spreadsheet";
import { openingSource } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

type Row = Record<string, string>;

function edit(csv: string, change: (rows: Row[]) => void): string {
  const parsed = Papa.parse<Row>(csv, { header: true, skipEmptyLines: "greedy",
    transformHeader: (header) => header.replace(/^\uFEFF/, "") });
  change(parsed.data);
  return Papa.unparse({ fields: parsed.meta.fields ?? [], data: parsed.data });
}

function completedDocuments() {
  const source = openingSource();
  const sheets = createOpeningSpreadsheets(source);
  sheets.stock = edit(sheets.stock, ([row]) => {
    row.enter_verified_on_hand = "20";
    row.enter_verified_reserved = "3";
    row.enter_verified_picked = "2";
  });
  sheets.orders = edit(sheets.orders, ([row]) => {
    row.enter_verified_remaining = "6";
    row.enter_verified_physical_reserved = "3";
    row.enter_verified_physical_picked = "2";
  });
  sheets.allocations = edit(sheets.allocations, ([row]) => {
    row.enter_verified_reserved = "3";
    row.enter_verified_picked = "2";
    row.enter_original_cost_ids_or_all = "ALL";
  });
  return { source, sheets, documents: [
    { name: "inventory-opening-open-orders.csv", text: sheets.orders },
    { name: "inventory-opening-lot-ownership.csv", text: sheets.allocations },
    { name: "inventory-opening-stock-and-lots.csv", text: sheets.stock },
  ] };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("operator inventory opening spreadsheets", () => {
  it("exports recognizable stock, order and ownership rows with only verification cells blank", () => {
    const source = openingSource();
    const before = structuredClone(source);
    const sheets = createOpeningSpreadsheets(source);
    expect(sheets.stock).toContain("sku,warehouse,bin");
    expect(sheets.stock).toContain("P5");
    expect(sheets.stock).toContain("PICK-A-01");
    expect(sheets.stock).toContain("9007199254740.995");
    expect(sheets.orders).toContain("Order #CS-1001");
    expect(sheets.orders).toContain("external_order_id");
    expect(sheets.allocations).toContain("available_original_cost_ids");
    expect(sheets.allocations).toContain("9: qty 2 at $9007199254740.995");
    expect(sheets.stock).not.toContain("inventory_cutover_opening_v2");
    expect(source).toEqual(before);
  });

  it("constructs and hashes the strict audited contract from completed CSVs in any selection order", async () => {
    const { source, documents } = completedDocuments();
    const verification = await parseOpeningSpreadsheets(documents, source, {
      verificationReference: "Warehouse count COUNT-2026-09-12",
      verifiedAt: "2026-09-09T12:00:00.000Z",
      reservationBasis: "verified_current_lot_custody",
    });
    expect(verification).toMatchObject({
      contractVersion: "inventory_cutover_opening_v2",
      expectedEvidenceHash: source.evidenceHash,
      verificationReference: "Warehouse count COUNT-2026-09-12",
      verifiedAt: "2026-09-09T12:00:00.000Z",
      reservationBasis: "verified_current_lot_custody",
      lots: [{ id: 4, onHandQty: "20", reservedQty: "3", pickedQty: "2", unitCostMills: "9007199254740995" }],
      owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
        allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }],
    });
    expect(verification.verificationEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects partial coverage, edited identities and implicit blank quantities", async () => {
    const first = completedDocuments();
    first.documents[2].text = edit(first.documents[2].text, (rows) => { rows.splice(0, 1); });
    await expect(parseOpeningSpreadsheets(first.documents, first.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("covers 0 of 1 required lots");

    const second = completedDocuments();
    second.documents[0].text = edit(second.documents[0].text, ([row]) => { row.order_line_id_do_not_edit = "12"; });
    await expect(parseOpeningSpreadsheets(second.documents, second.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("unknown or duplicate order line ID");

    const third = completedDocuments();
    third.documents[2].text = edit(third.documents[2].text, ([row]) => { row.enter_verified_picked = ""; });
    await expect(parseOpeningSpreadsheets(third.documents, third.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("enter_verified_picked must be a non-negative whole number");
  });

  it("rejects an edited recorded cost instead of silently adopting it", async () => {
    const { source, documents } = completedDocuments();
    documents[2].text = edit(documents[2].text, ([row]) => { row.recorded_unit_cost_dollars = "0.001"; });
    await expect(parseOpeningSpreadsheets(documents, source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("changed recorded_unit_cost_dollars");
  });

  it("requires exact source files and selected original cost evidence for picked custody", async () => {
    const wrongSnapshot = completedDocuments();
    wrongSnapshot.documents[1].text = edit(wrongSnapshot.documents[1].text, ([row]) => {
      row.source_snapshot_do_not_edit = "f".repeat(64);
    });
    await expect(parseOpeningSpreadsheets(wrongSnapshot.documents, wrongSnapshot.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("different inventory snapshot");

    const missingCosts = completedDocuments();
    missingCosts.documents[1].text = edit(missingCosts.documents[1].text, ([row]) => {
      row.enter_original_cost_ids_or_all = "";
    });
    await expect(parseOpeningSpreadsheets(missingCosts.documents, missingCosts.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("must identify the original cost rows");
  });

  it("lets an operator use the blank order row for a verified unlisted lot without editing protected IDs", async () => {
    const { source, documents } = completedDocuments();
    documents[1].text = edit(documents[1].text, (rows) => {
      rows[0].enter_verified_reserved = "";
      rows[0].enter_verified_picked = "";
      rows[0].enter_original_cost_ids_or_all = "";
      rows[1].enter_unlisted_lot_id = "4";
      rows[1].enter_verified_reserved = "3";
      rows[1].enter_verified_picked = "2";
      rows[1].enter_original_cost_ids_or_all = "ALL";
    });
    const verification = await parseOpeningSpreadsheets(documents, source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(verification.owners[0].allocations[0]).toMatchObject({ inventoryLevelId: 10,
      lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] });
  });

  it("rejects owner totals and picked cost rows that do not reconcile", async () => {
    const ownerMismatch = completedDocuments();
    ownerMismatch.documents[0].text = edit(ownerMismatch.documents[0].text, ([row]) => {
      row.enter_verified_physical_reserved = "2";
    });
    await expect(parseOpeningSpreadsheets(ownerMismatch.documents, ownerMismatch.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("lot ownership rows assign 3 and 2");

    const costMismatch = completedDocuments();
    costMismatch.documents[1].text = edit(costMismatch.documents[1].text, ([row]) => {
      row.enter_verified_picked = "1";
    });
    await expect(parseOpeningSpreadsheets(costMismatch.documents, costMismatch.source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("cost rows cover 2 picked units, not 1");
  });

  it("requires all three CSVs plus an explicit review reference and completion time", async () => {
    const { source, documents } = completedDocuments();
    await expect(parseOpeningSpreadsheets(documents.slice(0, 2), source, {
      verificationReference: "COUNT-1", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("Select the completed stock, open-order and lot-ownership CSV files together");
    await expect(parseOpeningSpreadsheets(documents, source, {
      verificationReference: " ", verifiedAt: "2026-09-09T12:00:00.000Z",
    })).rejects.toThrow("Enter the count or review reference");
    await expect(parseOpeningSpreadsheets(documents, source, {
      verificationReference: "COUNT-1", verifiedAt: "",
    })).rejects.toThrow("Enter when the physical count");
  });

  it("does not create an owner-by-lot Cartesian product at bulk opening scale", () => {
    const source = openingSource();
    const template = structuredClone(source.evidence);
    source.evidence.orders = Array.from({ length: 9_000 }, (_, index) => ({ ...template.orders[0], id: index + 1,
      externalOrderId: `synthetic-order-${index + 1}`, omsFulfillmentOrderId: `synthetic-fo-${index + 1}` }));
    source.evidence.items = Array.from({ length: 9_000 }, (_, index) => ({ ...template.items[0], id: index + 1,
      orderId: index + 1, sourceItemId: `synthetic-line-${index + 1}`, omsOrderLineId: String(index + 1) }));
    source.evidence.levels = Array.from({ length: 341 }, (_, index) => ({ ...template.levels[0], id: index + 1, warehouseLocationId: index + 1 }));
    source.evidence.lots = Array.from({ length: 2_371 }, (_, index) => ({ ...template.lots[0], id: index + 1, warehouseLocationId: index % 341 + 1 }));
    source.evidence.costs = [];
    const sheets = createOpeningSpreadsheets(source);
    const allocationRows = Papa.parse<Row>(sheets.allocations, { header: true, skipEmptyLines: "greedy",
      transformHeader: (header) => header.replace(/^\uFEFF/, "") }).data;
    expect(allocationRows.length).toBeLessThan(10_000);
    expect(allocationRows).toHaveLength(9_000);
    for (const sheet of Object.values(sheets)) {
      expect(new TextEncoder().encode(sheet).byteLength).toBeLessThan(OPENING_SPREADSHEET_LIMIT_BYTES);
    }
  });
});
