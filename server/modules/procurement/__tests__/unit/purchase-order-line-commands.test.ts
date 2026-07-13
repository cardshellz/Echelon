import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { products } from "@shared/schema/catalog.schema";
import {
  purchaseOrderLines,
  purchaseOrders,
  purchasingRecommendationPoHandoffs,
  vendorProducts,
} from "@shared/schema/procurement.schema";

import {
  PurchaseOrderLineCommandError,
  createPurchaseOrderLineCommands,
  vendorCatalogPricingMatches,
  vendorCatalogQuoteUsability,
} from "../../purchase-order-line-commands";

const VERSION = "2026-07-13T12:34:56.789Z";
const PG_INTEGER_MAX = 2_147_483_647;

const addInput = {
  expectedPoUpdatedAt: VERSION,
  productId: 101,
  pricing: {
    basis: "per_piece" as const,
    quantityPieces: 12,
    unitCostMills: 26_321,
  },
};

const updateInput = {
  expectedPoUpdatedAt: VERSION,
  expectedLineUpdatedAt: VERSION,
  notes: "Vendor confirmed the specification",
};

const cancelInput = {
  expectedPoUpdatedAt: VERSION,
  expectedLineUpdatedAt: VERSION,
  reason: "Vendor discontinued the item",
};

function commandBoundary() {
  const db = {
    transaction: vi.fn(() => {
      throw new Error("database transaction must not start");
    }),
    select: vi.fn(() => {
      throw new Error("database read must not start");
    }),
  };
  return {
    db,
    commands: createPurchaseOrderLineCommands(db as any),
  };
}

