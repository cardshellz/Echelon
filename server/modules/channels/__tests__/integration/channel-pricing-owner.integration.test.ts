import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
import { createChannelPricingService, type ChannelPricingService } from "../../channel-pricing.service";
import { ChannelListingCatalogRepository } from "../../channel-listing-catalog.repository";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { createChannelPricingTestDatabase, pricingSnapshot } from "../fixtures/channel-pricing-owner.fixture";
import type { InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const configured = Boolean(process.env.ECHELON_TEST_DATABASE_URL) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-10-20T12:00:00.000Z");
const later = new Date("2026-10-20T12:01:00.000Z");
const actor = "pricing-operator";
const targets = [
  { scope: "channel", scopeId: null, label: null },
  { scope: "category", scopeId: "sleeves", label: "Sleeves" },
  { scope: "product", scopeId: "20", label: "Product A" },
  { scope: "variant", scopeId: "101", label: "A (SKU-A)" },
] as const;

(configured ? describe : describe.skip).sequential("Channel pricing canonical writer PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ChannelPricingService;
  beforeEach(async () => {
    database = await createChannelPricingTestDatabase();
    service = createChannelPricingService(drizzle(database.pool, { schema }));
  });
  afterEach(async () => { await database?.close(); });

  it("installs the real partial indexes and the schema's explicit price uniqueness", async () => {
    const indexes = await database.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='channels' ORDER BY indexname");
    expect(indexes.rows.find(row => row.indexname === "idx_cpr_channel_scope_null")?.indexdef)
      .toMatch(/UNIQUE.*\(channel_id, scope\).*WHERE \(scope_id IS NULL\)/);
    expect(indexes.rows.find(row => row.indexname === "idx_cpr_channel_scope_scopeid")?.indexdef)
      .toMatch(/UNIQUE.*\(channel_id, scope, scope_id\).*WHERE \(scope_id IS NOT NULL\)/);
    const declared = getTableConfig(schema.channelPricing).indexes.find(index => index.config.name === "channel_pricing_channel_pv_idx");
    expect(declared?.config.unique).toBe(true);
    expect(declared?.config.columns.map(column => "name" in column ? column.name : null)).toEqual(["channel_id", "product_variant_id"]);
    expect(indexes.rows.find(row => row.indexname === "channel_pricing_channel_pv_idx")?.indexdef)
      .toContain("UNIQUE INDEX channel_pricing_channel_pv_idx ON channels.channel_pricing USING btree (channel_id, product_variant_id)");
  });

  it.each(targets)("inserts, updates, lists and deletes $scope with exact audit and source facts", async ({ label, ...target }) => {
    const first = await service.saveRule(67, { ...target, ruleType: "percentage", value: 10, expected: null }, actor, now);
    const second = await service.saveRule(67, { ...target, ruleType: "fixed", value: "1.29", expected: { id: first.id, ruleType: first.ruleType, value: first.value } }, actor, later);
    expect(second).toMatchObject({ id: first.id, channelId: 67, ...target, ruleType: "fixed", value: "1.29", createdAt: now, updatedAt: later });
    expect(await service.listRules(67)).toEqual([{ ...second, scopeLabel: label }]);
    expect(await service.deleteRule(67, first.id, actor, later, { id: second.id, ruleType: second.ruleType, value: second.value })).toBe(true);
    const state = await pricingSnapshot(database.pool);
    expect(state.rules).toEqual([]);
    expect(state.facts.map(row => row.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(state.facts.every(row => row.source_relation === "channels.channel_pricing_rules")).toBe(true);
    expect(state.facts[2]).toMatchObject({ before_scope: { channel_id: 67, scope: target.scope, scope_id: target.scopeId }, after_scope: null });
    expect(state.audits.map(row => row.action)).toEqual(["channel_pricing.rule_saved", "channel_pricing.rule_saved", "channel_pricing.rule_deleted"]);
    expect(state.audits[0]).toMatchObject({ actor, timestamp: now, target: `channel:67:rule:${first.id}`, changes: { before: null, after: { value: "10.00" } } });
    expect(state.audits[2].changes).toMatchObject({ before: { id: first.id, value: "1.29" }, after: null });
  });

  it("isolates channels and makes repeated identical insert/update/delete commands inert", async () => {
    const command = { scope: "product", scopeId: "20", ruleType: "fixed", value: "3.20", expected: null };
    const row = await service.saveRule(67, command, actor, now);
    const other = await service.saveRule(68, { ...command, value: "7.10" }, actor, now);
    const before = await pricingSnapshot(database.pool);
    expect(await service.saveRule(67, command, actor, later)).toEqual(row);
    expect(await service.deleteRule(68, row.id, actor, later)).toBe(false);
    expect(await pricingSnapshot(database.pool)).toEqual(before);
    expect(await service.listRules(68)).toEqual([expect.objectContaining({ id: other.id, value: "7.10" })]);
    await service.deleteRule(67, row.id, actor, later);
    const deleted = await pricingSnapshot(database.pool);
    expect(await service.deleteRule(67, row.id, actor, later)).toBe(false);
    expect(await pricingSnapshot(database.pool)).toEqual(deleted);
    expect((await service.listRules(68))[0].id).toBe(other.id);
  });

  it.each(targets)("serializes identical concurrent first $scope inserts without duplicate facts", async ({ label: _label, ...target }) => {
    const command = { ...target, ruleType: "fixed", value: "4.25", expected: null };
    const rows = await Promise.all(Array.from({ length: 4 }, () => service.saveRule(67, command, actor, now)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    const state = await pricingSnapshot(database.pool);
    expect(state.rules).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.facts).toHaveLength(1);
  });

  it("rejects one competing creation and one stale update without losing the winning value", async () => {
    const base = { scope: "channel", scopeId: null, ruleType: "percentage" };
    const created = await Promise.allSettled(["1.00", "2.00"].map(value => service.saveRule(67, { ...base, value, expected: null }, actor, now)));
    expect(created.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(created.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "CHANNEL_PRICING_CONFLICT" }) })]);
    const current = (await service.listRules(67))[0];
    const expected = { id: current.id, ruleType: current.ruleType, value: current.value };
    const updated = await Promise.allSettled(["3.00", "4.00"].map(value => service.saveRule(67, { ...base, value, expected }, actor, later)));
    expect(updated.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(updated.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "CHANNEL_PRICING_CONFLICT" }) })]);
    const winner = updated.find(result => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("Expected exactly one committed update");
    expect((await service.listRules(67))[0].value).toBe(winner.value.value);
    const beforeStaleDelete = await pricingSnapshot(database.pool);
    await expect(service.deleteRule(67, current.id, actor, later, expected)).rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT" });
    expect(await pricingSnapshot(database.pool)).toEqual(beforeStaleDelete);
    expect(beforeStaleDelete.audits).toHaveLength(2);
    expect(beforeStaleDelete.facts).toHaveLength(2);
  });

  it("rejects malformed shapes and out-of-range money before any writes", async () => {
    const valid = { scope: "channel", scopeId: null, ruleType: "fixed", value: "1.00" };
    for (const input of [
      { ...valid, scopeId: "20" }, { ...valid, scope: "product", scopeId: "020" },
      { ...valid, scope: "variant", scopeId: "2147483648" }, { ...valid, channelId: 68 },
      ...["-1", "1.001", "100000000", "1e2", " 1", "NaN", Infinity, NaN].map(value => ({ ...valid, value })),
    ]) await expect(service.saveRule(67, input, actor, now)).rejects.toHaveProperty("name", "ZodError");
    await expect(service.saveRule(67, { ...valid, ruleType: "override", value: "0" }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICING_VALUE_INVALID" });
    for (const input of [{ price: -1 }, { price: 1.5 }, { price: Number.MAX_SAFE_INTEGER + 1 }, { price: "100" }, { price: 100, currency: "usd" }, { price: 100, cost: -1 }]) {
      await expect(service.savePrice(67, 101, input, actor, now)).rejects.toHaveProperty("name", "ZodError");
    }
    expect(await pricingSnapshot(database.pool)).toEqual({ rules: [], prices: [], audits: [], facts: [] });
  });

  it("validates channel and every Catalog scope using the actual repository", async () => {
    const base = { ruleType: "fixed", value: "1.00" };
    await expect(service.saveRule(999, { ...base, scope: "channel", scopeId: null }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICING_CHANNEL_MISSING" });
    for (const target of [{ scope: "category", scopeId: "missing" }, { scope: "product", scopeId: "999" }, { scope: "variant", scopeId: "999" }]) {
      await expect(service.saveRule(67, { ...base, ...target }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICING_TARGET_MISSING" });
    }
    await expect(service.savePrice(67, 999, { price: 1 }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICING_TARGET_MISSING" });
    expect(await pricingSnapshot(database.pool)).toEqual({ rules: [], prices: [], audits: [], facts: [] });
  });

  it("preserves exact numeric and bigint boundaries with explicit zero semantics", async () => {
    const maximum = await service.saveRule(67, { scope: "channel", scopeId: null, ruleType: "fixed", value: "99999999.99" }, actor, now);
    expect(maximum.value).toBe("99999999.99");
    const zero = await service.saveRule(67, { scope: "variant", scopeId: "101", ruleType: "percentage", value: 0 }, actor, now);
    expect(zero.value).toBe("0.00");
    const price = await service.savePrice(67, 101, { price: Number.MAX_SAFE_INTEGER, cost: 0, compareAtPrice: Number.MAX_SAFE_INTEGER }, actor, now);
    expect(price.price).toMatchObject({ price: Number.MAX_SAFE_INTEGER, cost: 0, compareAtPrice: Number.MAX_SAFE_INTEGER });
    const raw = await database.pool.query("SELECT price::text,compare_at_price::text,cost::text FROM channels.channel_pricing");
    expect(raw.rows).toEqual([{ price: "9007199254740991", compare_at_price: "9007199254740991", cost: "0" }]);
  });

  it("preserves omitted explicit fields, clears explicit nulls, isolates channels and deletes with durable before scope", async () => {
    const first = await service.savePrice(67, 101, { price: 1234, cost: 100, compareAtPrice: 2345, currency: "CAD" }, actor, now);
    expect(first.created).toBe(true);
    const other = await service.savePrice(68, 101, { price: 999 }, actor, now);
    const changed = await service.savePrice(67, 101, { price: 1300 }, actor, later);
    expect(changed).toMatchObject({ created: false, price: { id: first.price.id, price: 1300, cost: 100, compareAtPrice: 2345, currency: "CAD" } });
    const beforeReplay = await pricingSnapshot(database.pool);
    expect(await service.savePrice(67, 101, { price: 1300 }, actor, later)).toEqual(changed);
    expect(await pricingSnapshot(database.pool)).toEqual(beforeReplay);
    await service.savePrice(67, 101, { price: 0, cost: null, compareAtPrice: null }, actor, later);
    expect(await service.deletePrice(67, 101, actor, later)).toBe(true);
    const deleted = await pricingSnapshot(database.pool);
    expect(deleted.prices).toEqual([expect.objectContaining({ id: other.price.id, channel_id: 68, price: "999", currency: "USD" })]);
    expect(deleted.facts.at(-1)).toMatchObject({ operation: "DELETE", before_scope: { channel_id: 67, product_variant_id: 101 }, after_scope: null });
    expect(await service.deletePrice(67, 101, actor, later)).toBe(false);
    expect(await pricingSnapshot(database.pool)).toEqual(deleted);
  });

  it("serializes concurrent explicit price creation and preserves independently omitted fields", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.savePrice(67, 101, { price: 1200 }, actor, now)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.price.id)).size).toBe(1);
    await Promise.all([
      service.savePrice(67, 101, { price: 1200, cost: 321 }, actor, later),
      service.savePrice(67, 101, { price: 1200, compareAtPrice: 1500 }, actor, later),
    ]);
    const state = await pricingSnapshot(database.pool);
    expect(state.prices).toEqual([expect.objectContaining({ price: "1200", cost: "321", compare_at_price: "1500" })]);
    expect(state.audits).toHaveLength(3);
    expect(state.facts).toHaveLength(3);
  });

  it("repairs or deletes invalid historical rules through the owner and rejects stale legacy snapshots", async () => {
    // Historical bad data is fixture input, never the implementation under test.
    const seeded = await database.pool.query<{ id: number }>(`INSERT INTO channels.channel_pricing_rules
      (channel_id,scope,scope_id,rule_type,value) VALUES(67,'product','20','unknown',-1),(67,'variant','101','fixed',-2)
      RETURNING id`);
    const legacy = { id: seeded.rows[0].id, ruleType: "unknown", value: "-1.00" };
    const repaired = await service.saveRule(67, { scope: "product", scopeId: "20", ruleType: "fixed", value: "5.25", expected: legacy }, actor, now);
    expect(repaired).toMatchObject({ id: legacy.id, ruleType: "fixed", value: "5.25" });
    const beforeStale = await pricingSnapshot(database.pool);
    await expect(service.saveRule(67, { scope: "product", scopeId: "20", ruleType: "fixed", value: "6.00", expected: legacy }, actor, later))
      .rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT" });
    await expect(service.deleteRule(67, legacy.id, actor, later, legacy)).rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT" });
    expect(await pricingSnapshot(database.pool)).toEqual(beforeStale);
    expect(await service.deleteRule(67, seeded.rows[1].id, actor, later,
      { id: seeded.rows[1].id, ruleType: "fixed", value: "-2.00" })).toBe(true);
    const after = await pricingSnapshot(database.pool);
    expect(after.rules).toEqual([expect.objectContaining({ id: legacy.id, rule_type: "fixed", value: "5.25" })]);
    expect(after.audits).toHaveLength(2);
    expect(after.audits[0].changes).toMatchObject({ before: { ruleType: "unknown", value: "-1.00" }, after: { ruleType: "fixed", value: "5.25" } });
    expect(after.facts.map(row => row.operation)).toEqual(["INSERT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("preserves exact unsafe historical bigint amounts in correction and deletion audits", async () => {
    await database.pool.query(`INSERT INTO channels.channel_pricing(channel_id,product_variant_id,price,compare_at_price,cost)
      VALUES(67,101,9007199254740993,500,100),(67,102,9007199254740995,9007199254740997,9007199254740999)`);
    const changed = await service.savePrice(67, 101, { price: 100 }, actor, now);
    expect(changed.price).toMatchObject({ price: 100, compareAtPrice: 500, cost: 100 });
    expect(await service.deletePrice(67, 102, actor, later)).toBe(true);
    const after = await pricingSnapshot(database.pool);
    expect(after.audits[0].changes.before).toMatchObject({ price: "9007199254740993" });
    expect(after.audits[0].changes.after).toMatchObject({ price: "100", compareAtPrice: "500", cost: "100" });
    expect(after.audits[1].changes.before).toMatchObject({ price: "9007199254740995", compareAtPrice: "9007199254740997", cost: "9007199254740999" });
    expect(after.audits[1].changes.after).toBeNull();
  });

  it("rejects omitted unsafe historical cost without writes and allows an explicit exact correction", async () => {
    await database.pool.query(`INSERT INTO channels.channel_pricing(channel_id,product_variant_id,price,compare_at_price,cost)
      VALUES(67,101,100,9007199254740993,9007199254740995)`);
    const before = await pricingSnapshot(database.pool);
    await expect(service.savePrice(67, 101, { price: 200 }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICE_STORED_VALUE_INVALID" });
    await expect(service.savePrice(67, 101, { price: 200, compareAtPrice: null }, actor, now)).rejects.toMatchObject({ code: "CHANNEL_PRICE_STORED_VALUE_INVALID" });
    expect(await pricingSnapshot(database.pool)).toEqual(before);
    const corrected = await service.savePrice(67, 101, { price: 200, compareAtPrice: null, cost: 50 }, actor, now);
    expect(corrected.price).toMatchObject({ price: 200, compareAtPrice: null, cost: 50 });
    const after = await pricingSnapshot(database.pool);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].changes.before).toMatchObject({ compareAtPrice: "9007199254740993", cost: "9007199254740995" });
    expect(after.facts).toHaveLength(2);
  });

  it("composes the Catalog pricing facade with the real owner transaction and optimistic default-rule snapshots", async () => {
    const facade = new ChannelListingCatalogRepository(database.pool,
      createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" }));
    expect(await facade.pricingRule(67)).toBeNull();
    const created = await facade.savePricingRule(67, { type: "percentage", value: "10", expected: null }, actor, now);
    expect(created).toEqual({ type: "percentage", value: "10.00" });
    expect(await facade.pricingRule(67)).toEqual(created);
    const beforeReplay = await pricingSnapshot(database.pool);
    expect(await facade.savePricingRule(67, { ...created, expected: null }, actor, later)).toEqual(created);
    expect(await pricingSnapshot(database.pool)).toEqual(beforeReplay);

    const updated = await facade.savePricingRule(67, { type: "fixed", value: "3.25", expected: created }, actor, later);
    expect(updated).toEqual({ type: "fixed", value: "3.25" });
    expect(await facade.pricingRule(67)).toEqual(updated);
    const beforeStale = await pricingSnapshot(database.pool);
    await expect(facade.savePricingRule(67, { type: "fixed", value: "4.25", expected: created }, actor, later))
      .rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT", status: 409 });
    await expect(facade.savePricingRule(67, { type: "fixed", value: "4.25", expected: null }, actor, later))
      .rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT", status: 409 });
    expect(await pricingSnapshot(database.pool)).toEqual(beforeStale);

    // Older callers omit the snapshot. The facade must preserve that contract,
    // while still using the same locked writer, audit and propagation transaction.
    expect(await facade.savePricingRule(67, { type: "override", value: "42.5" }, actor, later))
      .toEqual({ type: "override", value: "42.50" });
    expect(await facade.pricingRule(67)).toEqual({ type: "override", value: "42.50" });
    expect(await facade.pricingRule(68)).toBeNull();
    const after = await pricingSnapshot(database.pool);
    expect(after.rules).toEqual([expect.objectContaining({ channel_id: 67, scope: "channel", scope_id: null, rule_type: "override", value: "42.50" })]);
    expect(after.audits.map(row => row.action)).toEqual(Array(3).fill("channel_pricing.rule_saved"));
    expect(after.audits.every(row => row.actor === actor)).toBe(true);
    expect(after.facts.map(row => row.operation)).toEqual(["INSERT", "UPDATE", "UPDATE"]);
    expect(after.facts.every(row => row.source_relation === "channels.channel_pricing_rules"
      && row.after_scope.channel_id === 67 && row.after_scope.scope === "channel" && row.after_scope.scope_id === null)).toBe(true);
  });

  it("rolls back both pricing rows and real propagation facts when audit persistence fails", async () => {
    const rule = await service.saveRule(67, { scope: "channel", scopeId: null, ruleType: "fixed", value: "1.00" }, actor, now);
    await service.savePrice(67, 101, { price: 100 }, actor, now);
    await database.pool.query("ALTER TABLE public.audit_events ADD CONSTRAINT reject_test_actor CHECK(actor <> 'fail-audit')");
    const before = await pricingSnapshot(database.pool);
    const failures = [
      () => service.saveRule(67, { scope: "category", scopeId: "sleeves", ruleType: "fixed", value: "1.00" }, "fail-audit", later),
      () => service.saveRule(67, { scope: "channel", scopeId: null, ruleType: "fixed", value: "2.00" }, "fail-audit", later),
      () => service.deleteRule(67, rule.id, "fail-audit", later),
      () => service.savePrice(67, 102, { price: 200 }, "fail-audit", later),
      () => service.savePrice(67, 101, { price: 200 }, "fail-audit", later),
      () => service.deletePrice(67, 101, "fail-audit", later),
    ];
    for (const command of failures) {
      await expect(command()).rejects.toThrow();
      expect(await pricingSnapshot(database.pool)).toEqual(before);
    }
  });
});
