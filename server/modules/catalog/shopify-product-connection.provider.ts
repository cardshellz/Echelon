import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { formatShopifyConnectionMoney, parseShopifyConnectionMoney } from "@shared/catalog/shopify-product-connection";
import type { ShopifyConnectionCredentials } from "./shopify-product-connection.repository";
import {
  ShopifyProductConnectionError, type ShopifyConnectionCreateSpec,
  type ShopifyConnectionRemoteProduct,
} from "./shopify-product-connection.domain";

const REQUEST_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;
const VARIANT_PAGE_SIZE = 100;
const MAX_VARIANT_PAGES = 22;
export const SHOPIFY_VARIANT_WRITE_BATCH_SIZE = 100;
const SKU_SEARCH_BATCH_SIZE = 25;
const METAFIELD_NAMESPACE = "echelon";
const COMMAND_METAFIELD_KEY = "connection_command";

export class ShopifyConnectionProviderError extends ShopifyProductConnectionError {
  constructor(code: string, message: string, public readonly writeOutcome: "not_applied" | "unknown", statusCode = 502, retryable = true) {
    super(code, message, statusCode, retryable);
  }
}

const metafieldSchema = z.object({ value: z.string() }).nullable();
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const variantSchema = z.object({
  id: z.string(), title: z.string(), sku: z.string().nullable(), barcode: z.string().nullable(), price: z.string(), compareAtPrice: z.string().nullable(),
  inventoryQuantity: z.number().int(),
  inventoryItem: z.object({ id: z.string(), tracked: z.boolean(), requiresShipping: z.boolean() }),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  ownership: metafieldSchema,
  localVariant: metafieldSchema,
});
const productSchema = z.object({
  id: z.string(), title: z.string(), handle: z.string(), status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]),
  ownership: metafieldSchema,
  variants: z.object({ nodes: z.array(variantSchema), pageInfo: pageInfoSchema }),
});
const PRODUCT_QUERY = `query EchelonConnectionProduct($id: ID!, $after: String) {
  product(id: $id) {
    id title handle status
    ownership: metafield(namespace: "echelon", key: "connection_command") { value }
    variants(first: ${VARIANT_PAGE_SIZE}, after: $after) {
      nodes { id title sku barcode price compareAtPrice inventoryQuantity
        inventoryItem { id tracked requiresShipping }
        selectedOptions { name value }
        ownership: metafield(namespace: "echelon", key: "connection_command") { value }
        localVariant: metafield(namespace: "echelon", key: "catalog_variant_id") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type ProviderData = Record<string, unknown>;

function numericId(value: string, kind: "Product" | "ProductVariant" | "InventoryItem" | "Publication"): string {
  const match = new RegExp(`^gid://shopify/${kind}/([1-9][0-9]{0,29})$`).exec(value);
  if (!match) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", `Shopify returned an invalid ${kind} identity.`, 502);
  return match[1];
}

function gid(value: string, kind: "Product" | "Publication"): string {
  if (!/^[1-9][0-9]{0,29}$/.test(value)) throw new ShopifyProductConnectionError("SHOPIFY_ID_INVALID", "The Shopify identity is invalid.", 400);
  return `gid://shopify/${kind}/${value}`;
}

function searchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function connectionOwnership(channelId: number, productId: number, commandKey: string): string {
  return `${channelId}:${productId}:${commandKey}`;
}

function commandTag(commandKey: string): string { return `echelon-connection-${commandKey}`; }

function metadata(key: string, value: string) {
  return { namespace: METAFIELD_NAMESPACE, key, type: "single_line_text_field", value };
}

function userErrors(payload: unknown): string[] {
  const result = z.object({ userErrors: z.array(z.object({ message: z.string() })).optional() }).safeParse(payload);
  return result.success ? (result.data.userErrors ?? []).map(error => error.message) : [];
}

