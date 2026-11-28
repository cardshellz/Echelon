import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyInlinePoQuantityChange,
  applyInlinePoUnitPriceChange,
  defaultReceiveConfigurationOption,
  toggleInlinePoPurchaseBasis,
  type ReceiveConfigurationOption,
} from "../../../pages/PurchaseOrderEdit";
import { createEmptyPoLinePricingDraft } from "../PoLinePricingEditor";

const eachOption: ReceiveConfigurationOption = {
  variantId: 101,
  sku: "SLV-EA",
  name: "Each",
  unitsPerVariant: 1,
};

const packOption: ReceiveConfigurationOption = {
  variantId: 102,
  sku: "SLV-P100",
  name: "Pack of 100",
  unitsPerVariant: 100,
};

const caseOption: ReceiveConfigurationOption = {
  variantId: 103,
  sku: "SLV-C1000",
  name: "Case of 1000",
  unitsPerVariant: 1000,
};

describe("UI-1 — Unified Purchasing Navigation & Fast Spreadsheet PO Composer", () => {
  it("consolidates Purchasing, Bills & Payments, Outbound Shipments, and Dropship Partners in AppShell", () => {
    const appShell = readFileSync(
      join(process.cwd(), "client/src/components/layout/AppShell.tsx"),
      "utf8",
    );
    const shipmentsSection = readFileSync(
      join(
        process.cwd(),
        "client/src/pages/purchase-order-detail/PoShipmentsAndReceiptsSection.tsx",
      ),
      "utf8",
    );

    expect(appShell).toContain('label: "Purchasing"');
    expect(appShell).toContain('label: "Bills & Payments", icon: Receipt, href: "/purchasing/bills"');
    expect(appShell).toContain('label: "Inventory Costs", icon: DollarSign, href: "/inventory/costs"');
    expect(appShell).toContain('label: "Outbound Shipments"');
    expect(appShell).toContain('label: "Dropship Partners"');
    expect(appShell).not.toContain('label: "Accounts Payable"');
    expect(appShell).not.toContain('label: "All Vendors"');
    expect(shipmentsSection).not.toContain('href="/vendors"');
    expect(shipmentsSection).toContain('href="/suppliers"');
  });

  it("auto-selects Receive As from lone variant or matching purchase UOM pack size", () => {
    expect(defaultReceiveConfigurationOption([], null)).toBeNull();
    expect(defaultReceiveConfigurationOption([eachOption], null)).toEqual(eachOption);

    const caseQuote = createEmptyPoLinePricingDraft({
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: "3",
      piecesPerUom: "1000",
      pricePerUomDollars: "25.00",
    });
    expect(
      defaultReceiveConfigurationOption([eachOption, packOption, caseOption], caseQuote),
    ).toEqual(caseOption);

    const pieceQuote = createEmptyPoLinePricingDraft({
      basis: "per_piece",
      quantityPieces: "500",
      unitPriceDollars: "0.025",
    });
    expect(
      defaultReceiveConfigurationOption([packOption, caseOption], pieceQuote),
    ).toEqual(packOption);
  });

  it("updates inline PO quantity, unit price, and pack/piece basis while auto-stamping quote date for catalog upserts", () => {
    const fixedNow = new Date("2026-11-27T15:00:00.000Z");
    const baseLine = {
      pricingDraft: createEmptyPoLinePricingDraft({ quantityPieces: "1000" }),
      orderQty: 1000,
      unitCostMills: 0,
      catalogWrite: { mode: "upsert" as const },
      quotedAt: null as string | null,
    };

    const priced = applyInlinePoUnitPriceChange(baseLine, 250, fixedNow);
    expect(priced).toMatchObject({
      hasExplicitPricing: true,
      pricingSource: "manual",
      orderQty: 1000,
      unitCostMills: 250,
      totalProductCostCents: 2500,
      quotedAt: "2026-11-27T00:00:00.000Z",
    });

    const resized = applyInlinePoQuantityChange(
      {
        pricingDraft: priced.pricingDraft!,
        catalogWrite: baseLine.catalogWrite,
        quotedAt: priced.quotedAt ?? null,
      },
      2500,
      fixedNow,
    );
    expect(resized).toMatchObject({
      orderQty: 2500,
      unitCostMills: 250,
      totalProductCostCents: 6250,
    });

    const toggledToCase = toggleInlinePoPurchaseBasis(
      {
        pricingDraft: resized.pricingDraft!,
        orderQty: 2500,
        unitCostMills: 250,
        catalogWrite: baseLine.catalogWrite,
        quotedAt: priced.quotedAt ?? null,
      },
      "per_purchase_uom",
      1000,
      "Case of 1000",
      fixedNow,
    );
    expect(toggledToCase).toMatchObject({
      hasExplicitPricing: true,
      orderQty: 3000, // ceil(2500 / 1000) * 1000 = 3 cases * 1000 pcs
      unitCostMills: 250,
      totalProductCostCents: 7500,
    });
  });

  it("wires 1-click Save & Mark Sent and auto-mark-sent on supplier email", () => {
    const editor = readFileSync(
      join(process.cwd(), "client/src/pages/PurchaseOrderEdit.tsx"),
      "utf8",
    );
    const dialogs = readFileSync(
      join(
        process.cwd(),
        "client/src/pages/purchase-order-detail/PoLifecycleAndDocumentDialogs.tsx",
      ),
      "utf8",
    );

    expect(editor).toContain('data-testid="button-save-and-send"');
    expect(editor).toContain("Save &amp; Mark Sent");
    expect(dialogs).toContain("PO emailed & marked sent");
  });
});
