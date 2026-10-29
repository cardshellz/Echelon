import { vi } from "vitest";
import { formatShopifyConnectionMoney } from "@shared/catalog/shopify-product-connection";

interface Field { value: string }
interface NativeVariant {
  id: string; title: string; sku: string | null; barcode: string | null; price: string; compareAtPrice: string | null;
  inventoryQuantity: number; inventoryItem: { id: string; tracked: boolean; requiresShipping: boolean };
  selectedOptions: Array<{ name: string; value: string }>;
  ownership: Field | null; localVariant: Field | null;
}
interface NativeProduct {
  id: string; title: string; handle: string; status: string; ownership: Field | null;
  tags: string[]; variants: NativeVariant[]; published: string[]; descriptionHtml?: string;
  media: Array<{ id: string; mediaContentType: string; status: string; mediaErrors: Array<{ code: string }> }>;
}
interface VariantInput {
  price: string; compareAtPrice: string | null; barcode: string | null;
  inventoryItem: { sku: string; tracked: boolean; requiresShipping: boolean };
  optionValues: Array<{ optionName: string; name: string }>;
  metafields: Array<{ namespace: string; key: string; value: string }>;
}

/** A stateful native API fake: every follow-up GET reads the actual prior write,
 * including writes whose response is deliberately lost. No production calls. */
