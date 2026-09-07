import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.hoisted(() => { process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test"; });
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";

function fixture(options: { failAt?: string; rollbackFails?: boolean; count?: number; canonicalAccess?: boolean } = {}) {
  const count = options.count ?? 1;
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (options.failAt && sql.includes(options.failAt)) throw Object.assign(new Error("secret postgres://password@host"), { code: "42P01", detail: "private SQL" });
    if (sql === "ROLLBACK" && options.rollbackFails) throw new Error("connection gone");
    if (sql.includes("FROM dropship.dropship_vendors")) return { rows: [{ plan_id: "ops", entitlement_status: "active",
      plan_is_active: true, includes_dropship: !options.canonicalAccess, subscription_is_coherent: true,
      flat_discount_bp: null, flat_discount_percent: null }] };
    if (sql.includes("FROM public.app_settings")) return { rows: [{ dropship_channel_id: 17 }] };
    if (sql.includes("FROM membership.plan_channel_access")) return { rows: options.canonicalAccess
      ? [{ channel_id: 17, enabled: true, name: "Store access", provider: "manual", status: "active" }] : [] };
    if (sql.includes("FROM catalog.product_variants")) return { rows: ids.map((id) => ({ id, shopify_variant_id: String(id), shopify_product_id: "10" })) };
    if (sql.includes("FROM public.shopify_variants")) return { rows: ids.map((id) => ({ id: String(id), product_id: "10", price: "8.99" })) };
    if (sql.includes("FROM membership.plan_variant_overrides")) return { rows: ids.map((id) => ({ id: `override-${id}`, variant_id: String(id), product_id: "10",
      override_type: "fixed_price", fixed_price: "8.09", discount_percent: null })) };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release } as unknown as Pick<PoolClient, "query" | "release">));
  const report = vi.fn();
  return { adapter: new PgShellzClubProductCostAdapter({ connect }, report), query, connect, report, release, ids };
}

describe("Shellz Club product-cost read boundaries", () => {
  it("uses one consistent read-only snapshot and exact source IDs, without a partner-profile dependency", async () => {
    const test = fixture();
    const costs = await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [1, 1] });
    expect(costs.size).toBe(1);
    expect(costs.get(1)).toMatchObject({ status: "available", unitCostCents: 809, planId: "ops", overrideId: "override-1" });
    expect(test.connect).toHaveBeenCalledTimes(1);
    expect(test.query.mock.calls[0][0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(test.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    const sql = test.query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("current_plan_id");
    expect(sql).toContain("current_subscription_id");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("shipping_group_id IS NULL");
    expect(sql).not.toMatch(/partner_profiles|\bsku\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    expect(test.release).toHaveBeenCalledWith(false);
  });

  it("uses canonical channel eligibility even when the legacy dropship flag is false", async () => {
    const test = fixture({ canonicalAccess: true });
    expect((await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [1] })).get(1)?.unitCostCents).toBe(809);
  });

  it("bounds requests and never acquires a connection for an empty batch", async () => {
    const test = fixture();
    expect((await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [] })).size).toBe(0);
    for (const input of [{ vendorId: 0, productVariantIds: [1] }, { vendorId: 9, productVariantIds: [1.1] },
      { vendorId: 9, productVariantIds: [2_147_483_648] }, { vendorId: 9, productVariantIds: Array(10_001).fill(1) }]) {
      await expect(test.adapter.loadProductCosts(input)).rejects.toMatchObject({ code: "DROPSHIP_PRODUCT_COST_INPUT_INVALID" });
    }
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("batch query count remains constant for thousands of variants", async () => {
    const test = fixture({ count: 5000 });
    const costs = await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: test.ids });
    expect(costs.size).toBe(5000);
    expect(costs.get(5000)?.unitCostCents).toBe(809);
    expect(test.query).toHaveBeenCalledTimes(11);
  });

  it("rolls back a source failure and reports only safe stage/SQLSTATE diagnostics", async () => {
    const test = fixture({ failAt: "FROM membership.plan_variant_overrides" });
    const result = await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [1] });
    expect(result.get(1)).toMatchObject({ status: "unavailable", unitCostCents: null, issue: "source_read_failed" });
    expect(test.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(test.report).toHaveBeenCalledWith({ vendorId: 9, variantCount: 1, code: "source_read_failed", sqlState: "42P01", stage: "variant_overrides" });
    expect(JSON.stringify(test.report.mock.calls)).not.toMatch(/secret|password|private SQL/);
    expect(test.release).toHaveBeenCalledWith(false);
  });

  it("discards unusable clients even if reporting also fails", async () => {
    const test = fixture({ failAt: "FROM public.app_settings", rollbackFails: true });
    test.report.mockImplementation(() => { throw new Error("sink unavailable"); });
    expect((await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [1] })).get(1)?.issue).toBe("source_read_failed");
    expect(test.release).toHaveBeenCalledWith(true);
  });

  it("returns unavailable without leaking a malformed error code when connection acquisition fails", async () => {
    const test = fixture();
    test.connect.mockRejectedValue(Object.assign(new Error("secret"), { code: "password-secret" }));
    expect((await test.adapter.loadProductCosts({ vendorId: 9, productVariantIds: [1] })).get(1)?.issue).toBe("source_read_failed");
    expect(test.report).toHaveBeenCalledWith({ vendorId: 9, variantCount: 1, code: "source_read_failed", sqlState: null, stage: "connect" });
    expect(test.release).not.toHaveBeenCalled();
  });
});
