import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EBAY_POLICY_FIELDS, EMPTY_EBAY_POLICIES, type EbayPolicyValues } from "@shared/ebay-business-policies";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createEbayBusinessPolicyService, type EbayPolicyTarget } from "../../ebay-business-policies.service";
import { PgEbayBusinessPolicyRepository } from "../../infrastructure/ebay-business-policies.repository";
import { EbayBusinessPolicyProvider } from "../../infrastructure/ebay-business-policies.provider";
import { ebayBusinessPolicyFixtureSql, ebayBusinessPolicySeedSql, ebayPolicyScope, ebayPolicyTime,
  EbayPolicyCatalogHttp, policyKinds } from "../fixtures/ebay-business-policies.fixture";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const targets: EbayPolicyTarget[] = [{ kind: "store" }, { kind: "category", productTypeSlug: "packs" },
  { kind: "product", productId: 20 }, { kind: "variant", variantId: 101 }];
const values = (layer: string): EbayPolicyValues => ({ fulfillmentPolicyId: `${layer}-shipping`, returnPolicyId: `${layer}-returns`, paymentPolicyId: `${layer}-payment` });
const actor = "user:policy-reviewer";

(url && disposable ? describe : describe.skip).sequential("canonical eBay policy writer with PostgreSQL and provider catalog HTTP", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ReturnType<typeof createEbayBusinessPolicyService>;
  let http: EbayPolicyCatalogHttp;
  let accountId: string;
  let environment: "production" | "sandbox";
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, ebayBusinessPolicyFixtureSql);
    await database.pool.query(readFileSync(resolve("migrations/900000012000018420001_ebay_category_policy_identity_capacity.sql"), "utf8"));
  }, 60_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE public.audit_events,ebay.ebay_category_mappings,catalog.product_variants,
      catalog.products,ebay.ebay_oauth_tokens,channels.channel_connections,channels.channels RESTART IDENTITY CASCADE;
      ${ebayBusinessPolicySeedSql}`);
    http = new EbayPolicyCatalogHttp(); accountId = "seller-36"; environment = "production";
    const provider = new EbayBusinessPolicyProvider({ getVerifiedProviderAccount: async () => ({ externalAccountId: accountId,
      externalAccountDisplayName: null, externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: ebayPolicyTime }),
      getAccessToken: async () => "synthetic-policy-token", getEnvironment: () => environment }, http.fetch);
    service = createEbayBusinessPolicyService({ repository: new PgEbayBusinessPolicyRepository(database.pool), provider,
      scopeReader: async () => ({ ...ebayPolicyScope }), clock: () => new Date(ebayPolicyTime) });
  });

  const patch = (target: EbayPolicyTarget, changes: Partial<EbayPolicyValues>, expectedPolicies?: EbayPolicyValues) =>
    service.patchPolicies({ target, patch: changes, expectedPolicies, actor });
  async function audit() { return (await database.pool.query("SELECT * FROM public.audit_events ORDER BY id")).rows; }
  async function persisted() {
    const result = await database.pool.query(`SELECT jsonb_build_object(
      'connections',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM channels.channel_connections c),
      'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p),
      'variants',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.product_variants v),
      'categories',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ebay.ebay_category_mappings m),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_events a)) AS value`);
    return result.rows[0].value;
  }

  it.each(targets)("uses the effective $kind shipping policy's package requirements without inferring them from its name", async target => {
    for (const candidate of targets.slice(1)) await patch(candidate, { fulfillmentPolicyId: null });
    const selected = await service.readCatalog();
    http.catalog.set("fulfillment", { fulfillmentPolicies: selected.fulfillmentPolicies.map(policy => ({
      fulfillmentPolicyId: policy.id, name: "Same display name", marketplaceId: "EBAY_US",
      shippingOptions: [{ costType: policy.id === "replacement-shipping" ? "CALCULATED" : "FLAT_RATE", optionType: "DOMESTIC" }],
    })) });
    await patch(target, { fulfillmentPolicyId: "replacement-shipping" });
    const result = await service.resolveProductPolicies({ productId: 20, variantIds: [101, 102] });
    expect(result.packageRequirementsByVariantId.get(101)).toEqual({ weight: true, dimensions: true });
    expect(result.packageRequirementsByVariantId.get(102)).toEqual({ weight: true, dimensions: target.kind !== "variant" });
    expect(result.provenanceByVariantId.get(101)?.fulfillment.source.scope).toBe(target.kind === "category" ? "category" : target.kind);
  });

  it.each(targets)("saves all three validated policies at $kind scope, audits once and preserves unrelated settings", async target => {
    const before = await service.readPolicies(target);
    expect(await patch(target, values("replacement"), before)).toEqual(values("replacement"));
    expect(await service.readPolicies(target)).toEqual(values("replacement"));
    const events = await audit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor, timestamp: ebayPolicyTime,
      changes: { before, after: values("replacement") },
      context: { scope: ebayPolicyScope, policyTarget: target } });
    expect(events[0].action).toBeTruthy(); expect(events[0].target).toBeTruthy();
    expect((await database.pool.query("SELECT metadata FROM channels.channel_connections WHERE id=9")).rows[0].metadata.unrelated)
      .toEqual({ preserve: true });
    const saved = await persisted();
    await patch(target, values("replacement"));
    expect(await persisted()).toEqual(saved);
    expect(new Set(http.requests.map(path => path.split("?")[0])).size).toBe(3);
  });

  it.each(targets)("treats null as inheritance and omitted/undefined fields as preservation at $kind scope", async target => {
    await patch(target, values("replacement"));
    expect(await patch(target, { fulfillmentPolicyId: null, paymentPolicyId: undefined })).toEqual({
      ...values("replacement"), fulfillmentPolicyId: null,
    });
    const saved = await persisted();
    await patch(target, {});
    expect(await persisted()).toEqual(saved);
  });

  it.each(policyKinds)("resolves %s through variant, product, category and store without changing sibling scope", async kind => {
    const key = EBAY_POLICY_FIELDS[kind];
    await patch(targets[1], values("type")); await patch(targets[2], values("product")); await patch(targets[3], values("variant"));
    const resolve = () => service.resolveProductPolicies({ productId: 20, variantIds: [101, 102], expectedScope: ebayPolicyScope });
    let result = await resolve();
    expect(result.byVariantId.get(101)?.[key]).toBe(values("variant")[key]);
    expect(result.byVariantId.get(102)?.[key]).toBe(values("product")[key]);
    await patch(targets[3], { [key]: null });
    expect((await resolve()).byVariantId.get(101)?.[key]).toBe(values("product")[key]);
    await patch(targets[2], { [key]: null });
    expect((await resolve()).byVariantId.get(101)?.[key]).toBe(values("type")[key]);
    await patch(targets[1], { [key]: null });
    result = await resolve();
    expect(result.byVariantId.get(101)?.[key]).toBe(values("store")[key]);
    expect(result.byVariantId.get(102)?.[key]).toBe(values("store")[key]);
  });

  it.each(policyKinds)("rejects an unavailable %s ID without changing any target or audit", async kind => {
    const before = await persisted();
    for (const target of targets) await expect(patch(target, { [EBAY_POLICY_FIELDS[kind]]: "deleted-policy" }))
      .rejects.toMatchObject({ code: "EBAY_POLICY_UNAVAILABLE" });
    expect(await persisted()).toEqual(before);
  });

  it.each(["http", "malformed", "partial", "wrong_marketplace", "empty"] as const)("fails closed for a %s catalog", async fault => {
    const before = await persisted(); http.failure = fault;
    await expect(patch(targets[2], { fulfillmentPolicyId: "product-shipping" })).rejects.toThrow();
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101] })).rejects.toThrow();
    expect(await persisted()).toEqual(before);
  });

  it.each(["account", "environment"] as const)("rejects a different provider %s before saving", async mismatch => {
    const before = await persisted();
    if (mismatch === "account") accountId = "different-seller"; else environment = "sandbox";
    await expect(patch(targets[2], { fulfillmentPolicyId: "product-shipping" })).rejects.toThrow();
    expect(await persisted()).toEqual(before);
  });

  it("rejects a stale account baseline before provider access or writes", async () => {
    const before = await persisted();
    await expect(service.patchPolicies({ target: targets[2], patch: values("product"), actor,
      expectedScope: { ...ebayPolicyScope, accountId: "previous-seller" } })).rejects.toMatchObject({ code: "EBAY_POLICY_SCOPE_CHANGED" });
    expect(http.requests).toEqual([]);
    expect(await persisted()).toEqual(before);
  });

  it.each(["", " ", "product-payment"])("rejects malformed or wrong-kind fulfillment policy %j", async fulfillmentPolicyId => {
    const before = await persisted();
    await expect(patch(targets[2], { fulfillmentPolicyId })).rejects.toThrow();
    expect(await persisted()).toEqual(before);
  });

  it("preserves an invalid historical blank selection until an explicit audited correction", async () => {
    // Corrupt legacy input is a fixture precondition, not a substitute policy writer.
    await database.pool.query("UPDATE catalog.products SET ebay_fulfillment_policy_override=' ' WHERE id=20");
    expect((await service.readPolicies(targets[2])).fulfillmentPolicyId).toBe(" ");
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101] })).rejects.toMatchObject({ code: "EBAY_POLICY_UNAVAILABLE" });
    await patch(targets[2], { fulfillmentPolicyId: null });
    expect((await service.resolveProductPolicies({ productId: 20, variantIds: [101] })).byVariantId.get(101)?.fulfillmentPolicyId).toBe("store-shipping");
    expect(await audit()).toMatchObject([{ changes: { before: { fulfillmentPolicyId: " " }, after: { fulfillmentPolicyId: null } } }]);
  });

  it.each(policyKinds)("reads and explicitly clears an oversized legacy store %s policy without treating it as a valid new selection", async kind => {
    const field = EBAY_POLICY_FIELDS[kind];
    const legacyPolicy = `${kind}-legacy-policy`.padEnd(101, "x");
    // Historical connection JSON has no SQL length constraint. Preserve it for
    // diagnosis and optimistic concurrency; new selections still use the limit.
    await database.pool.query(`UPDATE channels.channel_connections SET metadata=
      jsonb_set(metadata,ARRAY[$1]::text[],to_jsonb($2::text)) WHERE id=9`, [field, legacyPolicy]);
    const expectedPolicies = { ...values("store"), [field]: legacyPolicy };
    expect(await service.readPolicies(targets[0])).toEqual(expectedPolicies);
    const before = await persisted();
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101] })).rejects.toMatchObject({
      code: "EBAY_POLICY_UNAVAILABLE", context: { policyKind: kind, policyId: legacyPolicy, policySource: { scope: "store" } },
    });
    await expect(patch(targets[0], { [field]: legacyPolicy }, expectedPolicies)).rejects.toThrow();
    expect(await persisted()).toEqual(before);
    expect(await patch(targets[0], { [field]: null }, expectedPolicies)).toEqual({ ...values("store"), [field]: null });
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101] })).rejects.toMatchObject({
      code: "EBAY_POLICY_REQUIRED", context: { policyKind: kind, policySource: { scope: "store" } },
    });
    expect(await audit()).toMatchObject([{ changes: { before: { [field]: legacyPolicy }, after: { [field]: null } } }]);
  });

  it("allows explicit inheritance to repair an unavailable override while catalog reads are down", async () => {
    await patch(targets[2], values("product"));
    http.failure = "http"; http.requests.length = 0;
    expect(await patch(targets[2], { fulfillmentPolicyId: null })).toEqual({ ...values("product"), fulfillmentPolicyId: null });
    expect(http.requests).toEqual([]);
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101] })).rejects.toThrow();
  });

  it("rejects publication scope from another product, duplicate members and a changed marketplace", async () => {
    const before = await persisted();
    for (const variantIds of [[103], [101, 101], []])
      await expect(service.resolveProductPolicies({ productId: 20, variantIds })).rejects.toThrow();
    await expect(service.resolveProductPolicies({ productId: 20, variantIds: [101], expectedScope: { ...ebayPolicyScope, marketplaceId: "EBAY_GB" } }))
      .rejects.toMatchObject({ code: "EBAY_POLICY_SCOPE_CHANGED" });
    expect(await persisted()).toEqual(before);
  });

  it("serializes competing reviewed edits and rejects the stale loser without a second audit", async () => {
    const expectedPolicies = await service.readPolicies(targets[2]);
    const results = await Promise.allSettled([patch(targets[2], values("product"), expectedPolicies), patch(targets[2], values("replacement"), expectedPolicies)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "EBAY_POLICY_STALE_EDIT" } });
    expect(await audit()).toHaveLength(1);
  });

  it("preserves disjoint concurrent patches instead of losing an omitted policy", async () => {
    await Promise.all([patch(targets[2], { fulfillmentPolicyId: "product-shipping" }), patch(targets[2], { paymentPolicyId: "product-payment" })]);
    expect(await service.readPolicies(targets[2])).toEqual({ ...EMPTY_EBAY_POLICIES, fulfillmentPolicyId: "product-shipping", paymentPolicyId: "product-payment" });
    expect(await audit()).toHaveLength(2);
  });

  it("rechecks the saved account after an in-flight catalog read and rolls back the policy command", async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    http.hold = { entered, released: new Promise<void>(resolve => { release = resolve; }) };
    const pending = patch(targets[2], values("product"));
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await started;
    await database.pool.query("UPDATE ebay.ebay_oauth_tokens SET external_account_id='reconnected-seller' WHERE channel_id=67");
    release();
    expect(await outcome).toMatchObject({ error: { code: "EBAY_POLICY_SCOPE_CHANGED" } });
    expect((await database.pool.query("SELECT ebay_fulfillment_policy_override FROM catalog.products WHERE id=20")).rows[0].ebay_fulfillment_policy_override).toBeNull();
    expect(await audit()).toEqual([]);
  });

  it("rolls back the policy write when its audit persistence fails", async () => {
    const before = await persisted();
    await database.pool.query(`CREATE FUNCTION public.reject_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Injected policy audit storage failure'; END $$;
      CREATE TRIGGER reject_policy_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_policy_audit()`);
    try { await expect(patch(targets[2], values("product"))).rejects.toThrow("Injected policy audit storage failure"); }
    finally { await database.pool.query("DROP TRIGGER reject_policy_audit ON public.audit_events; DROP FUNCTION public.reject_policy_audit()"); }
    expect(await persisted()).toEqual(before);
  });

  it("preserves omitted category fields and explicitly clears policy overrides in the audited batch owner", async () => {
    await service.saveCategoryMappings({ mappings: [{ productTypeSlug: "packs", fulfillmentPolicyOverride: "type-shipping",
      returnPolicyOverride: "type-returns", paymentPolicyOverride: "type-payment" }], actor });
    await service.saveCategoryMappings({ mappings: [{ productTypeSlug: "packs", fulfillmentPolicyOverride: null }], actor });
    expect(await service.readPolicies(targets[1])).toEqual({ ...values("type"), fulfillmentPolicyId: null });
    expect((await database.pool.query("SELECT * FROM ebay.ebay_category_mappings WHERE product_type_slug='packs'")).rows[0])
      .toMatchObject({ ebay_browse_category_id: "183454", ebay_store_category_name: "Packs", listing_enabled: true });
    const saved = await persisted();
    await service.saveCategoryMappings({ mappings: [{ productTypeSlug: "packs", fulfillmentPolicyOverride: null }], actor });
    expect(await persisted()).toEqual(saved);
  });

  it("rejects an invalid member of a category batch before any save", async () => {
    const before = await persisted();
    await expect(service.saveCategoryMappings({ actor, mappings: [
      { productTypeSlug: "packs", fulfillmentPolicyOverride: "type-shipping" },
      { productTypeSlug: "other", paymentPolicyOverride: "deleted-policy" },
    ] })).rejects.toMatchObject({ code: "EBAY_POLICY_UNAVAILABLE" });
    expect(await persisted()).toEqual(before);
  });

  it("migrates all three legacy category columns and round-trips full-length validated provider identities", async () => {
    const longPolicies: EbayPolicyValues = { fulfillmentPolicyId: "fulfillment".padEnd(100, "1"),
      returnPolicyId: "return".padEnd(100, "2"), paymentPolicyId: "payment".padEnd(100, "3") };
    for (const kind of policyKinds) http.catalog.set(kind, { [`${kind}Policies`]: [{
      [`${kind}PolicyId`]: longPolicies[EBAY_POLICY_FIELDS[kind]], name: `Long ${kind} policy`, marketplaceId: "EBAY_US",
    }] });
    await service.saveCategoryMappings({ actor, mappings: [{ productTypeSlug: "packs",
      fulfillmentPolicyOverride: longPolicies.fulfillmentPolicyId, returnPolicyOverride: longPolicies.returnPolicyId,
      paymentPolicyOverride: longPolicies.paymentPolicyId }] });
    expect(await service.readPolicies(targets[1])).toEqual(longPolicies);
    expect((await service.resolveProductPolicies({ productId: 20, variantIds: [101] })).byVariantId.get(101)).toEqual(longPolicies);
    expect((await database.pool.query(`SELECT character_maximum_length FROM information_schema.columns WHERE table_schema='ebay'
      AND table_name='ebay_category_mappings' AND column_name IN('fulfillment_policy_override','return_policy_override','payment_policy_override')`)).rows)
      .toEqual([{ character_maximum_length: 100 }, { character_maximum_length: 100 }, { character_maximum_length: 100 }]);
    expect(await audit()).toMatchObject([{ changes: { after: { fulfillment_policy_override: longPolicies.fulfillmentPolicyId,
      return_policy_override: longPolicies.returnPolicyId, payment_policy_override: longPolicies.paymentPolicyId } } }]);
    const saved = await persisted();
    await patch(targets[1], longPolicies);
    expect(await persisted()).toEqual(saved);
  });

  it("rolls back earlier category writes and audit rows when a later valid batch member fails in PostgreSQL", async () => {
    const before = await persisted();
    await database.pool.query(`CREATE FUNCTION ebay.reject_second_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.product_type_slug='other' THEN RAISE EXCEPTION 'Injected second mapping failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_mapping BEFORE INSERT OR UPDATE ON ebay.ebay_category_mappings
      FOR EACH ROW EXECUTE FUNCTION ebay.reject_second_mapping()`);
    try { await expect(service.saveCategoryMappings({ actor, mappings: [
      { productTypeSlug: "packs", fulfillmentPolicyOverride: "type-shipping" },
      { productTypeSlug: "other", paymentPolicyOverride: "type-payment" },
    ] })).rejects.toThrow("Injected second mapping failure"); }
    finally { await database.pool.query("DROP TRIGGER reject_second_mapping ON ebay.ebay_category_mappings; DROP FUNCTION ebay.reject_second_mapping()"); }
    expect(await persisted()).toEqual(before);
  });
});
