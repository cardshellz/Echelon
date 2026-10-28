import { describe, expect, it, vi } from "vitest";
import { shopifyProductConnectionRequestSchema } from "@shared/catalog/shopify-product-connection";
import { buildShopifyProductMappingSummary } from "../../shopify-product-mapping.domain";
import { createShopifyProductConnectionService } from "../../shopify-product-connection.service";
import { ShopifyConnectionProviderError, type ShopifyProductConnectionProvider } from "../../shopify-product-connection.provider";
import { ShopifyProductConnectionError, type ShopifyConnectionRemoteProduct } from "../../shopify-product-connection.domain";
import { type ShopifyProductConnectionRepository, type StoredShopifyConnection } from "../../shopify-product-connection.repository";
import type { ShopifyProductMappingService } from "../../shopify-product-mapping.service";
import { CONNECTION_ACTOR, CONNECTION_COMMAND_KEY, connectionSource, existingConnectionProduct } from "../support/shopify-product-connection.fixture";

function fixture(variantCount = 2) {
  const local = connectionSource(variantCount);
  let command: StoredShopifyConnection | null = null;
  let native: ShopifyConnectionRemoteProduct | null = null;
  let publication = false;
  let lease = 0;
  let nextRemoteVariant = 901;
  const events: string[] = [];
  const repository: ShopifyProductConnectionRepository = {
    configuredChannels: vi.fn(async () => [{ id: 7, name: "Shopify", isDefault: 1 }]),
    credentials: vi.fn(async () => ({ connectionId: 9, shopDomain: local.channel.shopDomain, apiVersion: "2026-01", accessToken: "private-token" })),
    source: vi.fn(async () => structuredClone(local)),
    find: vi.fn(async () => command ? structuredClone(command) : null),
    pending: vi.fn(async () => command && !["complete", "rejected"].includes(command.state) ? structuredClone(command) : null),
    due: vi.fn(async () => command && !command.leaseToken && !["complete", "rejected"].includes(command.state) ? [structuredClone(command)] : []),
    reserve: vi.fn(async input => {
      if (command?.state === "complete" || command?.state === "rejected") return structuredClone(command);
      if (command?.leaseToken) throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_IN_PROGRESS", "Already running", 409, true);
      if (!command) command = { commandKey: input.commandKey, productId: input.productId, channelId: input.request.channelId,
        mode: input.request.mode, state: "pending", remoteProductId: null, request: structuredClone(input.request), previewHash: input.previewHash,
        source: structuredClone(input.source), review: structuredClone(input.review), createSpec: structuredClone(input.createSpec),
        createRequested: false, connectionId: 9, shopDomain: local.channel.shopDomain, leaseToken: null,
        lastErrorCode: null, lastErrorMessage: null, retryable: true, completedAt: null, result: null, resumeAttemptCount: 0 };
      command.leaseToken = `lease-${++lease}`;
      command.resumeAttemptCount += 1;
      return structuredClone(command);
    }),
    step: vi.fn(async (owned, input) => {
      if (!command || command.leaseToken !== owned.leaseToken) throw new Error("stale lease");
      events.push(input.eventType);
      command.state = input.state;
      command.remoteProductId = input.remoteProductId ?? command.remoteProductId;
      command.createRequested ||= input.createRequested === true;
      command.lastErrorCode = input.error?.code ?? null;
      command.lastErrorMessage = input.error?.message ?? null;
      command.retryable = input.error?.retryable ?? true;
      command.result = input.result ?? command.result;
      if (input.release || input.state === "complete" || input.state === "rejected") command.leaseToken = null;
      if (input.state === "complete" || input.state === "rejected") command.completedAt = "2026-10-28T12:00:00.000Z";
      return structuredClone(command);
    }),
  };
  const provider: ShopifyProductConnectionProvider = {
    capabilities: vi.fn(async () => ({ scopes: new Set(["read_products", "write_products", "read_publications", "write_publications"]), currency: "USD" })),
    publications: vi.fn(async () => [{ id: "777", name: "Online Store" }]),
    verifyMedia: vi.fn(async () => undefined),
    matches: vi.fn(async (_credentials, _skus, heartbeat) => { await heartbeat?.(); return []; }),
    owned: vi.fn(async (_credentials, _key, ownership, heartbeat) => { await heartbeat?.(); return native?.ownership === ownership ? structuredClone(native) : null; }),
    product: vi.fn(async (_credentials, _id, heartbeat) => {
      await heartbeat?.();
      if (!native) throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_NOT_FOUND", "Missing product", 404);
      return structuredClone(native);
    }),
    create: vi.fn(async (_credentials, input) => {
      native = { id: "900", title: input.spec.title, handle: input.handle, status: "DRAFT", ownership: input.ownership,
        variants: [{ id: "800", title: input.spec.variants[0].optionValue, sku: null, barcode: null, inventoryItemId: "1800",
          priceCents: 0, optionValue: input.spec.variants[0].optionValue, localVariantId: null, ownership: null,
          requiresShipping: true, trackInventory: false, inventoryQuantity: 0 }] };
      return native.id;
    }),
    createVariants: vi.fn(async (_credentials, input) => {
      if (!native) throw new Error("Product must be created first");
      if (input.removePlaceholder) native.variants = [];
      native.variants.push(...input.variants.map((variant: Parameters<ShopifyProductConnectionProvider["createVariants"]>[1]["variants"][number]) => ({ id: String(nextRemoteVariant++), title: variant.name, sku: variant.sku,
        inventoryItemId: String(10_000 + nextRemoteVariant), barcode: variant.barcode, priceCents: variant.priceCents, compareAtPriceCents: variant.compareAtPriceCents,
        optionValue: variant.optionValue, localVariantId: variant.localVariantId, ownership: input.ownership,
        requiresShipping: variant.requiresShipping, trackInventory: variant.trackInventory, inventoryQuantity: 0 })));
    }),
    published: vi.fn(async () => publication),
    activate: vi.fn(async () => { if (native) native.status = "ACTIVE"; }),
    publish: vi.fn(async () => { publication = true; }),
  };
  const repair = vi.fn<ShopifyProductMappingService["repair"]>(async input => {
    const bindings = input.operatorVariantBindings ?? [];
    const mapping = buildShopifyProductMappingSummary({ productId: local.product.id, productName: local.product.name,
      productSku: local.product.sku, catalogProductId: String(input.targetProductId), channelProductId: String(input.targetProductId),
      channel: { id: 7, name: "Shopify", isPrimary: true }, variants: local.mapping.variants.map(variant => {
        const binding = bindings.find(row => row.variantId === variant.variantId)!;
        return { ...variant, catalogVariantId: String(binding.remoteVariantId), catalogInventoryItemId: `1${binding.remoteVariantId}`,
          feedId: variant.variantId, feedIsActive: true, feedProductId: String(input.targetProductId), feedVariantId: String(binding.remoteVariantId),
          feedInventoryItemId: `1${binding.remoteVariantId}`, listingId: variant.variantId, listingProductId: String(input.targetProductId), listingVariantId: String(binding.remoteVariantId) };
      }) });
    const before = local.mapping; local.mapping = mapping;
    return { before, after: mapping, verifiedShopifyProduct: { id: String(input.targetProductId), title: "Binder" },
      mappedVariantCount: bindings.length, updatedFeedCount: 0, createdFeedCount: bindings.length, updatedListingCount: 0,
      createdListingCount: bindings.length, shippingGroupMetafieldQueued: true, alreadyConsistent: before.status === "consistent" };
  });
  const onConnected = vi.fn(async () => undefined);
  const service = createShopifyProductConnectionService({ repository, provider, mappingOwner: { repair }, onConnected, log: vi.fn() });
  const request = (mode: "create" | "link" = "create") => shopifyProductConnectionRequestSchema.parse({ channelId: 7, currency: "USD", mode,
    ...(mode === "link" ? { targetProductRef: "900" } : {}) });
  const intent = async (input = request()) => ({ request: input, previewHash: (await service.preview(41, input)).previewHash, commandKey: CONNECTION_COMMAND_KEY });
  return { local, repository, provider, repair, onConnected, service, request, intent, events,
    native: () => native, setNative: (value: ShopifyConnectionRemoteProduct | null) => { native = value; },
    saved: () => command, setPublication: (value: boolean) => { publication = value; } };
}

