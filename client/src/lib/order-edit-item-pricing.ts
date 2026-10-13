import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import type { OrderEditCatalogVariant } from "@shared/order-edits/order-edit-catalog";
import {
  OrderEditRequestError,
  type OrderEditTransport,
} from "@/lib/order-edits";

export type OrderEditItemPricing = {
  variant: OrderEditCatalogVariant;
  plan: MemberPlanPresentation | null;
};
type PricingCatalog = Pick<
  OrderEditTransport,
  "catalogProducts" | "catalogVariants"
>;
const MAX_METADATA_PAGES = 20;
const MAX_CONCURRENT_METADATA_READS = 2;

/** Reuse the owned order's catalog/customer pricing resolver. SKU discovers a
 * product; only the exact Shopify variant ID is allowed to match its price. */
async function readItemPricing(
  api: PricingCatalog,
  order: OrderEditOrder,
  line: OrderEditOrder["lines"][number],
  signal: AbortSignal,
): Promise<OrderEditItemPricing | null> {
  if (!line.variantId || !line.sku || line.quantity === 0) return null;
  let after: string | null = null;
  const productCursors = new Set<string>();
  for (let page = 0; page < MAX_METADATA_PAGES; page++) {
    signal.throwIfAborted();
    const products = await api.catalogProducts(
      order.connectionId,
      { search: line.sku, category: null, after },
      signal,
    );
    for (const product of products.products) {
      let variantAfter: string | null = null;
      const variantCursors = new Set<string>();
      for (
        let variantPage = 0;
        variantPage < MAX_METADATA_PAGES;
        variantPage++
      ) {
        signal.throwIfAborted();
        const variants = await api.catalogVariants(
          order.connectionId,
          {
            productId: product.productId,
            after: variantAfter,
            omsOrderId: order.omsOrderId,
            expectedRevision: order.revision,
          },
          signal,
        );
        const matched = variants.variants.find(
          (variant) => variant.variantId === line.variantId,
        );
        if (matched)
          return { variant: matched, plan: variants.memberPlan ?? null };
        if (!variants.pageInfo.hasNextPage) break;
        const cursor = variants.pageInfo.endCursor;
        if (
          !cursor ||
          variantCursors.has(cursor) ||
          variantPage === MAX_METADATA_PAGES - 1
        )
          throw unavailable();
        variantCursors.add(cursor);
        variantAfter = cursor;
      }
    }
    if (!products.pageInfo.hasNextPage) return null;
    const cursor = products.pageInfo.endCursor;
    if (!cursor || productCursors.has(cursor)) throw unavailable();
    productCursors.add(cursor);
    after = cursor;
  }
  throw unavailable();
}

export async function readOrderEditItemPricing(
  api: PricingCatalog,
  order: OrderEditOrder,
  signal: AbortSignal,
): Promise<Array<[string, OrderEditItemPricing]>> {
  const entries: Array<[string, OrderEditItemPricing] | null> = order.lines.map(
    () => null,
  );
  const pending = new Map<string, Promise<OrderEditItemPricing | null>>();
  let next = 0;
  async function worker() {
    while (next < order.lines.length) {
      const index = next++;
      const line = order.lines[index];
      const key = JSON.stringify([line.variantId, line.sku]);
      let read = pending.get(key);
      if (!read) {
        read = readItemPricing(api, order, line, signal);
        pending.set(key, read);
      }
      const pricing = await read;
      if (pricing) entries[index] = [line.lineItemId, pricing];
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_METADATA_READS, order.lines.length) },
      () => worker(),
    ),
  );
  return entries.filter(
    (entry): entry is [string, OrderEditItemPricing] => entry !== null,
  );
}
function unavailable() {
  return new OrderEditRequestError(
    "The product price comparison could not be verified.",
    "ORDER_EDIT_CATALOG_UNAVAILABLE",
    null,
    false,
  );
}
