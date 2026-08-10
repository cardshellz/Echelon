import { describe, expect, it, vi } from "vitest";
import {
  recordShopifyRefundReturnCase,
  type RecordShopifyRefundReturnCaseInput,
} from "../../application/shopify-return-case.service";

const NOW = new Date("2026-08-10T16:00:00.000Z");

function qtext(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function policyRow() {
  return {
    id: 41,
    name: "Shopify retail returns",
    scope_kind: "channel_context",
    scope_key: "context:retail:channel:36",
    business_context: "retail",
    channel_id: 36,
    vendor_id: null,
    store_connection_id: null,
    version: 3,
    status: "active",
    return_window_days: 30,
    return_destination: "card_shellz",
    approval_authority: "card_shellz",
    label_provider: "shipstation",
    return_shipping_payer: "customer",
    inspection_requirement: "required",
    inspection_owner: "card_shellz",
    customer_refund_authority: "card_shellz",
    vendor_settlement_trigger: "none",
    returnless_refund_allowed: false,
    notes: null,
    supersedes_policy_id: null,
    created_by: "admin:test",
    retired_by: null,
    retired_at: null,
    created_at: NOW,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    wms_return_item_id: 801,
    oms_order_line_id: 501,
    wms_order_item_id: 601,
    external_line_item_id: "441680952",
    sku: "SKU-1",
    title: "Test product",
    quantity: 2,
    unit_paid_price_cents: 499,
    source_line_total_cents: 998,
    ...overrides,
  };
}

function input(tx: any, overrides: Partial<RecordShopifyRefundReturnCaseInput> = {}): RecordShopifyRefundReturnCaseInput {
  return {
    tx,
    channelId: 36,
    omsOrderId: 242960,
    wmsOrderId: 204464,
    wmsReturnId: 800,
    refundExternalId: "1036275548319",
    now: NOW,
    ...overrides,
  };
}

function makeTx(handler: (text: string) => { rows: any[] } | Promise<{ rows: any[] }>) {
  const calls: string[] = [];
  const tx = {
    execute: vi.fn(async (query: any) => {
      const text = qtext(query);
      calls.push(text);
      return handler(text);
    }),
  };
  return { tx, calls };
}

describe("recordShopifyRefundReturnCase", () => {
  it("creates one policy-snapshotted case, its items, and an append-only opening event", async () => {
    const mock = makeTx((text) => {
      if (text.includes("FROM returns.return_cases")) return { rows: [] };
      if (text.includes("FROM returns.return_policies")) return { rows: [policyRow()] };
      if (text.includes("FROM wms.return_items ri")) return { rows: [itemRow()] };
      if (text.includes("INSERT INTO returns.return_cases")) return { rows: [{ id: 901, case_number: "RMA-00000901" }] };
      if (text.includes("INSERT INTO returns.return_case_items")) return { rows: [] };
      if (text.includes("INSERT INTO returns.return_case_events")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(recordShopifyRefundReturnCase(input(mock.tx))).resolves.toEqual({
      caseId: 901,
      caseNumber: "RMA-00000901",
      replayed: false,
    });
    const itemSnapshotQuery = mock.calls.find((text) => text.includes("FROM wms.return_items ri"));
+    expect(itemSnapshotQuery).toContain("ri.order_item_id IS NULL OR oi.order_id =");
+    expect(itemSnapshotQuery).toContain("ri.oms_order_line_id IS NULL OR ol.order_id =");
+    expect(mock.calls.filter((text) => text.includes("INSERT INTO returns.return_cases"))).toHaveLength(1);
    expect(mock.calls.filter((text) => text.includes("INSERT INTO returns.return_case_items"))).toHaveLength(1);
    expect(mock.calls.filter((text) => text.includes("INSERT INTO returns.return_case_events"))).toHaveLength(1);
    expect(mock.calls.find((text) => text.includes("INSERT INTO returns.return_cases")))
      .toContain("ON CONFLICT (source_provider, source_event_type, source_event_id) DO NOTHING");
  });

  it("returns the existing source case without resolving policy or writing", async () => {
    const mock = makeTx((text) => {
      if (text.includes("FROM returns.return_cases")) {
        return { rows: [{ id: 901, case_number: "RMA-00000901" }] };
      }
      throw new Error(`Unexpected SQL during replay: ${text}`);
    });

    await expect(recordShopifyRefundReturnCase(input(mock.tx))).resolves.toEqual({
      caseId: 901,
      caseNumber: "RMA-00000901",
      replayed: true,
    });
    expect(mock.calls).toHaveLength(1);
  });

  it("resolves a concurrent source insert as an idempotent replay", async () => {
    let sourceReads = 0;
    const mock = makeTx((text) => {
      if (text.includes("FROM returns.return_cases")) {
        sourceReads += 1;
        return sourceReads === 1
          ? { rows: [] }
          : { rows: [{ id: 902, case_number: "RMA-00000902" }] };
      }
      if (text.includes("FROM returns.return_policies")) return { rows: [policyRow()] };
      if (text.includes("FROM wms.return_items ri")) return { rows: [itemRow()] };
      if (text.includes("INSERT INTO returns.return_cases")) return { rows: [] };
      throw new Error(`Unexpected SQL during concurrent replay: ${text}`);
    });

    await expect(recordShopifyRefundReturnCase(input(mock.tx))).resolves.toEqual({
      caseId: 902,
      caseNumber: "RMA-00000902",
      replayed: true,
    });
    expect(mock.calls.some((text) => text.includes("INSERT INTO returns.return_case_items"))).toBe(false);
    expect(mock.calls.some((text) => text.includes("INSERT INTO returns.return_case_events"))).toBe(false);
  });

  it("fails closed when no active policy applies", async () => {
    const mock = makeTx((text) => {
      if (text.includes("FROM returns.return_cases")) return { rows: [] };
      if (text.includes("FROM returns.return_policies")) return { rows: [] };
      throw new Error(`Unexpected SQL without policy: ${text}`);
    });

    await expect(recordShopifyRefundReturnCase(input(mock.tx))).rejects.toMatchObject({
      code: "RETURN_CASE_POLICY_NOT_CONFIGURED",
    });
    expect(mock.calls.some((text) => text.includes("INSERT INTO returns.return_cases"))).toBe(false);
  });

  it("rejects unsafe money snapshots before writing a case", async () => {
    const mock = makeTx((text) => {
      if (text.includes("FROM returns.return_cases")) return { rows: [] };
      if (text.includes("FROM returns.return_policies")) return { rows: [policyRow()] };
      if (text.includes("FROM wms.return_items ri")) {
        return { rows: [itemRow({ unit_paid_price_cents: Number.MAX_SAFE_INTEGER + 1 })] };
      }
      throw new Error(`Unexpected SQL for invalid money: ${text}`);
    });

    await expect(recordShopifyRefundReturnCase(input(mock.tx))).rejects.toMatchObject({
      code: "RETURN_CASE_ITEM_MONEY_INVALID",
    });
    expect(mock.calls.some((text) => text.includes("INSERT INTO returns.return_cases"))).toBe(false);
  });
});