export function createProductConnectionApi(firstProductId = 900) {
  const products = new Map<string, NativeProduct>();
  let nextProduct = firstProductId;
  let nextVariant = firstProductId + 1000;
  const failAfter = new Set<string>();
  const operations: Array<{ operation: string; shopDomain: string; variables: Record<string, unknown> }> = [];
  const key = (shop: string, id: string) => `${shop}:${id}`;
  const reply = (data: Record<string, unknown>) => new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  const field = (fields: VariantInput["metafields"], name: string) => fields.find(entry => entry.key === name)?.value ?? null;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const shopDomain = new URL(url).hostname;
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    if (!operation) throw new Error("Unknown fake GraphQL operation");
    operations.push({ operation, shopDomain, variables: structuredClone(variables) });
    let data: Record<string, unknown>;
    if (operation === "EchelonConnectionScopes") {
      data = { shop: { myshopifyDomain: shopDomain, currencyCode: shopDomain === "second-store.myshopify.com" ? "CAD" : "USD" },
        currentAppInstallation: { accessScopes: ["read_products", "write_products", "read_publications", "write_publications"].map(handle => ({ handle })) } };
    } else if (operation === "EchelonConnectionPublications") {
      data = { publications: { nodes: [{ id: "gid://shopify/Publication/777", name: "Online Store" }], pageInfo: { hasNextPage: false } } };
    } else if (operation === "EchelonConnectionSearch") {
      const text = String(variables.query);
      const terms = [...text.matchAll(/(?:sku|tag):("(?:\\.|[^"\\])*")/g)].map(match => JSON.parse(match[1]) as string);
      const found = [...products.entries()].filter(([id, product]) => id.startsWith(`${shopDomain}:`) &&
        (text.startsWith("tag:") ? product.tags.some(tag => terms.includes(tag))
          : product.variants.some(variant => variant.sku && terms.some(term => term.toUpperCase() === variant.sku!.toUpperCase()))));
      data = { products: { nodes: found.map(([, product]) => ({ id: product.id, title: product.title, status: product.status })), pageInfo: { hasNextPage: false } } };
    } else if (operation === "EchelonConnectionProduct") {
      const product = products.get(key(shopDomain, String(variables.id)));
      const offset = variables.after === null ? 0 : Number(variables.after);
      data = { product: product ? { ...structuredClone(product), variants: {
        nodes: structuredClone(product.variants.slice(offset, offset + 100)),
        pageInfo: { hasNextPage: offset + 100 < product.variants.length, endCursor: String(offset + 100) },
      } } : null };
    } else if (operation === "EchelonConnectionCreate") {
      const input = variables.product as { title: string; handle: string; status: string; tags: string[]; metafields: VariantInput["metafields"]; descriptionHtml?: string;
        productOptions: Array<{ name: string; values: Array<{ name: string }> }> };
      const id = `gid://shopify/Product/${nextProduct++}`;
      const ownership = field(input.metafields, "connection_command");
      const product: NativeProduct = { id, title: input.title, handle: input.handle, status: input.status,
        ownership: ownership === null ? null : { value: ownership }, tags: input.tags, descriptionHtml: input.descriptionHtml,
        published: [], media: ((variables.media ?? []) as unknown[]).map((_, index) => ({ id: `gid://shopify/MediaImage/${nextProduct * 1000 + index}`, mediaContentType: "IMAGE", status: "READY", mediaErrors: [] })),
        variants: [{ id: `gid://shopify/ProductVariant/${nextVariant++}`, title: input.productOptions[0].values[0].name,
          sku: null, barcode: null, price: "0.00", compareAtPrice: null, inventoryQuantity: 0,
          inventoryItem: { id: `gid://shopify/InventoryItem/${nextVariant + 1000}`, tracked: false, requiresShipping: true },
          selectedOptions: [{ name: input.productOptions[0].name, value: input.productOptions[0].values[0].name }], ownership: null, localVariant: null }] };
      products.set(key(shopDomain, id), product);
      data = { productCreate: { product: { id }, userErrors: [] } };
    } else if (operation === "EchelonConnectionMedia") {
      const product = products.get(key(shopDomain, String(variables.id))); const offset = variables.after === null ? 0 : Number(variables.after);
      data = { product: product ? { media: { nodes: product.media.slice(offset, offset + 100),
        pageInfo: { hasNextPage: offset + 100 < product.media.length, endCursor: String(offset + 100) } } } : null };
    } else if (operation === "EchelonConnectionVariants") {
      const product = products.get(key(shopDomain, String(variables.id)));
      if (!product) throw new Error("Missing native product");
      const input = variables.variants as VariantInput[];
      if (variables.strategy === "REMOVE_STANDALONE_VARIANT") product.variants = [];
      const created: Array<{ id: string }> = [];
      for (const variant of input) {
        const value = variant.optionValues[0].name;
        if (product.variants.some(existing => existing.selectedOptions[0].value === value)) {
          return reply({ productVariantsBulkCreate: { productVariants: created, userErrors: [{ message: "Variant option already exists" }] } });
        }
        const id = `gid://shopify/ProductVariant/${nextVariant++}`;
        product.variants.push({ id, title: value, sku: variant.inventoryItem.sku, barcode: variant.barcode,
          price: variant.price, compareAtPrice: variant.compareAtPrice, inventoryQuantity: 0, inventoryItem: { id: `gid://shopify/InventoryItem/${nextVariant + 1000}`,
            tracked: variant.inventoryItem.tracked, requiresShipping: variant.inventoryItem.requiresShipping },
          selectedOptions: [{ name: "Package", value }], ownership: { value: field(variant.metafields, "connection_command")! },
          localVariant: { value: field(variant.metafields, "catalog_variant_id")! } });
        created.push({ id });
      }
      data = { productVariantsBulkCreate: { productVariants: created, userErrors: [] } };
    } else if (operation === "EchelonConnectionActivate") {
      const input = variables.product as { id: string; status: string };
      const product = products.get(key(shopDomain, input.id)); if (!product) throw new Error("Missing product");
      product.status = input.status; data = { productUpdate: { product: { id: input.id }, userErrors: [] } };
    } else if (operation === "EchelonConnectionPublished") {
      const product = products.get(key(shopDomain, String(variables.id)));
      data = { product: { publishedOnPublication: product?.published.includes(String(variables.publication)) ?? false } };
    } else if (operation === "EchelonConnectionPublish") {
      const product = products.get(key(shopDomain, String(variables.id))); if (!product) throw new Error("Missing product");
      for (const publication of variables.input as Array<{ publicationId: string }>) if (!product.published.includes(publication.publicationId)) product.published.push(publication.publicationId);
      data = { publishablePublish: { userErrors: [] } };
    } else throw new Error(`Unhandled fake GraphQL operation ${operation}`);
    if (failAfter.delete(operation)) throw new Error(`Lost response after ${operation}`);
    return reply(data);
  });

  function seed(input: { productId: string; shopDomain?: string; title?: string; variants: Array<{ sku: string | null; priceCents?: number; tracked?: boolean; requiresShipping?: boolean }> }) {
    const shop = input.shopDomain ?? "test-store.myshopify.com";
    const product: NativeProduct = { id: `gid://shopify/Product/${input.productId}`, title: input.title ?? "Existing binder", handle: "existing-binder",
      status: "DRAFT", tags: [], ownership: null, published: [], media: [], descriptionHtml: "<p>Preserve this description</p>", variants: input.variants.map((variant, index) => ({
        id: `gid://shopify/ProductVariant/${nextVariant++}`, title: `Size ${index + 1}`, sku: variant.sku, barcode: null,
        price: formatShopifyConnectionMoney(variant.priceCents ?? 2599), compareAtPrice: null, inventoryQuantity: 3,
        inventoryItem: { id: `gid://shopify/InventoryItem/${nextVariant + 1000}`, tracked: variant.tracked ?? true, requiresShipping: variant.requiresShipping ?? true },
        selectedOptions: [{ name: "Package", value: `Size ${index + 1}` }], ownership: null, localVariant: null,
      })) };
    products.set(key(shop, product.id), product);
    return product;
  }
  return { fetchImpl, operations, products, failAfter, seed };
}