describe("product-scoped Shopify command recovery", () => {
  it("queues the frozen intent without provider writes and finishes through the worker", async () => {
    const f = fixture(); const intent = await f.intent();
    expect((await f.service.submit(41, intent, CONNECTION_ACTOR)).command.state).toBe("pending");
    expect(f.provider.create).not.toHaveBeenCalled(); expect(f.repair).not.toHaveBeenCalled();
    expect(await f.service.processDue()).toEqual({ selected: 1, completed: 1, reviewRequired: 0 });
    expect((await f.service.status(41, intent.commandKey)).state).toBe("complete");
  });
  it("recovers a partial multi-batch variant creation without duplicate package options", async () => {
    const f = fixture(205); const original = vi.mocked(f.provider.createVariants).getMockImplementation()!;
    vi.mocked(f.provider.createVariants).mockImplementationOnce(async (...args) => {
      await original(...args); throw new ShopifyConnectionProviderError("SHOPIFY_REQUEST_UNCERTAIN", "lost first batch", "unknown");
    });
    const intent = await f.intent();
    await expect(f.service.execute(41, intent, CONNECTION_ACTOR)).rejects.toThrow("lost first batch");
    await f.service.execute(41, intent, CONNECTION_ACTOR);
    expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.native()?.variants).toHaveLength(205);
    expect(new Set(f.native()?.variants.map(variant => variant.optionValue)).size).toBe(205);
    expect(f.provider.createVariants).toHaveBeenCalledTimes(3);
  });
  it("reviews without mutating Shopify or creating a command", async () => {
    const f = fixture(); const preview = await f.service.preview(41, f.request());
    expect(preview).toMatchObject({ ready: true, mode: "create", currency: "USD", targetProductId: null });
    expect(preview.variants).toHaveLength(2);
    expect(f.provider.create).not.toHaveBeenCalled(); expect(f.repository.reserve).not.toHaveBeenCalled();
  });
  it("links exact existing variants through the single mapping owner and leaves Shopify unchanged", async () => {
    const f = fixture(); f.setNative(existingConnectionProduct(f.local));
    const native = structuredClone(f.native());
    const request = await f.intent(f.request("link"));
    const result = await f.service.execute(41, request, CONNECTION_ACTOR);
    expect(result.command.state).toBe("complete"); expect(f.repair).toHaveBeenCalledOnce();
    expect(f.repair.mock.calls[0][0].operatorVariantBindings).toEqual([{ variantId: 51, remoteVariantId: "901" }, { variantId: 52, remoteVariantId: "902" }]);
    expect(f.native()).toEqual(native); expect(f.provider.create).not.toHaveBeenCalled(); expect(f.provider.createVariants).not.toHaveBeenCalled(); expect(f.provider.publish).not.toHaveBeenCalled();
  });
  it("replays a completed receipt without querying or projecting an older product again", async () => {
    const f = fixture(); const request = await f.intent(); await f.service.execute(41, request, CONNECTION_ACTOR);
    const reads = vi.mocked(f.provider.product).mock.calls.length;
    const writes = f.repair.mock.calls.length;
    f.local.mapping.catalogProductId = "other-newer-product";
    const replay = await f.service.execute(41, request, CONNECTION_ACTOR);
    expect(replay.replayed).toBe(true); expect(f.provider.product).toHaveBeenCalledTimes(reads); expect(f.repair).toHaveBeenCalledTimes(writes);
  });
  it("creates and configures exactly one draft, preserving tracked and untracked variant policies", async () => {
    const f = fixture(); const result = await f.service.execute(41, await f.intent(), CONNECTION_ACTOR);
    expect(result.command.state).toBe("complete"); expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.native()?.status).toBe("DRAFT"); expect(f.native()?.variants.map(variant => variant.trackInventory)).toEqual([true, false]);
    expect(f.provider.publish).not.toHaveBeenCalled();
    expect(f.events.indexOf("product_create_requested")).toBeLessThan(f.events.indexOf("created_product_recorded"));
    expect(f.events).toContain("mapping_committed");
  });
  it("recovers a lost product-create response from exact ownership, without another create", async () => {
    const f = fixture(); const original = vi.mocked(f.provider.create).getMockImplementation()!;
    vi.mocked(f.provider.create).mockImplementationOnce(async (...args) => { await original(...args); throw new ShopifyConnectionProviderError("SHOPIFY_REQUEST_UNCERTAIN", "lost response", "unknown"); });
    const request = await f.intent();
    await expect(f.service.execute(41, request, CONNECTION_ACTOR)).rejects.toMatchObject({ code: "SHOPIFY_REQUEST_UNCERTAIN" });
    expect(f.saved()?.createRequested).toBe(true); expect(f.saved()?.remoteProductId).toBeNull();
    expect((await f.service.execute(41, request, CONNECTION_ACTOR)).command.state).toBe("complete");
    expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.provider.owned).toHaveBeenCalledOnce();
  });
  it("retains an unknown create outcome and never blindly creates again", async () => {
    const f = fixture(); vi.mocked(f.provider.create).mockRejectedValue(new ShopifyConnectionProviderError("SHOPIFY_REQUEST_UNCERTAIN", "lost response", "unknown"));
    const request = await f.intent();
    await expect(f.service.execute(41, request, CONNECTION_ACTOR)).rejects.toMatchObject({ code: "SHOPIFY_REQUEST_UNCERTAIN" });
    for (let index = 0; index < 2; index += 1) await expect(f.service.execute(41, request, CONNECTION_ACTOR)).rejects.toMatchObject({ code: "SHOPIFY_CREATE_OUTCOME_UNKNOWN" });
    expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.repair).not.toHaveBeenCalled();
  });
  it("recovers created variants after a lost response without creating them again", async () => {
    const f = fixture(); const original = vi.mocked(f.provider.createVariants).getMockImplementation()!;
    vi.mocked(f.provider.createVariants).mockImplementationOnce(async (...args) => { await original(...args); throw new ShopifyConnectionProviderError("SHOPIFY_REQUEST_UNCERTAIN", "lost response", "unknown"); });
    const request = await f.intent(); await expect(f.service.execute(41, request, CONNECTION_ACTOR)).rejects.toThrow("lost response");
    await f.service.execute(41, request, CONNECTION_ACTOR);
    expect(f.provider.createVariants).toHaveBeenCalledOnce(); expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.native()?.variants).toHaveLength(2);
  });
  it("leaves an existing Shopify SKU match for a reviewed link instead of creating a duplicate", async () => {
    const f = fixture(); vi.mocked(f.provider.matches).mockResolvedValue([{ id: "900", title: "Existing", status: "DRAFT" }]);
    const preview = await f.service.preview(41, f.request()); expect(preview.ready).toBe(false);
    await expect(f.service.execute(41, { commandKey: CONNECTION_COMMAND_KEY, previewHash: preview.previewHash, request: f.request() }, CONNECTION_ACTOR)).rejects.toMatchObject({ code: "SHOPIFY_PREVIEW_STALE" });
    expect(f.repository.reserve).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
  });
  it("rejects a stale review and a wrong store currency before reserving or writing", async () => {
    const f = fixture(); const request = await f.intent(); f.local.product.name = "Changed title";
    await expect(f.service.execute(41, request, CONNECTION_ACTOR)).rejects.toMatchObject({ code: "SHOPIFY_PREVIEW_STALE" });
    await expect(f.service.preview(41, { ...f.request(), currency: "CAD" })).rejects.toMatchObject({ code: "SHOPIFY_CURRENCY_CHANGED" });
    expect(f.repository.reserve).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
  });
});