async function expectInvalidBeforeDb(
  invoke: () => Promise<unknown>,
  db: ReturnType<typeof commandBoundary>["db"],
  expectedPath?: string,
) {
  let thrown: unknown;
  try {
    await invoke();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(PurchaseOrderLineCommandError);
  expect(thrown).toMatchObject({
    statusCode: 400,
    details: { code: "PO_LINE_COMMAND_INVALID" },
  });
  if (expectedPath) {
    expect((thrown as PurchaseOrderLineCommandError).details?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
    );
  }
  expect(db.transaction).not.toHaveBeenCalled();
  expect(db.select).not.toHaveBeenCalled();
}

describe("purchase-order line command validation boundary", () => {
  it.each([
    [
      "add",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) =>
        commands.addLine(44, {
          ...addInput,
          unitCostCents: 263,
          unitCostMills: 26_300,
          totalProductCostCents: 3_156,
          lineTotalCents: 3_156,
          status: "received",
          receivedQty: 12,
          lineNumber: 999,
        }),
    ],
    [
      "bulk add",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) =>
        commands.addBulkLines(44, {
          expectedPoUpdatedAt: VERSION,
          lines: [{
            productId: addInput.productId,
            pricing: addInput.pricing,
            unitCostCents: 263,
            lineTotalCents: 3_156,
            purchaseOrderId: 999,
          }],
        }),
    ],
    [
      "update",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) =>
        commands.updateLine(55, {
          ...updateInput,
          orderQty: 999,
          unitCostCents: 1,
          unitCostMills: 100,
          discountCents: 0,
          taxCents: 0,
          totalProductCostCents: 999,
          lineTotalCents: 999,
          pricingBasis: "per_piece",
          pricingRemainderMills: 0,
          receivedQty: 0,
          cancelledQty: 0,
          status: "open",
          productId: 999,
          purchaseOrderId: 999,
          lineNumber: 999,
        }),
    ],
    [
      "cancel",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) =>
        commands.cancelLine(55, {
          ...cancelInput,
          status: "cancelled",
          cancelledQty: 12,
          lineTotalCents: 0,
        }),
    ],
  ])("strictly rejects protected or legacy fields for %s before DB access", async (_name, invoke) => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(() => invoke(commands), db);
  });

  it("rejects legacy money fields nested inside the pricing command", async () => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(
      () => commands.addLine(44, {
        ...addInput,
        pricing: {
          ...addInput.pricing,
          unitCostCents: 263,
          lineTotalCents: 3_156,
        },
      }),
      db,
    );
  });

  it.each([
    ["productId", { ...addInput, productId: PG_INTEGER_MAX + 1 }, "productId"],
    [
      "piece quantity",
      {
        ...addInput,
        pricing: { ...addInput.pricing, quantityPieces: PG_INTEGER_MAX + 1 },
      },
      "pricing.quantityPieces",
    ],
    [
      "derived purchase-UOM piece quantity",
      {
        ...addInput,
        pricing: {
          basis: "per_purchase_uom",
          purchaseUom: "case",
          uomQuantity: 46_341,
          piecesPerUom: 46_341,
          quotedCostMillsPerUom: 10_000,
        },
      },
      "pricing.uomQuantity",
    ],
    [
      "receive units",
      { ...addInput, expectedReceiveUnitsPerVariant: PG_INTEGER_MAX + 1 },
      "expectedReceiveUnitsPerVariant",
    ],
  ])("rejects PostgreSQL INTEGER overflow for %s before DB access", async (_name, input, path) => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(() => commands.addLine(44, input), db, path);
  });

  it("rejects an impossible quote expiration date before DB access", async () => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(
      () => commands.addLine(44, {
        ...addInput,
        quoteValidUntil: "2026-02-31",
      }),
      db,
      "quoteValidUntil",
    );
  });

  it("rejects a valid-until date before the quote date", async () => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(
      () => commands.addLine(44, {
        ...addInput,
        quotedAt: "2026-07-10T00:00:00.000Z",
        quoteValidUntil: "2026-07-09",
      }),
      db,
      "quoteValidUntil",
    );
  });

  it("rejects a materially future-dated manual quote before DB access", async () => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(
      () => commands.addLine(44, {
        ...addInput,
        quotedAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      }),
      db,
      "quotedAt",
    );
  });

  it.each([
    ["add", (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => commands.addLine(PG_INTEGER_MAX + 1, addInput)],
    ["bulk add", (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => commands.addBulkLines(PG_INTEGER_MAX + 1, {
      expectedPoUpdatedAt: VERSION,
      lines: [{ productId: addInput.productId, pricing: addInput.pricing }],
    })],
    ["update", (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => commands.updateLine(PG_INTEGER_MAX + 1, updateInput)],
    ["cancel", (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => commands.cancelLine(PG_INTEGER_MAX + 1, cancelInput)],
  ])("rejects PostgreSQL INTEGER overflow for the %s command id before DB access", async (_name, invoke) => {
    const { db, commands } = commandBoundary();
    await expect(invoke(commands)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    [
      "add.expectedPoUpdatedAt",
      "expectedPoUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedPoUpdatedAt: _omitted, ...input } = addInput;
        return commands.addLine(44, input);
      },
    ],
    [
      "bulk.expectedPoUpdatedAt",
      "expectedPoUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedPoUpdatedAt: _omitted, ...line } = addInput;
        return commands.addBulkLines(44, { lines: [line] });
      },
    ],
    [
      "update.expectedPoUpdatedAt",
      "expectedPoUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedPoUpdatedAt: _omitted, ...input } = updateInput;
        return commands.updateLine(55, input);
      },
    ],
    [
      "update.expectedLineUpdatedAt",
      "expectedLineUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedLineUpdatedAt: _omitted, ...input } = updateInput;
        return commands.updateLine(55, input);
      },
    ],
    [
      "cancel.expectedPoUpdatedAt",
      "expectedPoUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedPoUpdatedAt: _omitted, ...input } = cancelInput;
        return commands.cancelLine(55, input);
      },
    ],
    [
      "cancel.expectedLineUpdatedAt",
      "expectedLineUpdatedAt",
      (commands: ReturnType<typeof createPurchaseOrderLineCommands>) => {
        const { expectedLineUpdatedAt: _omitted, ...input } = cancelInput;
        return commands.cancelLine(55, input);
      },
    ],
  ])("requires OCC token %s before DB access", async (_name, path, invoke) => {
    const { db, commands } = commandBoundary();
    await expectInvalidBeforeDb(() => invoke(commands), db, path);
  });
});

