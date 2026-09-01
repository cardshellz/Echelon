import { describe, expect, it, vi } from "vitest";

import type {
  HistoricalShipStationContentsCorrectionFacts,
} from "../../historical-shipstation-contents-correction.domain";
import type {
  HistoricalShipStationContentsCorrectionRepository,
} from "../../historical-shipstation-contents-correction.repository";
import {
  HistoricalShipStationContentsCorrectionService,
  HistoricalShipStationContentsCorrectionServiceError,
} from "../../historical-shipstation-contents-correction.service";
import type {
  HistoricalShipStationContentsResolutionPreview,
} from "../../historical-shipstation-contents-review.service";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const review: HistoricalShipStationContentsResolutionPreview = Object.freeze({
  exceptionId: "91",
  shippingProviderLabelId: "51",
  previewEvidenceHash: HASH_C,
  orderNumber: "1001",
  trackingNumber: "1Z-CORRECTION",
  providerRecoveryStatus: "provider_wms_conflict",
  recordedDecision: "provider_confirmed_pending_inventory_correction",
  providerContents: Object.freeze([{ sku: "SKU-A", quantity: 1 }]),
  wmsContents: Object.freeze([{
    wmsShipmentItemId: 701,
    sku: "SKU-A",
    itemName: "Regular A",
    quantity: 2,
  }]),
  allowedDecisions: Object.freeze([
    "wms_confirmed",
    "provider_confirmed_pending_inventory_correction",
    "cannot_prove",
  ]),
});

const facts: HistoricalShipStationContentsCorrectionFacts = Object.freeze({
  exceptionId: "91",
  decisionHash: HASH_A,
  providerEvidenceHash: HASH_B,
  reviewPreviewEvidenceHash: HASH_C,
  orderNumber: "1001",
  trackingNumber: "1Z-CORRECTION",
  providerLines: Object.freeze([{ sku: "SKU-A", quantity: 1 }]),
  wmsLines: Object.freeze([{
    wmsShipmentItemId: 701,
    wmsShipmentId: 801,
    orderItemId: 901,
    productVariantId: 101,
    sku: "SKU-A",
    itemName: "Regular A",
    quantity: 2,
    fromLocationId: 301,
    inventoryShipTransactions: Object.freeze([{
      inventoryTransactionId: 401,
      productVariantId: 101,
      fromLocationId: 301,
      quantity: 2,
      evidenceKind: "exact_shipment_item",
    }]),
  }]),
  catalogVariants: Object.freeze([{
    productVariantId: 101,
    sku: "SKU-A",
    itemName: "Regular A",
    isActive: true,
    requiresShipping: true,
    trackInventory: true,
  }]),
});

describe("HistoricalShipStationContentsCorrectionService", () => {
  it("binds current provider evidence to persisted correction facts", async () => {
    const loadFacts = vi.fn(async () => facts);
    const preview = vi.fn(async () => review);
    const repository: HistoricalShipStationContentsCorrectionRepository = { loadFacts };
    const service = new HistoricalShipStationContentsCorrectionService(
      repository,
      { preview },
    );

    await expect(service.preview("91")).resolves.toMatchObject({
      exceptionId: "91",
      evidenceComplete: true,
      inventoryPostingRequired: true,
    });
    expect(preview).toHaveBeenCalledWith("91");
    expect(loadFacts).toHaveBeenCalledWith({
      exceptionId: "91",
      reviewPreviewEvidenceHash: HASH_C,
      orderNumber: "1001",
      trackingNumber: "1Z-CORRECTION",
      providerLines: [{ sku: "SKU-A", quantity: 1 }],
    });
  });

  it("does not query correction facts before ShipStation is confirmed", async () => {
    const loadFacts = vi.fn(async () => facts);
    const service = new HistoricalShipStationContentsCorrectionService(
      { loadFacts },
      { preview: async () => ({ ...review, recordedDecision: null }) },
    );

    await expect(service.preview("91")).rejects.toMatchObject({
      code: "CORRECTION_NOT_AUTHORIZED",
    });
    expect(loadFacts).not.toHaveBeenCalled();
  });

  it("rejects malformed exception identifiers before external reads", async () => {
    const preview = vi.fn(async () => review);
    const service = new HistoricalShipStationContentsCorrectionService(
      { loadFacts: async () => facts },
      { preview },
    );

    await expect(service.preview("not-an-id"))
      .rejects.toBeInstanceOf(HistoricalShipStationContentsCorrectionServiceError);
    expect(preview).not.toHaveBeenCalled();
  });
});
