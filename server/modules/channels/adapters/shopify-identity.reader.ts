import { z } from "zod";
import { ChannelIdentityError, externalIdentitySchema, providerRestIdentitySchema } from "../channel-identity.domain";

export interface ShopifyIdentityConnection {
  id: number;
  channelId: number;
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  shopifyLocationId: string | null;
}

const variantSchema = z.object({
  id: providerRestIdentitySchema,
  product_id: providerRestIdentitySchema,
  inventory_item_id: providerRestIdentitySchema,
  sku: z.string().nullable(),
});
export type ShopifyVariantIdentity = z.infer<typeof variantSchema>;

const levelSchema = z.object({
  inventory_item_id: providerRestIdentitySchema,
  location_id: providerRestIdentitySchema,
  available: z.number().int().nonnegative().safe().nullable(),
});

const apiVersionPattern = /^\d{4}-(01|04|07|10)$/;

/** Read-only provider boundary. Credentials never follow a redirect or a Link URL. */
export class ShopifyIdentityReader {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async get(connection: ShopifyIdentityConnection, path: string): Promise<Response> {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(connection.shopDomain)
      || !apiVersionPattern.test(connection.apiVersion)) {
      throw new ChannelIdentityError("SHOPIFY_CONNECTION_INVALID", "Invalid Shopify domain or API version");
    }
    let response: Response;
    try {
      response = await this.request(`https://${connection.shopDomain}/admin/api/${connection.apiVersion}/${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "X-Shopify-Access-Token": connection.accessToken, Accept: "application/json" },
      });
    } catch {
      throw new ChannelIdentityError("SHOPIFY_IDENTITY_READ_FAILED", "Shopify identity read did not complete", "transient");
    }
    if (!response.ok) {
      throw new ChannelIdentityError(
        response.status === 404 ? "SHOPIFY_IDENTITY_NOT_FOUND" : "SHOPIFY_IDENTITY_READ_REJECTED",
        `Shopify identity read returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500 ? "transient" : "permanent",
      );
    }
    return response;
  }

  async variant(connection: ShopifyIdentityConnection, externalVariantId: string): Promise<ShopifyVariantIdentity> {
    externalIdentitySchema.parse(externalVariantId);
    const response = await this.get(connection, `variants/${externalVariantId}.json`);
    const parsed = z.object({ variant: variantSchema }).safeParse(await response.json());
    if (!parsed.success || parsed.data.variant.id !== externalVariantId) {
      throw new ChannelIdentityError("SHOPIFY_IDENTITY_RESPONSE_INVALID", "Shopify returned an invalid or different variant identity");
    }
    return parsed.data.variant;
  }

  async inventory(connection: ShopifyIdentityConnection, locationId: string): Promise<Map<string, number>> {
    const levels = await this.inventoryLevels(connection, locationId);
    const quantities = new Map<string, number>();
    for (const [id, quantity] of levels) {
      if (quantity === null) throw new ChannelIdentityError("SHOPIFY_INVENTORY_RESPONSE_INVALID", "Inventory contains an untracked item; its quantity is unknown, not zero");
      quantities.set(id, quantity);
    }
    return quantities;
  }

  /** Shopify explicitly returns null for untracked items. Preserve that evidence. */
  async inventoryLevels(connection: ShopifyIdentityConnection, locationId: string): Promise<Map<string, number | null>> {
    externalIdentitySchema.parse(locationId);
    const quantities = new Map<string, number | null>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let servedVersion: string | null = null;
    const maxPages = 2_000; // Bounded to 500,000 records; incomplete reads must never be applied.
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams(cursor ? { page_info: cursor, limit: "250" } : { location_ids: locationId, limit: "250" });
      const requestedVersion: string = servedVersion ?? connection.apiVersion;
      const response = await this.get({ ...connection, apiVersion: requestedVersion }, `inventory_levels.json?${query}`);
      const responseVersion: string = response.headers.get("X-Shopify-API-Version") ?? servedVersion ?? connection.apiVersion;
      if (!apiVersionPattern.test(responseVersion) || (servedVersion !== null && responseVersion !== servedVersion)) {
        throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGINATION_INVALID", "Shopify changed or returned an invalid API version during inventory pagination");
      }
      // Retired request versions fall forward. Only the trusted response header,
      // never a version supplied solely by a Link URL, may choose the served version.
      servedVersion = responseVersion;
      const parsed = z.object({ inventory_levels: z.array(levelSchema) }).safeParse(await response.json());
      if (!parsed.success) throw new ChannelIdentityError("SHOPIFY_INVENTORY_RESPONSE_INVALID", "Inventory contains invalid IDs or quantities; no quantities may be applied");
      for (const level of parsed.data.inventory_levels) {
        if (level.location_id !== locationId || quantities.has(level.inventory_item_id)) {
          throw new ChannelIdentityError("SHOPIFY_INVENTORY_SCOPE_AMBIGUOUS", "Inventory contains another location or a duplicate item");
        }
        quantities.set(level.inventory_item_id, level.available);
      }
      const link = response.headers.get("Link");
      const nextLinks = link?.split(",").filter((part) => /rel="next"/.test(part)) ?? [];
      if (nextLinks.length > 1) throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGINATION_INVALID", "Shopify returned ambiguous inventory pagination");
      const next = nextLinks[0];
      if (!next) return quantities;
      const href = next.match(/<([^>]+)>/)?.[1];
      let nextUrl: URL | null = null;
      try { nextUrl = href ? new URL(href) : null; } catch { /* Invalid URL classified below. */ }
      cursor = nextUrl?.searchParams.get("page_info") ?? null;
      // Shopify can retain the request version in Link when serving a newer one.
      // Accept either exact resource path, but only carry the cursor forward;
      // the next request is still constructed locally using the pinned served version.
      const hasExpectedPath = nextUrl?.pathname === `/admin/api/${requestedVersion}/inventory_levels.json`
        || nextUrl?.pathname === `/admin/api/${servedVersion}/inventory_levels.json`;
      if (!cursor || cursors.has(cursor) || nextUrl?.hostname !== connection.shopDomain.toLowerCase()
        || nextUrl?.protocol !== "https:" || nextUrl?.port || nextUrl?.username || nextUrl?.password
        || nextUrl?.hash || nextUrl?.searchParams.getAll("page_info").length !== 1
        || !hasExpectedPath) {
        throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGINATION_INVALID", "Inventory pagination is incomplete, repeated, or outside the selected store");
      }
      cursors.add(cursor);
    }
    throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGE_LIMIT", "Inventory read exceeded its safety bound; no quantities may be applied");
  }
}
