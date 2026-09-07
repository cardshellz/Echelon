import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

// Exact source qualification prevents tests from hiding schema-name mistakes.
const sourceTables = new Set([
  "dropship.dropship_vendors", "membership.plans", "membership.member_subscriptions",
  "public.app_settings", "channels.channels", "membership.plan_channel_access",
  "catalog.products", "catalog.product_variants", "public.shopify_variants",
  "membership.plan_variant_overrides", "membership.plan_collection_exclusions",
  "membership.product_collections", "membership.plan_benefits",
  "membership.plan_benefit_assignments", "membership.plan_benefit_channel_policies",
]);

describeDatabase.sequential("Shellz Club product cost PostgreSQL source guarantees", () => {
  const schema = `dropship_product_cost_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  function qualify(sql: string): string {
    return sql.replace(/\b(dropship|membership|catalog|channels|public)\.([a-z_]+)/g, (table, _namespace, name) => {
      if (!sourceTables.has(table)) throw new Error(`Unexpected source table: ${table}`);
      return `"${schema}"."${name}"`;
    });
  }
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);
  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Product-cost tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_product_cost_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 3000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    // Minimal read columns from the owning Shellz Club/Echelon schema files.
    // No partner_profiles, wallet, or order-acceptance tables are provided.
    await execute(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id varchar,
        current_plan_id varchar, current_subscription_id varchar, entitlement_status text);
      CREATE TABLE membership.plans (id varchar PRIMARY KEY, is_active boolean, includes_dropship boolean,
        flat_discount_bp integer, flat_discount_percent numeric(5,2));
      CREATE TABLE membership.member_subscriptions (id varchar PRIMARY KEY, member_id varchar, plan_id varchar);
      CREATE TABLE public.app_settings (id varchar PRIMARY KEY, dropship_channel_id integer);
      CREATE TABLE channels.channels (id integer PRIMARY KEY, name text, provider text, status text);
      CREATE TABLE membership.plan_channel_access (plan_id varchar, channel_id integer, enabled boolean,
        UNIQUE(plan_id,channel_id));
      CREATE TABLE catalog.products (id integer PRIMARY KEY, shopify_product_id varchar(100));
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer, shopify_variant_id varchar(100));
      CREATE TABLE public.shopify_variants (id varchar PRIMARY KEY, product_id text, price numeric(10,2));
      CREATE TABLE membership.plan_variant_overrides (id varchar PRIMARY KEY, plan_id varchar,
        variant_id text, product_id text, override_type text, fixed_price numeric(10,2),
        discount_percent numeric(5,2), is_active boolean);
      CREATE TABLE membership.plan_collection_exclusions (id varchar PRIMARY KEY, plan_id varchar, collection_id text);
      CREATE TABLE membership.product_collections (id varchar PRIMARY KEY, product_id text, collection_id text);
      CREATE TABLE membership.plan_benefits (id varchar PRIMARY KEY, kind text);
      CREATE TABLE membership.plan_benefit_assignments (id varchar PRIMARY KEY, plan_id varchar,
        benefit_id varchar, enabled boolean, percentage_bp integer, shipping_group_id integer);
      CREATE TABLE membership.plan_benefit_channel_policies (id varchar PRIMARY KEY,
        plan_benefit_assignment_id varchar, channel_id integer, mode text, enabled boolean,
        percentage_bp_override integer, UNIQUE(plan_benefit_assignment_id,channel_id));
    `);
  });
  beforeEach(async () => {
    await execute(`TRUNCATE ${[...sourceTables].join(", ")};
      INSERT INTO membership.plans VALUES ('ops',true,true,1000,NULL), ('club',true,false,3000,NULL);
      INSERT INTO membership.member_subscriptions VALUES ('sub-ops','member-1','ops'), ('sub-club','member-1','club');
      INSERT INTO dropship.dropship_vendors VALUES (10,'member-1','ops','sub-ops','active');
      INSERT INTO public.app_settings VALUES ('settings',67);
      INSERT INTO channels.channels VALUES (67,'Dropship','dropship','active'), (68,'Storefront','shopify','active');
      INSERT INTO catalog.products VALUES (7,'101');
      INSERT INTO catalog.product_variants VALUES (66,7,'45546128408735');
      INSERT INTO public.shopify_variants VALUES ('45546128408735','101',8.99);
      INSERT INTO membership.plan_variant_overrides VALUES
        ('ops-fixed','ops','45546128408735','101','fixed_price',8.09,NULL,true),
        ('club-fixed','club','45546128408735','101','fixed_price',1.00,NULL,true);
    `);
  });
  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  function instrument(hooks: {
    beforeQuery?: (sql: string, client: PoolClient) => Promise<void>;
    afterQuery?: (sql: string, client: PoolClient) => Promise<void>;
  } = {}) {
    const queries: string[] = [];
    const releases: Array<boolean | Error | undefined> = [];
    const report = vi.fn();
    const adapter = new PgShellzClubProductCostAdapter({ connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          queries.push(sql);
          await hooks.beforeQuery?.(sql, client);
          const result = await client.query(qualify(sql), values);
          await hooks.afterQuery?.(sql, client);
          return result;
        },
        release: (destroy?: boolean | Error) => { releases.push(destroy); client.release(destroy); },
      } as Pick<PoolClient, "query" | "release">;
    } }, report);
    return { adapter, queries, releases, report };
  }
  async function cost(vendorId = 10) {
    return (await instrument().adapter.loadProductCosts({ vendorId, productVariantIds: [66] })).get(66);
  }

  it("reads the exact .ops fixed pack price as 809 cents without partner profiles or writes", async () => {
    const reader = instrument();
    expect((await reader.adapter.loadProductCosts({ vendorId: 10, productVariantIds: [66] })).get(66))
      .toEqual({ status: "available", unitCostCents: 809, planId: "ops",
        source: "variant_fixed_price", overrideId: "ops-fixed", issue: null });
    expect(reader.queries[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(reader.queries.at(-1)).toBe("COMMIT");
    expect(reader.queries.join("\n")).not.toMatch(/partner_profiles|\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(reader.releases).toEqual([false]);
    expect(reader.report).not.toHaveBeenCalled();
  });

  it("never substitutes another vendor or the member's non-dropship subscription", async () => {
    expect(await cost(999)).toMatchObject({ status: "unavailable", issue: "vendor_unavailable" });
    await execute("UPDATE dropship.dropship_vendors SET current_plan_id='club', current_subscription_id='sub-club'");
    expect(await cost()).toMatchObject({ status: "unavailable", issue: "plan_unavailable", planId: "club" });
  });
  it.each([
    ["missing plan", "UPDATE dropship.dropship_vendors SET current_plan_id=NULL"],
    ["inactive plan", "UPDATE membership.plans SET is_active=false WHERE id='ops'"],
    ["wrong subscription member", "UPDATE membership.member_subscriptions SET member_id='member-2' WHERE id='sub-ops'"],
    ["wrong subscription plan", "UPDATE membership.member_subscriptions SET plan_id='club' WHERE id='sub-ops'"],
    ["missing subscription", "UPDATE dropship.dropship_vendors SET current_subscription_id='missing'"],
  ])("rejects an incoherent current plan: %s", async (_label, mutation) => {
    await execute(mutation);
    expect(await cost()).toMatchObject({ status: "unavailable", issue: "plan_unavailable", unitCostCents: null });
  });
  it("requires active vendor entitlement", async () => {
    await execute("UPDATE dropship.dropship_vendors SET entitlement_status='grace'");
    expect(await cost()).toMatchObject({ issue: "entitlement_inactive" });
  });
  it("uses canonical channel eligibility when present instead of the legacy includes flag", async () => {
    await execute("INSERT INTO membership.plan_channel_access VALUES ('ops',68,true)");
    expect(await cost()).toMatchObject({ issue: "plan_unavailable" });
    await execute("INSERT INTO membership.plan_channel_access VALUES ('ops',67,true)");
    expect(await cost()).toMatchObject({ unitCostCents: 809 });
    await execute("UPDATE membership.plan_channel_access SET enabled=false WHERE channel_id=67");
    expect(await cost()).toMatchObject({ issue: "plan_unavailable" });
  });
  it("applies collection exclusions before fixed overrides with normalized Shopify identities", async () => {
    await execute(`INSERT INTO membership.plan_collection_exclusions VALUES ('ex','ops','gid://shopify/Collection/44');
      INSERT INTO membership.product_collections VALUES ('pc','gid://shopify/Product/101','44');`);
    expect(await cost()).toMatchObject({ unitCostCents: 899, source: "retail", overrideId: null });
  });
  it("ignores inactive overrides and falls back to the plan discount", async () => {
    await execute("UPDATE membership.plan_variant_overrides SET is_active=false WHERE id='ops-fixed'");
    expect(await cost()).toMatchObject({ unitCostCents: 809, source: "plan_percent", overrideId: null });
  });
  it("rejects duplicate active overrides with equivalent raw identity strings", async () => {
    await execute(`INSERT INTO membership.plan_variant_overrides VALUES
      ('duplicate','ops','gid://shopify/ProductVariant/45546128408735','101','fixed_price',8.09,NULL,true)`);
    expect(await cost()).toMatchObject({ issue: "override_ambiguous", unitCostCents: null });
  });
  it("preserves a genuine zero price as available", async () => {
    await execute("UPDATE membership.plan_variant_overrides SET fixed_price=0 WHERE id='ops-fixed'");
    expect(await cost()).toMatchObject({ status: "available", unitCostCents: 0, source: "variant_fixed_price" });
  });
  it.each([
    "UPDATE public.shopify_variants SET product_id='102'",
    "UPDATE membership.plan_variant_overrides SET product_id='102' WHERE id='ops-fixed'",
  ])("rejects product identity mismatches: %s", async (mutation) => {
    await execute(mutation);
    expect(await cost()).toMatchObject({ issue: "variant_identity_mismatch" });
  });
  it("normalizes exact Shopify GIDs without guessing a missing variant mapping", async () => {
    await execute(`UPDATE catalog.products SET shopify_product_id='gid://shopify/Product/101';
      UPDATE catalog.product_variants SET shopify_variant_id='gid://shopify/ProductVariant/45546128408735'`);
    expect(await cost()).toMatchObject({ unitCostCents: 809 });
    await execute("UPDATE catalog.product_variants SET shopify_variant_id=NULL");
    expect(await cost()).toMatchObject({ issue: "variant_unmapped" });
  });
  it("rejects duplicate normalized retail-cache identities", async () => {
    await execute("INSERT INTO public.shopify_variants VALUES ('gid://shopify/ProductVariant/45546128408735','101',8.99)");
    expect(await cost()).toMatchObject({ issue: "variant_ambiguous" });
  });
  it("rounds the discount first with exact decimal values", async () => {
    await execute(`UPDATE public.shopify_variants SET price=8.95;
      UPDATE membership.plan_variant_overrides SET override_type='flat_percent', fixed_price=NULL,
        discount_percent=10.00 WHERE id='ops-fixed'`);
    expect(await cost()).toMatchObject({ unitCostCents: 805, source: "variant_percent" });
  });
  it("honors positive channel overrides over disabled base benefits and ignores shipping-group rows", async () => {
    await execute(`DELETE FROM membership.plan_variant_overrides WHERE id='ops-fixed';
      INSERT INTO membership.plan_benefits VALUES ('wholesale','wholesale_percent');
      INSERT INTO membership.plan_benefit_assignments VALUES
        ('base','ops','wholesale',false,1000,NULL), ('group','ops','wholesale',true,9000,5);
      INSERT INTO membership.plan_benefit_channel_policies VALUES ('policy','base',67,'override',true,2000);`);
    expect(await cost()).toMatchObject({ unitCostCents: 719, source: "plan_percent" });
    await execute("UPDATE membership.plan_benefit_channel_policies SET mode='disabled'");
    expect(await cost()).toMatchObject({ unitCostCents: 899, source: "retail" });
  });
  it("does not resurrect legacy discounts when the canonical assignment is disabled", async () => {
    await execute(`DELETE FROM membership.plan_variant_overrides WHERE id='ops-fixed';
      INSERT INTO membership.plan_benefits VALUES ('wholesale','wholesale_percent');
      INSERT INTO membership.plan_benefit_assignments VALUES ('base','ops','wholesale',false,1000,NULL);`);
    expect(await cost()).toMatchObject({ unitCostCents: 899, source: "retail" });
  });
  it("allows fixed prices without guessing an unavailable fallback channel", async () => {
    await execute("DELETE FROM public.app_settings");
    expect(await cost()).toMatchObject({ unitCostCents: 809 });
    await execute("DELETE FROM membership.plan_variant_overrides WHERE id='ops-fixed'");
    expect(await cost()).toMatchObject({ issue: "pricing_configuration_invalid" });
  });
  it("keeps one repeatable source snapshot during a concurrent price edit", async () => {
    let changed = false;
    const reader = instrument({ afterQuery: async (sql) => {
      if (!changed && sql.includes("FROM dropship.dropship_vendors")) {
        changed = true;
        await execute("UPDATE membership.plan_variant_overrides SET fixed_price=9.99 WHERE id='ops-fixed'");
      }
    } });
    expect((await reader.adapter.loadProductCosts({ vendorId: 10, productVariantIds: [66] })).get(66))
      .toMatchObject({ unitCostCents: 809 });
    expect(changed).toBe(true);
    expect(await cost()).toMatchObject({ unitCostCents: 999 });
  });
  it("deduplicates requested IDs and reports missing variants explicitly", async () => {
    const result = await instrument().adapter.loadProductCosts({ vendorId: 10, productVariantIds: [66,66,999] });
    expect(result.size).toBe(2);
    expect(result.get(66)).toMatchObject({ unitCostCents: 809 });
    expect(result.get(999)).toMatchObject({ issue: "variant_unmapped" });
  });
  it.each([false, true])("rolls back SQL failures and safely releases sessions (rollback fails: %s)", async (rollbackFails) => {
    const reader = instrument({ beforeQuery: async (sql, client) => {
      if (sql.includes("FROM public.shopify_variants")) await client.query("SELECT nonexistent_product_cost_column");
      if (rollbackFails && sql === "ROLLBACK") throw new Error("Synthetic rollback failure");
    } });
    expect((await reader.adapter.loadProductCosts({ vendorId: 10, productVariantIds: [66] })).get(66))
      .toMatchObject({ status: "unavailable", unitCostCents: null, issue: "source_read_failed" });
    expect(reader.queries.at(-1)).toBe("ROLLBACK");
    expect(reader.releases).toEqual([rollbackFails]);
    expect(reader.report).toHaveBeenCalledExactlyOnceWith({ vendorId: 10, variantCount: 1,
      code: "source_read_failed", sqlState: "42703", stage: "shopify_variants" });
    expect(JSON.stringify(reader.report.mock.calls)).not.toContain("nonexistent_product_cost_column");
    expect(await cost()).toMatchObject({ unitCostCents: 809 });
  });
});
