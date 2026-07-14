import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "server", "modules", "procurement", "purchasing.service.ts"),
  "utf8",
);

function section(start: string, end: string): string {
  const startPosition = source.indexOf(start);
  const endPosition = source.indexOf(end, startPosition + start.length);
  if (startPosition < 0 || endPosition < 0) {
    throw new Error(`Unable to find source section ${start} -> ${end}`);
  }
  return source.slice(startPosition, endPosition);
}

describe("atomic PO and vendor-catalog persistence", () => {
  it("derives catalog economics from PO lines and never accepts a second price payload", () => {
    const helper = section(
      "async function persistPurchaseOrderCatalogWritesTx(",
      "type ValidatedBulkCatalogEntry",
    );
    expect(helper).toContain("pricing: line.pricing");
    expect(helper).toContain("quotedAt: line.quotedAt");
    expect(helper).toContain("packSize: line.pricing.basis");
    expect(helper).toContain("line.vendorProductId = vendorProductId");
    expect(helper).toContain("bulkUpsertVendorCatalog(vendorId, entries, userId, tx)");
    expect(helper).not.toContain("unitCostMills:");
    expect(helper).not.toContain("unitCostCents:");
  });

  it("runs catalog capture inside both PO create and draft-replacement transactions", () => {
    const createFlow = section(
      "const createAttempt = async (poNumber: string) => db.transaction",
      "let lastConflictingPoNumber",
    );
    const updateFlow = section(
      "async function updateDraftPurchaseOrderWithLines(",
      "// ── NEW SEND FLOW",
    );

    const createCatalogPosition = createFlow.indexOf("await persistPurchaseOrderCatalogWritesTx(");
    const createWritePosition = createFlow.indexOf(".insert(purchaseOrdersTable)");
    expect(createCatalogPosition).toBeGreaterThanOrEqual(0);
    expect(createWritePosition).toBeGreaterThan(createCatalogPosition);

    const updateCatalogPosition = updateFlow.indexOf("await persistPurchaseOrderCatalogWritesTx(");
    const updateWritePosition = updateFlow.indexOf(".update(purchaseOrderLinesTable)");
    expect(updateCatalogPosition).toBeGreaterThanOrEqual(0);
    expect(updateWritePosition).toBeGreaterThan(updateCatalogPosition);
    expect(createFlow).toContain("db.transaction(async (tx: any)");
    expect(updateFlow).toContain("return db.transaction(async (tx: any)");
  });

  it("keeps the PO quote source unchanged when the same manual quote is captured", () => {
    const helper = section(
      "async function persistPurchaseOrderCatalogWritesTx(",
      "type ValidatedBulkCatalogEntry",
    );
    expect(helper).not.toContain("pricingSource");
  });
});
