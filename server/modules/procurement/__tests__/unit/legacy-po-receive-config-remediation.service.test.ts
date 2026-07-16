import { describe, expect, it, vi } from "vitest";

import {
  applyLegacyPoReceiveConfigRemediation,
  previewLegacyPoReceiveConfigRemediation,
} from "../../legacy-po-receive-config-remediation.service";

const activeMappingRow = {
  line_id: 176,
  purchase_order_id: 117,
  po_number: "PO-117",
  po_status: "partially_received",
  line_status: "partially_received",
  vendor_id: 2,
  product_id: 1,
  line_sku: "PRODUCT-1",
  order_qty: 25_000,
  received_qty: 5_000,
  current_vendor_product_id: 27,
  current_mapping_variant_id: 2,
  current_mapping_variant_sku: "PRODUCT-1-C1000",
  current_mapping_variant_name: "Case of 1000",
  current_mapping_variant_product_id: 1,
  current_mapping_active: 1,
  current_mapping_variant_active: true,
  current_mapping_units_per_variant: 1_000,
  receiving_evidence: [{
    receivingLineId: 2650,
    status: "complete",
    productVariantId: 472,
    variantProductId: 1,
    variantActive: true,
    unitsPerVariant: 500,
    expectedVariantQty: 10,
    receivedVariantQty: 10,
    receiptBaseQty: 5_000,
  }],
  replacement_mappings: [],
};

const inactiveMappingRow = {
  line_id: 178,
  purchase_order_id: 118,
  po_number: "PO-118",
  po_status: "received",
  line_status: "received",
  vendor_id: 1,
  product_id: 33,
  line_sku: "PRODUCT-33",
  order_qty: 324_000,
  received_qty: 324_000,
  current_vendor_product_id: 1,
  current_mapping_variant_id: 67,
  current_mapping_variant_sku: "PRODUCT-33-C700",
  current_mapping_variant_name: "Case of 700",
  current_mapping_variant_product_id: 33,
  current_mapping_active: 1,
  current_mapping_variant_active: false,
  current_mapping_units_per_variant: 700,
  receiving_evidence: [{
    receivingLineId: 2666,
    status: "complete",
    productVariantId: 438,
    variantProductId: 33,
    variantActive: true,
    unitsPerVariant: 750,
    expectedVariantQty: 432,
    receivedVariantQty: 432,
    receiptBaseQty: 324_000,
  }],
  replacement_mappings: [{
    vendorProductId: 67,
    productVariantId: 438,
    variantProductId: 33,
    variantActive: true,
    unitsPerVariant: 750,
  }],
};

describe("legacy PO receive configuration remediation", () => {
  it("separates expected supplier configuration from an actual receipt deviation", async () => {
    const queryable = {
      query: vi.fn().mockResolvedValue({
        rows: [activeMappingRow, inactiveMappingRow],
        rowCount: 2,
      }),
    };

    const preview = await previewLegacyPoReceiveConfigRemediation(
      queryable as any,
    );

    expect(preview.summary).toEqual({
      candidateLines: 2,
      safeLines: 2,
      linesToStamp: 1,
      linesToRelink: 1,
      blockedLines: 0,
      linesWithoutReceivingEvidence: 0,
      receiptVariantDeviations: 2,
    });
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.targets[0]).toMatchObject({
      lineId: 176,
      action: "stamp_linked_mapping_configuration",
      targetVendorProductId: 27,
      targetReceiveVariantId: 2,
      targetReceiveUnitsPerVariant: 1_000,
      warnings: ["actual_receipt_variant_differs_from_expected_mapping"],
    });
    expect(preview.targets[1]).toMatchObject({
      lineId: 178,
      action: "relink_to_corroborated_received_configuration",
      targetVendorProductId: 67,
      targetReceiveVariantId: 438,
      targetReceiveUnitsPerVariant: 750,
    });
  });

  it("preserves an archived expected configuration when no receipt supersedes it", async () => {
    const queryable = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          ...inactiveMappingRow,
          order_qty: 7_000,
          received_qty: 0,
          receiving_evidence: [],
          replacement_mappings: [],
        }],
        rowCount: 1,
      }),
    };

    const preview = await previewLegacyPoReceiveConfigRemediation(
      queryable as any,
    );

    expect(preview.summary).toMatchObject({
      candidateLines: 1,
      safeLines: 1,
      linesToStamp: 1,
      blockedLines: 0,
      linesWithoutReceivingEvidence: 1,
    });
    expect(preview.targets[0]).toMatchObject({
      action: "stamp_linked_mapping_configuration",
      targetVendorProductId: 1,
      targetReceiveVariantId: 67,
      warnings: [
        "no_receiving_evidence",
        "expected_mapping_variant_is_archived",
      ],
    });
  });

  it("fails closed when the linked supplier mapping itself is inactive", async () => {
    const preview = await previewLegacyPoReceiveConfigRemediation({
      query: vi.fn().mockResolvedValue({
        rows: [{
          ...activeMappingRow,
          current_mapping_active: 0,
        }],
        rowCount: 1,
      }),
    } as any);

    expect(preview.summary).toMatchObject({
      safeLines: 0,
      blockedLines: 1,
    });
    expect(preview.targets[0]).toMatchObject({
      action: "blocked",
      targetVendorProductId: null,
      blockers: ["linked_supplier_mapping_is_inactive"],
    });
  });

  it("updates and audits every reviewed line in one transaction", async () => {
    const preview = await previewLegacyPoReceiveConfigRemediation({
      query: vi.fn().mockResolvedValue({
        rows: [activeMappingRow, inactiveMappingRow],
        rowCount: 2,
      }),
    } as any);
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("SELECT id FROM public.users")) {
          return { rows: [{ id: "user-1" }], rowCount: 1 };
        }
        if (sql.includes("SELECT to_jsonb(pol)") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              row: {
                id: values?.[0],
                vendor_product_id: values?.[1],
                expected_receive_variant_id: null,
              },
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM procurement.purchase_order_lines pol")) {
          return {
            rows: [activeMappingRow, inactiveMappingRow],
            rowCount: 2,
          };
        }
        if (sql.includes("UPDATE procurement.purchase_order_lines")) {
          return {
            rows: [{
              row: {
                id: values?.[0],
                vendor_product_id: values?.[1],
                expected_receive_variant_id: values?.[2],
                expected_receive_units_per_variant: values?.[3],
              },
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: null };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const result = await applyLegacyPoReceiveConfigRemediation({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
    });

    expect(result).toMatchObject({
      stampedLines: 1,
      relinkedLines: 1,
      auditedLines: 2,
    });
    const updates = calls.filter((call) =>
      call.sql.includes("UPDATE procurement.purchase_order_lines")
    );
    expect(updates[0].values).toEqual([176, 27, 2, 1_000, 27]);
    expect(updates[1].values).toEqual([178, 67, 438, 750, 1]);
    expect(calls.filter((call) =>
      call.sql.includes("INSERT INTO public.audit_events")
    )).toHaveLength(2);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