export function createShopifyProductConnectionProvider(input: {
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

  async function graphql(credentials: ShopifyConnectionCredentials, query: string, variables: Record<string, unknown>, mutation = false, heartbeat?: () => Promise<void>): Promise<ProviderData> {
    // Every URL is constructed from the pinned connection, never a pasted URL.
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(credentials.shopDomain)
      || !/^20\d{2}-(01|04|07|10)$/.test(credentials.apiVersion)) {
      throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_INVALID", "The selected Shopify connection is invalid.", 422);
    }
    for (let attempt = 1; attempt <= (mutation ? 1 : READ_ATTEMPTS); attempt += 1) {
      await heartbeat?.();
      let response: Response;
      try {
        response = await fetchImpl(`https://${credentials.shopDomain}/admin/api/${credentials.apiVersion}/graphql.json`, {
          method: "POST", redirect: "error", headers: { "X-Shopify-Access-Token": credentials.accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (!mutation && attempt < READ_ATTEMPTS) { await sleep(200 * attempt); continue; }
        throw new ShopifyConnectionProviderError("SHOPIFY_REQUEST_UNCERTAIN", "Shopify did not confirm the request. Resume this saved command to check its outcome safely.", "unknown");
      }
      if (!response.ok) {
        const definitelyRefused = [400,401,403,404,405,406,413,415,422,429].includes(response.status);
        const transient = response.status === 429 || !definitelyRefused;
        if (!mutation && transient && attempt < READ_ATTEMPTS) { await sleep(200 * attempt); continue; }
        throw new ShopifyConnectionProviderError(
          response.status === 429 ? "SHOPIFY_RATE_LIMITED" : "SHOPIFY_REQUEST_FAILED",
          `Shopify refused the ${mutation ? "write" : "lookup"} (HTTP ${response.status}). Check the channel connection and retry.`,
          definitelyRefused ? "not_applied" : "unknown", response.status === 429 ? 429 : 502, transient,
        );
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new ShopifyConnectionProviderError("SHOPIFY_RESPONSE_INVALID", "Shopify returned an unreadable response. Resume the saved command to verify its outcome.", "unknown"); }
      const envelope = z.object({ data: z.record(z.unknown()).nullable().optional(), errors: z.array(z.object({ message: z.string(), extensions: z.record(z.unknown()).optional() })).optional() }).safeParse(body);
      if (!envelope.success) throw new ShopifyConnectionProviderError("SHOPIFY_RESPONSE_INVALID", "Shopify returned an incomplete response.", "unknown");
      if (envelope.data.errors?.length) {
        const throttled = envelope.data.errors.every(error => error.extensions?.code === "THROTTLED");
        if (!mutation && throttled && attempt < READ_ATTEMPTS) { await sleep(200 * attempt); continue; }
        // GraphQL can return null after a resolver committed and then failed.
        // Only proven pre-execution refusals establish that no write applied.
        const definitelyRefused = !envelope.data.data && envelope.data.errors.every(error =>
          ["THROTTLED", "GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"].includes(String(error.extensions?.code)));
        throw new ShopifyConnectionProviderError(throttled ? "SHOPIFY_RATE_LIMITED" : "SHOPIFY_GRAPHQL_REFUSED",
          throttled ? "Shopify is busy. Retry this reviewed request shortly." : "Shopify could not execute the request. Check the channel's product permissions.",
          definitelyRefused ? "not_applied" : "unknown", throttled ? 429 : 502, throttled || !definitelyRefused);
      }
      if (!envelope.data.data) throw new ShopifyConnectionProviderError("SHOPIFY_RESPONSE_INVALID", "Shopify returned no result.", "unknown");
      return envelope.data.data;
    }
    throw new ShopifyProductConnectionError("SHOPIFY_READ_EXHAUSTED", "Shopify could not be read after bounded retries.", 503, true);
  }

  async function product(credentials: ShopifyConnectionCredentials, productId: string, heartbeat?: () => Promise<void>): Promise<ShopifyConnectionRemoteProduct> {
    let cursor: string | null = null;
    let result: ShopifyConnectionRemoteProduct | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_VARIANT_PAGES; page += 1) {
      const data = await graphql(credentials, PRODUCT_QUERY, { id: gid(productId, "Product"), after: cursor }, false, heartbeat);
      if (data.product === null) throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_NOT_FOUND", "This Shopify product was not found in the selected store.", 404);
      const parsed = productSchema.safeParse(data.product);
      if (!parsed.success) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify returned incomplete product or variant evidence.", 502);
      const remote = parsed.data;
      if (numericId(remote.id, "Product") !== productId) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify returned a different product identity.", 502);
      if (!result) result = { id: productId, title: remote.title, handle: remote.handle, status: remote.status, ownership: remote.ownership?.value ?? null, variants: [] };
      if (remote.title !== result.title || remote.status !== result.status || (remote.ownership?.value ?? null) !== result.ownership) {
        throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_CHANGED", "The Shopify product changed during verification. Refresh the review.", 409, true);
      }
      for (const variant of remote.variants.nodes) {
        const id = numericId(variant.id, "ProductVariant");
        if (seen.has(id)) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify repeated a variant during pagination.", 502);
        seen.add(id);
        const priceCents = parseShopifyConnectionMoney(variant.price);
        const compareAtPriceCents = variant.compareAtPrice === null ? null : parseShopifyConnectionMoney(variant.compareAtPrice);
        const localId = variant.localVariant?.value ?? null;
        if (priceCents === null || variant.compareAtPrice !== null && compareAtPriceCents === null
          || (localId !== null && localId !== "product" && (!/^[1-9][0-9]*$/.test(localId) || !Number.isSafeInteger(Number(localId)) || Number(localId)>2_147_483_647))) {
          throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify returned an invalid price or catalog variant marker.", 502);
        }
        result.variants.push({ id, sku: variant.sku || null, barcode: variant.barcode,
          inventoryItemId: numericId(variant.inventoryItem.id, "InventoryItem"), title: variant.title,
          optionValue: variant.selectedOptions.length === 1 ? variant.selectedOptions[0].value : variant.title,
          priceCents, compareAtPriceCents, localVariantId: localId === null || localId === "product" ? null : Number(localId),
          ownership: variant.ownership?.value ?? null, requiresShipping: variant.inventoryItem.requiresShipping,
          trackInventory: variant.inventoryItem.tracked, inventoryQuantity: variant.inventoryQuantity,
        });
      }
      if (!remote.variants.pageInfo.hasNextPage) return result;
      const next = remote.variants.pageInfo.endCursor;
      if (!next || next === cursor) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify returned an invalid variant cursor.", 502);
      cursor = next;
    }
    throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_LIMIT", "The complete Shopify variant set could not be verified within the supported product limit.", 422);
  }

  async function productSearch(credentials: ShopifyConnectionCredentials, query: string, heartbeat?: () => Promise<void>) {
    const data = await graphql(credentials, `query EchelonConnectionSearch($query: String!) {
      products(first: 50, query: $query) { nodes { id title status } pageInfo { hasNextPage } }
    }`, { query }, false, heartbeat);
    const parsed = z.object({ nodes: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }).safeParse(data.products);
    if (!parsed.success || parsed.data.pageInfo.hasNextPage) throw new ShopifyProductConnectionError("SHOPIFY_SEARCH_AMBIGUOUS", "Shopify returned too many or incomplete matching products. Use an exact Shopify product ID.", 422);
    return parsed.data.nodes.map(row => ({ ...row, id: numericId(row.id, "Product") }));
  }

  async function matches(credentials: ShopifyConnectionCredentials, skus: readonly string[], heartbeat?: () => Promise<void>) {
    const found = new Map<string, { id: string; title: string; status: string }>();
    const unique = [...new Set(skus.map(sku => sku.trim()).filter(Boolean))];
    for (let offset = 0; offset < unique.length; offset += SKU_SEARCH_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + SKU_SEARCH_BATCH_SIZE);
      const candidates = await productSearch(credentials, batch.map(sku => `sku:${searchValue(sku)}`).join(" OR "), heartbeat);
      // Search is a candidate source, not proof. Verify exact returned SKUs;
      // Shopify's search tokenization must not create false identities.
      for (const candidate of candidates) {
        if (found.has(candidate.id)) continue;
        const remote = await product(credentials, candidate.id, heartbeat);
        if (remote.variants.some(variant => batch.some(sku => variant.sku?.trim().toUpperCase() === sku.toUpperCase()))) found.set(candidate.id, candidate);
      }
    }
    return [...found.values()];
  }

  async function owned(credentials: ShopifyConnectionCredentials, commandKey: string, ownership: string, heartbeat?: () => Promise<void>): Promise<ShopifyConnectionRemoteProduct | null> {
    const candidates = await productSearch(credentials, `tag:${searchValue(commandTag(commandKey))}`, heartbeat);
    const matching: ShopifyConnectionRemoteProduct[] = [];
    for (const candidate of candidates) {
      const remote = await product(credentials, candidate.id, heartbeat);
      if (remote.ownership === ownership) matching.push(remote);
    }
    if (matching.length > 1) throw new ShopifyProductConnectionError("SHOPIFY_CREATE_AMBIGUOUS", "More than one Shopify product carries this command's ownership marker. Review is required.");
    return matching[0] ?? null;
  }

  async function create(credentials: ShopifyConnectionCredentials, input: { spec: ShopifyConnectionCreateSpec; commandKey: string; ownership: string; handle: string }): Promise<string> {
    const media = input.spec.images.map(image => {
      let url: URL;
      try { url = new URL(image.url); } catch { throw new ShopifyProductConnectionError("CATALOG_IMAGE_INVALID", "A catalog image has an invalid URL.", 422); }
      if (url.protocol !== "https:" || url.username || url.password) throw new ShopifyProductConnectionError("CATALOG_IMAGE_INVALID", "Catalog images must use public HTTPS URLs without credentials.", 422);
      return { originalSource: url.toString(), alt: image.alt, mediaContentType: "IMAGE" };
    });
    if (media.length > 250) throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_LIMIT", "Select at most 250 catalog photos before creating this Shopify product.", 422);
    const data = await graphql(credentials, `mutation EchelonConnectionCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) { product { id } userErrors { field message } }
    }`, { product: {
      title: input.spec.title, descriptionHtml: input.spec.descriptionHtml ? sanitizeHtml(input.spec.descriptionHtml) : undefined,
      vendor: input.spec.vendor ?? undefined, productType: input.spec.productType ?? undefined,
      handle: input.handle, status: "DRAFT", tags: [...input.spec.tags, commandTag(input.commandKey)],
      metafields: [metadata(COMMAND_METAFIELD_KEY, input.ownership)],
      productOptions: [{ name: "Package", values: [{ name: input.spec.variants[0].optionValue }] }],
    }, media }, true);
    const parsed = z.object({ product: z.object({ id: z.string() }).nullable(), userErrors: z.array(z.object({ message: z.string() })) }).safeParse(data.productCreate);
    if (!parsed.success) throw new ShopifyConnectionProviderError("SHOPIFY_RESPONSE_INVALID", "Shopify did not confirm the new product identity. Resume the saved command.", "unknown");
    if (parsed.data.product) return numericId(parsed.data.product.id, "Product");
    throw new ShopifyConnectionProviderError("SHOPIFY_CREATE_REJECTED", `Shopify rejected product creation: ${parsed.data.userErrors.map(error => error.message).join("; ").slice(0,500)}`, "not_applied", 422, false);
  }

  async function createVariants(credentials: ShopifyConnectionCredentials, input: {
    productId: string; variants: ShopifyConnectionCreateSpec["variants"]; ownership: string; removePlaceholder: boolean;
  }): Promise<void> {
    if (input.variants.length < 1 || input.variants.length > SHOPIFY_VARIANT_WRITE_BATCH_SIZE) throw new TypeError("Invalid Shopify variant batch size.");
    const data = await graphql(credentials, `mutation EchelonConnectionVariants($id: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
      productVariantsBulkCreate(productId: $id, variants: $variants, strategy: $strategy) { productVariants { id } userErrors { field message } }
    }`, { id: gid(input.productId, "Product"), strategy: input.removePlaceholder ? "REMOVE_STANDALONE_VARIANT" : "PRESERVE_STANDALONE_VARIANT",
      variants: input.variants.map(variant => ({
        price: formatShopifyConnectionMoney(variant.priceCents),
        compareAtPrice: variant.compareAtPriceCents === null ? null : formatShopifyConnectionMoney(variant.compareAtPriceCents),
        barcode: variant.barcode, optionValues: [{ optionName: "Package", name: variant.optionValue }],
        inventoryItem: { sku: variant.sku ?? "", tracked: variant.trackInventory, requiresShipping: variant.requiresShipping },
        metafields: [metadata(COMMAND_METAFIELD_KEY, input.ownership), metadata("catalog_variant_id", variant.localVariantId === null ? "product" : String(variant.localVariantId))],
      })) }, true);
    const errors = userErrors(data.productVariantsBulkCreate);
    if (errors.length) throw new ShopifyConnectionProviderError("SHOPIFY_VARIANT_CREATE_REFUSED", `Shopify could not finish the variants: ${errors.join("; ").slice(0,500)}`, "unknown", 422, true);
  }

  async function capabilities(credentials: ShopifyConnectionCredentials) {
    const data = await graphql(credentials, `query EchelonConnectionScopes { shop { myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`, {});
    const parsed = z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }).safeParse(data.currentAppInstallation);
    if (!parsed.success) throw new ShopifyProductConnectionError("SHOPIFY_RESPONSE_INVALID", "Shopify did not return the connected app's permissions.", 502);
    const shop = z.object({ myshopifyDomain: z.string(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).safeParse(data.shop);
    if (!shop.success || shop.data.myshopifyDomain !== credentials.shopDomain) {
      throw new ShopifyProductConnectionError("SHOPIFY_ACCOUNT_MISMATCH", "Shopify did not confirm the selected store and currency.", 502);
    }
    return { scopes: new Set(parsed.data.accessScopes.map(scope => scope.handle)), currency: shop.data.currencyCode };
  }

  async function verifyMedia(credentials: ShopifyConnectionCredentials, productId: string, expectedCount: number, heartbeat?: () => Promise<void>): Promise<void> {
    if (!Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > 250) throw new TypeError("Invalid product photo count.");
    if (expectedCount === 0) return;
    const seen = new Set<string>(); let after: string | null = null;
    const mediaSchema = z.object({ media: z.object({ nodes: z.array(z.object({ id: z.string(), mediaContentType: z.string(),
      status: z.enum(["UPLOADED", "PROCESSING", "READY", "FAILED"]), mediaErrors: z.array(z.object({ code: z.string() })) })), pageInfo: pageInfoSchema }) });
    let processing = false;
    for (let page = 0; page < 3; page += 1) {
      const data = await graphql(credentials, `query EchelonConnectionMedia($id: ID!, $after: String) {
        product(id: $id) { media(first: 100, after: $after) { nodes { id mediaContentType status mediaErrors { code } } pageInfo { hasNextPage endCursor } } }
      }`, { id: gid(productId, "Product"), after }, false, heartbeat);
      const parsed = mediaSchema.safeParse(data.product);
      if (!parsed.success) throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_UNCONFIRMED", "Shopify has not confirmed the product's photos. The draft is retained for retry.", 502, true);
      for (const media of parsed.data.media.nodes) {
        if (seen.has(media.id) || media.mediaContentType !== "IMAGE") throw new ShopifyProductConnectionError("SHOPIFY_CREATED_MEDIA_CHANGED", "The created draft has unexpected media. Review it before publishing.");
        seen.add(media.id);
        if (media.status === "FAILED" || media.mediaErrors.length) throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_REJECTED", "Shopify could not process a catalog photo. Review the retained draft's photos before linking it.", 422);
        processing ||= media.status !== "READY";
      }
      if (!parsed.data.media.pageInfo.hasNextPage) {
        if (seen.size > expectedCount) throw new ShopifyProductConnectionError("SHOPIFY_CREATED_MEDIA_CHANGED", "The created draft has additional photos that were not in the reviewed intent.");
        if (seen.size < expectedCount || processing) throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_PROCESSING", "Shopify is still processing the catalog photos. This saved command will retry before publishing.", 503, true);
        return;
      }
      const next = parsed.data.media.pageInfo.endCursor;
      if (!next || next === after) break;
      after = next;
    }
    throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_UNCONFIRMED", "The complete Shopify photo list could not be verified. Review the retained draft.", 502, true);
  }

  async function publications(credentials: ShopifyConnectionCredentials): Promise<Array<{ id: string; name: string }>> {
    const data = await graphql(credentials, `query EchelonConnectionPublications { publications(first: 100) { nodes { id name } pageInfo { hasNextPage } } }`, {});
    const parsed = z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }).safeParse(data.publications);
    if (!parsed.success || parsed.data.pageInfo.hasNextPage) throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATIONS_INVALID", "The complete Shopify publication list could not be verified.", 502);
    return parsed.data.nodes.map(publication => ({ id: numericId(publication.id, "Publication"), name: publication.name }));
  }

  async function published(credentials: ShopifyConnectionCredentials, productId: string, publicationId: string): Promise<boolean> {
    const data = await graphql(credentials, `query EchelonConnectionPublished($id: ID!, $publication: ID!) { product(id: $id) { publishedOnPublication(publicationId: $publication) } }`,
      { id: gid(productId, "Product"), publication: gid(publicationId, "Publication") });
    const parsed = z.object({ publishedOnPublication: z.boolean() }).safeParse(data.product);
    if (!parsed.success) throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATION_UNKNOWN", "The product's Shopify publication state could not be verified.", 502, true);
    return parsed.data.publishedOnPublication;
  }

  async function activate(credentials: ShopifyConnectionCredentials, productId: string): Promise<void> {
    const data = await graphql(credentials, `mutation EchelonConnectionActivate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
      { product: { id: gid(productId, "Product"), status: "ACTIVE" } }, true);
    if (userErrors(data.productUpdate).length) throw new ShopifyProductConnectionError("SHOPIFY_ACTIVATION_REFUSED", "Shopify could not activate the fully mapped product. Resume the saved command.", 422, true);
  }

  async function publish(credentials: ShopifyConnectionCredentials, productId: string, publicationId: string): Promise<void> {
    const data = await graphql(credentials, `mutation EchelonConnectionPublish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
      { id: gid(productId, "Product"), input: [{ publicationId: gid(publicationId, "Publication") }] }, true);
    if (userErrors(data.publishablePublish).length) throw new ShopifyProductConnectionError("SHOPIFY_PUBLICATION_REFUSED", "Shopify could not publish the mapped product to the selected publication. Resume the saved command.", 422, true);
  }

  return { product, matches, owned, create, createVariants, capabilities, verifyMedia, publications, published, activate, publish };
}

export type ShopifyProductConnectionProvider = ReturnType<typeof createShopifyProductConnectionProvider>;
