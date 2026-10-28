import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { shopifyProductConnectionRequestSchema } from "@shared/catalog/shopify-product-connection";
import { createShopifyProductConnectionRepository } from "../../shopify-product-connection.repository";
import { createShopifyProductConnectionProvider } from "../../shopify-product-connection.provider";
import { createShopifyProductConnectionService } from "../../shopify-product-connection.service";
import { createShopifyProductMappingService } from "../../shopify-product-mapping.service";
import { createProductConnectionTestDatabase, installProductConnectionSelectionGate } from "../support/shopify-product-connection.database";
import { createProductConnectionApi } from "../support/shopify-product-connection.api";
import type { InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { filterConnectionOwnedShopifyProducts } from "../../shopify-import-connection-guard";

const enabled = Boolean(process.env.ECHELON_TEST_DATABASE_URL) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const integration = enabled ? describe.sequential : describe.skip;
const NOW = new Date("2026-10-28T12:00:00.000Z");

integration("durable per-product Shopify connections with real mapping and price owners", () => {
  let database: InventoryCutoverTestDatabase;
  let productSequence = 1000;
  let commandSequence = 1;
  let leaseSequence = 1;
  let apiSequence = 0;
  beforeAll(async () => {
    database = await createProductConnectionTestDatabase();
    await database.pool.query(`INSERT INTO warehouse.warehouses(id,code,name) OVERRIDING SYSTEM VALUE VALUES(1,'TEST','Test');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) OVERRIDING SYSTEM VALUE VALUES(1,1,'A-01');`);
    await installProductConnectionSelectionGate(database.pool);
  });
  afterAll(async () => { await database?.close(); });

  function commandKey() { return `00000000-0000-4000-8000-${String(commandSequence++).padStart(12,"0")}`; }
  async function seed(variantCount = 2) {
    const id = ++productSequence;
    const sku = `TEST-BINDER-${id}`;
    await database.pool.query(`INSERT INTO catalog.products(id,sku,name,inventory_tracking_default)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,'Test binder',$3)`, [id, sku, variantCount > 0]);
    const variants: Array<{ id: number; sku: string }> = [];
    for (let index = 0; index < variantCount; index += 1) {
      const variantId = id * 10 + index;
      const variantSku = `${sku}-${index === 0 ? 'P1' : 'C5'}`;
      await database.pool.query(`INSERT INTO catalog.product_variants(id,product_id,sku,name,price_cents,requires_shipping,track_inventory,inventory_tracking_override)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,1999,true,$5,$6)`, [variantId, id, variantSku, `Package ${index + 1}`, index === 0, index === 0 ? null : false]);
      variants.push({ id: variantId, sku: variantSku });
    }
    if (variants.length) await database.pool.query(`INSERT INTO inventory.inventory_levels(warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty)
      VALUES(1,$1,42,2,1)`, [variants[0].id]);
    return { id, sku, variants };
  }
  function fixture(sleep: (milliseconds: number) => Promise<void> = async () => undefined, clock: () => Date = () => NOW) {
    const api = createProductConnectionApi(100_000 * ++apiSequence);
    const db = drizzle(database.pool, { schema });
    const repository = createShopifyProductConnectionRepository({ database: db, now: clock,
      newLeaseToken: () => `10000000-0000-4000-8000-${String(leaseSequence++).padStart(12,"0")}` });
    const mappingOwner = createShopifyProductMappingService({ database: db, now: () => NOW, sleep });
    const provider = createShopifyProductConnectionProvider({ fetchImpl: api.fetchImpl, sleep });
    const onConnected = vi.fn(async () => undefined);
    return { api, repository, mappingOwner, provider, onConnected,
      service: createShopifyProductConnectionService({ repository, mappingOwner, provider, onConnected, log: vi.fn() }) };
  }
  async function inventory() {
    return { levels: (await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows,
      transactions: (await database.pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows };
  }
  async function prepare(f: ReturnType<typeof fixture>, productId: number, input: Record<string, unknown> = {}) {
    const request = shopifyProductConnectionRequestSchema.parse({ channelId: 7, currency: "USD", mode: "create", ...input });
    return { commandKey: commandKey(), request, previewHash: (await f.service.preview(productId, request)).previewHash };
  }

  it("links a fully unmapped product in one mapping transaction and preserves stock and native content", async () => {
    const product = await seed(); const f = fixture();
    const native = f.api.seed({ productId: "999001", variants: product.variants.map(variant => ({ sku: variant.sku })) });
    const originalNative = structuredClone(native); const stock = await inventory();
    const intent = await prepare(f, product.id, { mode: "link", targetProductRef: "999001" });
    expect((await f.service.submit(product.id, intent, "user:operator")).command.state).toBe("pending");
    expect(f.api.operations.some(operation => operation.operation === "EchelonConnectionCreate")).toBe(false);
    expect((await f.service.processDue()).completed).toBe(1);
    expect((await f.mappingOwner.getSummary(product.id, 7)).status).toBe("consistent");
    expect(native).toEqual(originalNative); expect(await inventory()).toEqual(stock);
    const prices = await database.pool.query("SELECT * FROM channels.channel_pricing WHERE product_variant_id=ANY($1::int[])", [product.variants.map(variant => variant.id)]);
    expect(prices.rows).toEqual([]);
    const completed = await f.repository.find(intent.commandKey); expect(completed?.state).toBe("complete");
    const calls = f.api.operations.length;
    expect((await f.service.execute(product.id, intent, "user:operator")).replayed).toBe(true);
    expect(f.api.operations).toHaveLength(calls);
  });

  it("creates one draft, maps all variants and records reviewed channel prices without inventory writes", async () => {
    const product = await seed(); const f = fixture(); const stock = await inventory();
    const intent = await prepare(f, product.id, { prices: product.variants.map((variant, index) => ({ variantId: variant.id, priceCents: index === 0 ? 0 : 2999, compareAtPriceCents: null })) });
    const result = await f.service.execute(product.id, intent, "user:operator");
    expect(result.command.state).toBe("complete"); expect(f.api.products.size).toBe(1);
    const prices = await database.pool.query("SELECT price::text,currency FROM channels.channel_pricing WHERE product_variant_id=ANY($1::int[]) ORDER BY product_variant_id", [product.variants.map(variant => variant.id)]);
    expect(prices.rows).toEqual([{ price: "0", currency: "USD" }, { price: "2999", currency: "USD" }]);
    const native = [...f.api.products.values()][0]; expect(native.status).toBe("DRAFT"); expect(native.published).toEqual([]);
    expect(native.variants.map(variant => variant.inventoryItem.tracked)).toEqual([true,false]);
    expect(await inventory()).toEqual(stock);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM public.audit_events WHERE action='channel_pricing.price_saved' AND target LIKE $1", [`channel:7:%`])).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("recovers a committed native create whose response was lost, without another product", async () => {
    const product = await seed(); const f = fixture(); const stock = await inventory();
    const intent = await prepare(f, product.id); f.api.failAfter.add("EchelonConnectionCreate");
    await expect(f.service.execute(product.id, intent, "user:operator")).rejects.toMatchObject({ code: "SHOPIFY_REQUEST_UNCERTAIN" });
    expect((await f.repository.find(intent.commandKey))?.createRequested).toBe(true);
    expect((await f.service.execute(product.id, intent, "user:operator")).command.state).toBe("complete");
    expect(f.api.operations.filter(operation => operation.operation === "EchelonConnectionCreate")).toHaveLength(1);
    expect(f.api.products.size).toBe(1); expect(await inventory()).toEqual(stock);
  });

  it("keeps a product with no warehouse variants product-only, including digital creation", async () => {
    const product = await seed(0); const f = fixture(); const stock = await inventory();
    const intent = await prepare(f, product.id, { productOnlyRequiresShipping: false, prices: [{ variantId: null, priceCents: 1250 }] });
    await f.service.execute(product.id, intent, "user:operator");
    expect((await database.pool.query("SELECT * FROM catalog.product_variants WHERE product_id=$1", [product.id])).rows).toEqual([]);
    expect((await f.mappingOwner.getSummary(product.id,7)).status).toBe("consistent");
    const variant = [...f.api.products.values()][0].variants[0];
    expect(variant.inventoryItem).toMatchObject({ tracked: false, requiresShipping: false }); expect(variant.price).toBe("12.50");
    expect(await inventory()).toEqual(stock);
    const native = [...f.api.products.values()][0];
    expect(await filterConnectionOwnedShopifyProducts([{ shopifyProductId: Number(native.id.split("/").at(-1)), tags: native.tags }], drizzle(database.pool))).toEqual([]);
  });

  it("keeps primary catalog IDs intact when linking a different Shopify store", async () => {
    const product = await seed(); const f = fixture();
    f.api.seed({ productId: "999002", shopDomain: "second-store.myshopify.com", variants: product.variants.map(variant => ({ sku: variant.sku })) });
    const intent = await prepare(f, product.id, { channelId: 8, currency: "CAD", mode: "link", targetProductRef: "999002" });
    await f.service.execute(product.id, intent, "user:operator");
    expect((await f.mappingOwner.getSummary(product.id,8)).status).toBe("consistent");
    expect((await database.pool.query("SELECT shopify_product_id FROM catalog.products WHERE id=$1", [product.id])).rows[0].shopify_product_id).toBeNull();
    expect((await database.pool.query("SELECT shopify_variant_id FROM catalog.product_variants WHERE product_id=$1", [product.id])).rows.every(variant => variant.shopify_variant_id === null)).toBe(true);
    expect((await database.pool.query("SELECT * FROM membership.shopify_metafield_outbox WHERE target_id='gid://shopify/Product/999002'")).rows).toEqual([]);
  });

  it("serializes concurrent identical commands and refuses a second unfinished intent", async () => {
    const product = await seed(); const f = fixture(); const stock = await inventory();
    const intent = await prepare(f, product.id);
    const results = await Promise.allSettled([
      f.service.execute(product.id, intent, "user:first"), f.service.execute(product.id, intent, "user:second"),
    ]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).toBe("SHOPIFY_COMMAND_IN_PROGRESS");
    expect((await f.repository.find(intent.commandKey))?.state).toBe("complete");
    expect(f.api.operations.filter(operation => operation.operation === "EchelonConnectionCreate")).toHaveLength(1);
    expect(f.api.products.size).toBe(1); expect(await inventory()).toEqual(stock);

    const another = await seed(); const queued = await prepare(f, another.id);
    await f.service.submit(another.id, queued, "user:first");
    await expect(f.service.submit(another.id, { ...queued, commandKey: commandKey() }, "user:second"))
      .rejects.toMatchObject({ code: "SHOPIFY_COMMAND_PENDING" });
    await f.service.execute(another.id, queued, "user:first");
  });

  it("rolls mapping, prices and outbox back under the real selection gate and resumes the saved draft", async () => {
    const product = await seed(); const stock = await inventory();
    for (const variant of product.variants) await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,is_active) VALUES(7,$1,0)`, [variant.id]);
    const f = fixture(); const intent = await prepare(f, product.id);
    const blocker = await database.pool.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(918419,0)");
      await expect(f.service.execute(product.id, intent, "user:operator")).rejects.toMatchObject({ code: "PUBLICATION_SELECTION_BUSY", retryable: true });
      expect((await database.pool.query("SELECT shopify_product_id FROM catalog.products WHERE id=$1", [product.id])).rows[0].shopify_product_id).toBeNull();
      expect((await database.pool.query("SELECT * FROM channels.channel_pricing WHERE product_variant_id=ANY($1::int[])", [product.variants.map(variant => variant.id)])).rows).toEqual([]);
      expect((await database.pool.query("SELECT is_active FROM channels.channel_feeds WHERE product_variant_id=ANY($1::int[])", [product.variants.map(variant => variant.id)])).rows.every(row => row.is_active === 0)).toBe(true);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect((await f.service.execute(product.id, intent, "user:operator")).command.state).toBe("complete");
    expect(f.api.operations.filter(operation => operation.operation === "EchelonConnectionCreate")).toHaveLength(1);
    expect(await inventory()).toEqual(stock);
  });

  it("does not overwrite a price changed after review and rolls back its new mapping", async () => {
    const product = await seed(); const f = fixture(); const intent = await prepare(f, product.id);
    await f.service.submit(product.id, intent, "user:operator");
    await database.pool.query(`INSERT INTO channels.channel_pricing(channel_id,product_variant_id,price,cost,currency) VALUES(7,$1,4567,123,'USD')`, [product.variants[0].id]);
    await expect(f.service.execute(product.id, intent, "user:operator")).rejects.toMatchObject({ code: "CHANNEL_PRICING_CONFLICT" });
    expect((await database.pool.query("SELECT shopify_product_id FROM catalog.products WHERE id=$1", [product.id])).rows[0].shopify_product_id).toBeNull();
    expect((await database.pool.query("SELECT price::text,cost::text FROM channels.channel_pricing WHERE product_variant_id=$1", [product.variants[0].id])).rows).toEqual([{ price: "4567", cost: "123" }]);
    expect((await f.repository.find(intent.commandKey))?.state).toBe("rejected");
    expect([...f.api.products.values()][0].status).toBe("DRAFT");
  });

  it("recovers publication after its response is lost and preserves immutable command history", async () => {
    const product = await seed(); const f = fixture(); const stock = await inventory();
    const intent = await prepare(f, product.id, { publicationId: "777" });
    f.api.failAfter.add("EchelonConnectionPublish");
    await expect(f.service.execute(product.id, intent, "user:operator")).rejects.toMatchObject({ code: "SHOPIFY_REQUEST_UNCERTAIN" });
    await f.service.execute(product.id, intent, "user:operator");
    expect(f.api.operations.filter(operation => operation.operation === "EchelonConnectionPublish")).toHaveLength(1);
    expect([...f.api.products.values()][0]).toMatchObject({ status: "ACTIVE", published: ["gid://shopify/Publication/777"] });
    await expect(database.pool.query("UPDATE catalog.shopify_product_connection_commands SET state='pending' WHERE command_key=$1", [intent.commandKey]))
      .rejects.toMatchObject({ message: "SHOPIFY_CONNECTION_TERMINAL_IMMUTABLE" });
    await expect(database.pool.query("DELETE FROM catalog.shopify_product_connection_events WHERE command_key=$1", [intent.commandKey]))
      .rejects.toMatchObject({ message: "SHOPIFY_CONNECTION_HISTORY_IMMUTABLE" });
    expect(await inventory()).toEqual(stock);
  });

  it("fences an expired worker and preserves pending placeholders from full-store adoption", async () => {
    let at = NOW; const product = await seed(); const f = fixture(async () => undefined, () => at);
    const intent = await prepare(f, product.id); await f.service.submit(product.id, intent, "user:operator");
    const saved = (await f.repository.find(intent.commandKey))!;
    const reservation = { commandKey: saved.commandKey, productId: product.id, request: saved.request, source: saved.source,
      previewHash: saved.previewHash, createSpec: saved.createSpec, review: saved.review, actor: "user:operator" };
    const first = await f.repository.reserve(reservation);
    await expect(f.repository.reserve(reservation)).rejects.toMatchObject({ code: "SHOPIFY_COMMAND_IN_PROGRESS" });
    const placeholder = { shopifyProductId: 987654321, tags: [`echelon-connection-${intent.commandKey}`] };
    const unrelated = { shopifyProductId: 987654322, tags: ["echelon-connection-00000000-0000-4000-8000-000000009999"] };
    expect(await filterConnectionOwnedShopifyProducts([placeholder, unrelated], drizzle(database.pool))).toEqual([unrelated]);
    at = new Date(NOW.getTime() + 120_001); const second = await f.repository.reserve(reservation);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(f.repository.step(first, { state: "creating", actor: "user:stale", eventType: "stale_worker", createRequested: true }))
      .rejects.toMatchObject({ code: "SHOPIFY_COMMAND_STALE_OWNER" });
    await f.repository.step(second, { state: "pending", actor: "user:operator", eventType: "released", release: true });
    await f.service.execute(product.id, intent, "user:operator");
    expect(f.api.products.size).toBe(1);
  });
});
