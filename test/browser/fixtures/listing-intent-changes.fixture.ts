import type { Route } from "@playwright/test";
import { z } from "zod";
import { listingIntentChangePageSchema, listingIntentChangeStatusSchema,
  type ListingIntentChangeStatus } from "../../../shared/listing-intent-propagation";

export function createListingIntentChangesMock(channelId: number, canEdit = true) {
  return { channelId, canEdit, items: [] as ListingIntentChangeStatus[], reads: [] as string[], retries: [] as string[] };
}
export function channelIntentChange(channelId: number, input: Partial<ListingIntentChangeStatus>): ListingIntentChangeStatus {
  return listingIntentChangeStatusSchema.parse({
    id: "1", change_id: "1", product_id: 1, variant_ids: [11], state: "needs_review", receipt: null, can_retry: false,
    destination: { kind: "channel", provider: channelId === 67 ? "ebay" : "walmart", channelId,
      connectionId: channelId === 67 ? 34 : 9, vendorId: null, accountId: "fixture-account",
      environment: "production", marketplaceId: channelId === 67 ? "EBAY_US" : "US", ambiguousConnection: false },
    last_error_code: "LISTING_INTENT_STRUCTURE_REVIEW", last_error_message: "Review the changed product category.",
    last_error_resolution: null, attempt_count: 1, created_at: "2026-10-19T12:00:00.000Z", updated_at: "2026-10-19T12:00:00.000Z",
    source_relation: "catalog.products", changed_fields: ["category_id"], operation: "UPDATE",
    before_scope: { id: 1, category_id: 1 }, after_scope: { id: 1, category_id: 2 }, actor_provenance: {}, ...input,
  });
}
export function listingIntentChangePage(url: URL, items: ListingIntentChangeStatus[]) {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict().parse(Object.fromEntries(url.searchParams));
  return listingIntentChangePageSchema.parse({ items: items.slice(query.offset, query.offset + query.limit),
    total: items.length, ...query });
}
/** Accept only the declared channel's status route and a known eligible retry.
 * Every other API continues to the fixture's unexpected-request failure. */
export async function handleListingIntentChangesRequest(route: Route, state: ReturnType<typeof createListingIntentChangesMock>): Promise<boolean> {
  const request = route.request();
  const url = new URL(request.url());
  const base = `/api/channels/${state.channelId}/listing-intent-changes`;
  if (request.method() === "GET" && url.pathname === base) {
    state.reads.push(url.pathname + url.search);
    await route.fulfill({ json: listingIntentChangePage(url, state.items) });
    return true;
  }
  if (request.method() === "POST") {
    const row = state.items.find(item => url.pathname === `${base}/${item.id}/retry`);
    if (!row) return false;
    state.retries.push(url.pathname);
    if (!state.canEdit) { await route.fulfill({ status: 403, json: { message: "Channel edit permission is required." } }); return true; }
    const retried = row.state === "blocked" && row.can_retry;
    if (retried) { row.state = "pending"; row.can_retry = false; row.last_error_message = null; }
    await route.fulfill({ json: { retried } });
    return true;
  }
  return false;
}
