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
  available: z.number().int().nonnegative().safe(),
});

/** Read-only provider boundary. Credentials never follow a redirect or a Link URL. */
export class ShopifyIdentityReader {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async get(connection: ShopifyIdentityConnection, path: string): Promise<Response> {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(connection.shopDomain)
      || !/^\d{4}-\d{2}$/.test(connection.apiVersion)) {
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
    externalIdentitySchema.parse(locationId);
    const quantities = new Map<string, number>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const maxPages = 2_000; // Bounded to 500,000 records; incomplete reads must never be applied.
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams(cursor ? { page_info: cursor, limit: "250" } : { location_ids: locationId, limit: "250" });
      const response = await this.get(connection, `inventory_levels.json?${query}`);
      const parsed = z.object({ inventory_levels: z.array(levelSchema) }).safeParse(await response.json());
      if (!parsed.success) throw new ChannelIdentityError("SHOPIFY_INVENTORY_RESPONSE_INVALID", "Inventory contains invalid IDs or quantities; no quantities may be applied");
      for (const level of parsed.data.inventory_levels) {
        if (level.location_id !== locationId || quantities.has(level.inventory_item_id)) {
          throw new ChannelIdentityError("SHOPIFY_INVENTORY_SCOPE_AMBIGUOUS", "Inventory contains another location or a duplicate item");
        }
        quantities.set(level.inventory_item_id, level.available);
      }
      const link = response.headers.get("Link");
      const next = link?.split(",").find((part) => /rel="next"/.test(part));
      if (!next) return quantities;
      const href = next.match(/<([^>]+)>/)?.[1];
      const nextUrl = href ? new URL(href) : null;
      cursor = nextUrl?.searchParams.get("page_info") ?? null;
      if (!cursor || cursors.has(cursor) || nextUrl?.hostname !== connection.shopDomain
        || nextUrl?.protocol !== "https:" || nextUrl?.port || nextUrl?.username || nextUrl?.password
        || nextUrl?.pathname !== `/admin/api/${connection.apiVersion}/inventory_levels.json`) {
        throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGINATION_INVALID", "Inventory pagination is incomplete, repeated, or outside the selected store");
      }
      cursors.add(cursor);
    }
    throw new ChannelIdentityError("SHOPIFY_INVENTORY_PAGE_LIMIT", "Inventory read exceeded its safety bound; no quantities may be applied");
  }
}
