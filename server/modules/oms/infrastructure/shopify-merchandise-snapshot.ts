import { z } from "zod";
import type { ShopifyAdminGraphQLClient } from "../../shopify/admin-gql-client";

const quantity = z.number().int().min(0).max(2_147_483_647);
const lineSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/),
  quantity, currentQuantity: quantity, unfulfilledQuantity: quantity,
}).superRefine((line, context) => {
  if (line.currentQuantity > line.quantity || line.unfulfilledQuantity > line.currentQuantity)
    context.addIssue({ code: "custom", message: "Channel merchandise quantities are inconsistent." });
});
const responseSchema = z.object({
  shop: z.object({ myshopifyDomain: z.string() }),
  order: z.object({
    id: z.string(), updatedAt: z.string().datetime(), cancelledAt: z.string().datetime().nullable(),
    lineItems: z.object({ nodes: z.array(lineSchema),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});

export interface ShopifyMerchandiseSnapshot {
  orderId: string;
  shopDomain: string;
  updatedAt: string;
  cancelled: boolean;
  lines: Array<z.infer<typeof lineSchema>>;
}

const QUERY = `query OmsMerchandiseQuantity($id: ID!, $after: String) {
  shop { myshopifyDomain }
  order(id:$id) { id updatedAt cancelledAt lineItems(first:250,after:$after) {
    nodes { id quantity currentQuantity unfulfilledQuantity }
    pageInfo { hasNextPage endCursor }
  } }
}`;

/** Read-only. Bind every page to the originating shop, order and source version. */
export async function readShopifyMerchandiseSnapshot(
  client: ShopifyAdminGraphQLClient,
  input: { orderId: string; shopDomain: string },
): Promise<ShopifyMerchandiseSnapshot> {
  const orderId = `gid://shopify/Order/${z.string().regex(/^[1-9]\d*$/).parse(input.orderId.replace(/^gid:\/\/shopify\/Order\//, ""))}`;
  const shopDomain = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/).parse(input.shopDomain);
  const lines: ShopifyMerchandiseSnapshot["lines"] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let version: string | undefined;
  let cancelled = false;
  // A bounded failure retries the entire observation; partial snapshots cannot change demand.
  const MAX_PAGES = 100;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = responseSchema.parse(await client.request(QUERY, { id: orderId, after }));
    const order = result.order;
    if (result.shop.myshopifyDomain !== shopDomain || order.id !== orderId
      || (version !== undefined && order.updatedAt !== version))
      throw Object.assign(new Error("Channel merchandise identity or version changed during readback."), { code: "CHANNEL_QUANTITY_READBACK_CHANGED" });
    version = order.updatedAt;
    cancelled = order.cancelledAt !== null;
    for (const line of order.lineItems.nodes) {
      if (identities.has(line.id)) throw new Error("Channel merchandise readback contains duplicate line identities.");
      identities.add(line.id);
      lines.push(line);
    }
    if (!order.lineItems.pageInfo.hasNextPage)
      return { orderId, shopDomain, updatedAt: version, cancelled, lines };
    after = order.lineItems.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Channel merchandise pagination did not advance.");
    cursors.add(after);
  }
  throw new Error("Channel merchandise pagination exceeded its safe bound.");
}