describe("vendor catalog pricing provenance", () => {
  it("never treats migrated legacy catalog economics as an explicit vendor quote", () => {
    expect(vendorCatalogPricingMatches(
      {
        pricingBasis: "legacy_unknown",
        unitCostMills: 26_320,
        unitCostCents: 263,
      },
      { basis: "per_piece", quantityPieces: 10, unitCostMills: 26_320 },
    )).toBe(false);
  });

  it("requires the exact catalog per-piece rate", () => {
    const catalog = {
      pricingBasis: "per_piece",
      quotedUnitCostMills: 26_321,
      unitCostMills: 26_321,
    };
    expect(vendorCatalogPricingMatches(
      catalog,
      { basis: "per_piece", quantityPieces: 10, unitCostMills: 26_321 },
    )).toBe(true);
    expect(vendorCatalogPricingMatches(
      catalog,
      { basis: "per_piece", quantityPieces: 10, unitCostMills: 26_320 },
    )).toBe(false);
  });

  it("requires the exact purchase UOM, pack size, and UOM rate", () => {
    const catalog = {
      pricingBasis: "per_purchase_uom",
      purchaseUom: "Case",
      piecesPerPurchaseUom: 24,
      quotedUnitCostMills: 631_700,
      unitCostMills: 26_321,
    };
    expect(vendorCatalogPricingMatches(catalog, {
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: 10,
      piecesPerUom: 24,
      quotedCostMillsPerUom: 631_700,
    })).toBe(true);
    expect(vendorCatalogPricingMatches(catalog, {
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: 10,
      piecesPerUom: 12,
      quotedCostMillsPerUom: 631_700,
    })).toBe(false);
  });

  it("requires a verified, current catalog quote and honors explicit expiration", () => {
    const evaluatedAt = new Date("2026-07-13T12:00:00.000Z");
    expect(vendorCatalogQuoteUsability({
      quotedAt: new Date("2026-07-01T00:00:00.000Z"),
      quoteValidUntil: "2026-07-13",
    }, evaluatedAt)).toEqual({ usable: true });
    expect(vendorCatalogQuoteUsability({
      quotedAt: new Date("2026-07-01T00:00:00.000Z"),
      quoteValidUntil: "2026-07-12",
    }, evaluatedAt)).toMatchObject({
      usable: false,
      code: "PO_LINE_VENDOR_CATALOG_QUOTE_EXPIRED",
    });
    expect(vendorCatalogQuoteUsability({
      quotedAt: new Date("2025-07-12T00:00:00.000Z"),
      quoteValidUntil: null,
    }, evaluatedAt)).toMatchObject({
      usable: false,
      code: "PO_LINE_VENDOR_CATALOG_QUOTE_STALE",
    });
    expect(vendorCatalogQuoteUsability({
      quotedAt: new Date("2026-07-13T12:06:00.000Z"),
    }, evaluatedAt)).toMatchObject({
      usable: false,
      code: "PO_LINE_VENDOR_CATALOG_QUOTE_FUTURE",
    });
  });

  it("revalidates stored quote economics when a metadata-only update claims catalog provenance", async () => {
    const existingLine = {
      id: 55,
      purchaseOrderId: 44,
      lineType: "product",
      status: "open",
      productId: 101,
      expectedReceiveVariantId: null,
      expectedReceiveUnitsPerVariant: null,
      vendorProductId: 501,
      orderQty: 10,
      receivedQty: 0,
      damagedQty: 0,
      returnedQty: 0,
      cancelledQty: 0,
      pricingBasis: "per_piece",
      pricingSource: "manual",
      quotedUnitCostMills: 10_000,
      totalProductCostCents: 1_000,
      packagingCostCents: 0,
      discountCents: 0,
      taxCents: 0,
      updatedAt: new Date(VERSION),
    };
    const rowsFor = (table: unknown) => {
      if (table === purchaseOrderLines) return [existingLine];
      if (table === purchaseOrders) {
        return [{
          id: 44,
          vendorId: 7,
          status: "draft",
          physicalStatus: "draft",
          financialStatus: "unbilled",
          invoicedTotalCents: 0,
          paidTotalCents: 0,
          updatedAt: new Date(VERSION),
        }];
      }
      if (table === purchasingRecommendationPoHandoffs) return [];
      if (table === products) return [{ id: 101, name: "Widget", isActive: true }];
      if (table === vendorProducts) {
        return [{
          id: 502,
          vendorId: 7,
          productId: 101,
          productVariantId: null,
          isActive: 1,
          pricingBasis: "per_piece",
          quotedUnitCostMills: 20_000,
          unitCostMills: 20_000,
          unitCostCents: 200,
          quotedAt: new Date("2020-01-01T00:00:00.000Z"),
          quoteValidUntil: "2099-12-31",
        }];
      }
      return [];
    };
    const tx: any = {
      execute: vi.fn().mockResolvedValue({ rows: [{}] }),
      update: vi.fn(),
      select: vi.fn(() => {
        let table: unknown;
        const builder: any = {
          from: vi.fn((nextTable: unknown) => {
            table = nextTable;
            return builder;
          }),
          where: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          for: vi.fn(async () => rowsFor(table)),
          then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsFor(table)),
        };
        return builder;
      }),
    };
    const db = {
      transaction: vi.fn((work: (transaction: any) => Promise<unknown>) => work(tx)),
    };
    const commands = createPurchaseOrderLineCommands(db as any);

    await expect(commands.updateLine(55, {
      ...updateInput,
      vendorProductId: 502,
      pricingSource: "vendor_catalog",
    })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH" },
    });
    expect(tx.update).not.toHaveBeenCalled();
  });
});

const source = readFileSync(
  join(process.cwd(), "server", "modules", "procurement", "purchase-order-line-commands.ts"),
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

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const addLineSource = section("async function addLine(", "async function addBulkLines(");
const addBulkLinesSource = section("async function addBulkLines(", "async function updateLine(");
const updateLineSource = section("async function updateLine(", "async function cancelLine(");
const cancelLineSource = section("async function cancelLine(", "return { addLine, addBulkLines, updateLine, cancelLine }");
const commandSections = [addLineSource, addBulkLinesSource, updateLineSource, cancelLineSource];

describe("purchase-order line command transaction invariants", () => {
  it("enters exactly one transaction before any command DB access", () => {
    for (const commandSource of commandSections) {
      expect(count(commandSource, "db.transaction(")).toBe(1);
      const transactionPosition = commandSource.indexOf("db.transaction(");
      const beforeTransaction = commandSource.slice(0, transactionPosition);
      expect(beforeTransaction).not.toMatch(/\bdb\s*\.\s*(?:select|insert|update|delete|execute)\b/);
      expect(commandSource).not.toMatch(/\bdb\s*\.\s*(?:insert|update|delete|execute)\b/);
    }
  });

  it("locks the header before locking and revalidating an existing line", () => {
    const lockHeaderSource = section("async function lockHeader(", "async function updateHeaderTotals(");
    expect(lockHeaderSource).toContain('.for("update")');

    for (const commandSource of [updateLineSource, cancelLineSource]) {
      const headerLockPosition = commandSource.indexOf("const header = await lockHeader(");
      const lineReadPosition = commandSource.indexOf("const lineRows = await tx");
      const lineLockPosition = commandSource.indexOf('.for("update")', lineReadPosition);
      expect(headerLockPosition).toBeGreaterThanOrEqual(0);
      expect(lineReadPosition).toBeGreaterThan(headerLockPosition);
      expect(lineLockPosition).toBeGreaterThan(lineReadPosition);
      expect(commandSource).toContain("eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)");
    }
  });

  it("soft-cancels lines and never hard-deletes procurement records", () => {
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(cancelLineSource).toContain(".update(purchaseOrderLines)");
    expect(cancelLineSource).toContain('status: "cancelled"');
    expect(cancelLineSource).toContain("cancelledQty: line.orderQty");
    expect(cancelLineSource).toContain('emitEvent(tx, purchaseOrderId, "line_cancelled"');
  });

  it("checks every downstream lineage table before update or cancellation", () => {
    const downstreamGuard = section("async function assertNoDownstreamLinks(", "async function resolveLineContext(");
    for (const table of [
      "procurement.inbound_shipment_lines",
      "procurement.po_receipts",
      "procurement.vendor_invoice_lines",
      "procurement.landed_cost_snapshots",
      "procurement.landed_cost_adjustments",
      "procurement.receiving_lines",
      "inventory.inventory_lots",
      "procurement.purchase_order_lines WHERE parent_line_id",
    ]) {
      expect(downstreamGuard).toContain(table);
    }

    for (const commandSource of [updateLineSource, cancelLineSource]) {
      const guardPosition = commandSource.indexOf("await assertNoDownstreamLinks(");
      const mutationPosition = commandSource.indexOf(".update(purchaseOrderLines)");
      expect(guardPosition).toBeGreaterThanOrEqual(0);
      expect(mutationPosition).toBeGreaterThan(guardPosition);
    }
  });

  it("updates header totals and emits the audit event after each line mutation", () => {
    const totalsSource = section("async function updateHeaderTotals(", "async function emitEvent(");
    const eventSource = section("async function emitEvent(", "export function createPurchaseOrderLineCommands(");
    expect(totalsSource).toContain("SUM(${purchaseOrderLines.lineTotalCents})");
    expect(totalsSource).toContain(".update(purchaseOrders)");
    expect(totalsSource).toContain("subtotalCents:");
    expect(totalsSource).toContain("totalCents:");
    expect(totalsSource).toContain("lineCount:");
    expect(eventSource).toContain("tx.insert(poEvents)");

    for (const commandSource of commandSections) {
      const transactionPosition = commandSource.indexOf("db.transaction(");
      const totalsPosition = commandSource.indexOf("await updateHeaderTotals(");
      const eventPosition = commandSource.indexOf("await emitEvent(");
      expect(totalsPosition).toBeGreaterThan(transactionPosition);
      expect(eventPosition).toBeGreaterThan(totalsPosition);
    }
  });

  it("advances OCC timestamps monotonically at millisecond precision", () => {
    const totalsSource = section("async function updateHeaderTotals(", "async function emitEvent(");
    expect(totalsSource).toContain("GREATEST(");
    expect(totalsSource).toContain("date_trunc('milliseconds', transaction_timestamp())");
    expect(totalsSource).toContain("${header.updatedAt}::timestamp + interval '1 millisecond'");

    for (const commandSource of [updateLineSource, cancelLineSource]) {
      expect(commandSource).toContain("GREATEST(");
      expect(commandSource).toContain("${line.updatedAt}::timestamp + interval '1 millisecond'");
    }
  });

  it("revalidates quote date order after merging a partial metadata update", () => {
    expect(updateLineSource).toContain("quoteDateOnly(quotedAt)");
    expect(updateLineSource).toContain("PO_LINE_QUOTE_DATE_ORDER_INVALID");
    expect(updateLineSource.indexOf("PO_LINE_QUOTE_DATE_ORDER_INVALID")).toBeLessThan(
      updateLineSource.indexOf(".update(purchaseOrderLines)"),
    );
  });

  it("blocks every direct line command when the PO has recommendation ownership", () => {
    const ownershipGuard = section("async function assertNoRecommendationOwnership(", "async function assertNoDownstreamLinks(");
    expect(ownershipGuard).toContain("purchasingRecommendationPoHandoffs.purchaseOrderId");
    expect(ownershipGuard).toContain("RECOMMENDATION_PO_LINE_AMEND_BLOCKED");

    for (const commandSource of commandSections) {
      const guardPosition = commandSource.indexOf("await assertNoRecommendationOwnership(");
      const totalsPosition = commandSource.indexOf("await updateHeaderTotals(");
      expect(guardPosition).toBeGreaterThanOrEqual(0);
      expect(totalsPosition).toBeGreaterThan(guardPosition);
    }
  });

  it("verifies claimed vendor-catalog pricing against the linked catalog row", () => {
    const resolverSource = section("async function resolveLineContext(", "function lineValues(");
    expect(resolverSource).toContain("vendorCatalogPricingMatches(vendorProduct, input.pricing)");
    expect(resolverSource).toContain("PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH");
    expect(resolverSource).toContain("PO_LINE_VENDOR_CATALOG_SOURCE_REQUIRES_LINK");
    const vendorProductRead = resolverSource.indexOf(".from(vendorProducts)");
    const catalogValidation = resolverSource.indexOf(
      "vendorCatalogPricingMatches(vendorProduct, input.pricing)",
    );
    expect(vendorProductRead).toBeGreaterThanOrEqual(0);
    expect(resolverSource.indexOf('.for("share")', vendorProductRead)).toBeGreaterThan(
      vendorProductRead,
    );
    expect(resolverSource.indexOf('.for("share")', vendorProductRead)).toBeLessThan(
      catalogValidation,
    );
    expect(resolverSource).toContain("vendorCatalogQuoteUsability(vendorProduct)");
    expect(source).toContain("catalogQuote?.quoteReference");
    expect(updateLineSource).toContain('resolvedPricingSource === "vendor_catalog"');
    expect(updateLineSource).toContain("catalogQuote.quoteValidUntil");
  });

  it("holds product and receive-variant identity stable through each line write", () => {
    const resolverSource = section("async function resolveLineContext(", "function lineValues(");
    for (const table of [".from(products)", ".from(productVariants)"]) {
      const readPosition = resolverSource.indexOf(table);
      expect(readPosition).toBeGreaterThanOrEqual(0);
      expect(resolverSource.indexOf('.for("share")', readPosition)).toBeGreaterThan(
        readPosition,
      );
    }
  });
});
