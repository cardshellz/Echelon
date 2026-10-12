import type { Route } from "@playwright/test";
import type { ListingLifecycleView } from "../../shared/types/channel-listing-lifecycle";

export const LIFECYCLE_BASE = "/api/channels/77/listing-lifecycle";
export function createListingLifecycleMock() {
  return { items: [] as ListingLifecycleView[], writes: [] as { path: string; body: unknown }[], failRequest: false, failCheck: false,
    failSkus: new Set<string>(),
    lookupRevision: 0, account: { channelId: 77, connectionId: 9, provider: "walmart", market: "us",
      environment: "production", accountId: "10002558022", scopeId: "10002558022", revision: 1 } };
}
export async function handleListingLifecycleRequest(route: Route, state: ReturnType<typeof createListingLifecycleMock>): Promise<boolean> {
  const path = new URL(route.request().url()).pathname;
  if (!path.startsWith(LIFECYCLE_BASE)) return false;
  const body = route.request().postDataJSON();
  const reply = async (json: unknown, status = 200) => { await route.fulfill({ json, status }); return true; };
  if (path.endsWith("/lookup")) {
    state.lookupRevision = state.account.revision;
    return reply({ account: state.account, items: state.items.filter(item => body.skus.includes(item.sku)) });
  }
  if (path.endsWith("/history")) {
    const items = [...state.items].filter(item => (!body.sku || item.sku === body.sku) && (!body.afterSku || item.sku > body.afterSku))
      .sort((a, b) => a.sku.localeCompare(b.sku));
    return reply({ account: state.account, items: items.slice(0, 100), nextSku: items.length > 100 ? items[99].sku : null });
  }
  state.writes.push({ path, body });
  if (path === LIFECYCLE_BASE) {
    if (state.failRequest || state.failSkus.has(body.sku) || JSON.stringify(body.account) !== JSON.stringify(state.account)) return reply({ error: "Walmart account changed. Refresh and try again." }, 409);
    let record = state.items.find(item => item.sku === body.sku);
    if (!record) {
      record = { id: "44444444-4444-4444-8444-444444444444", sku: body.sku, title: `Product ${body.sku}`, action: body.action,
        state: "pending", message: "Unpublishing has been requested.", requestedAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z" };
      state.items.push(record);
    } else if (body.action === "remove") record.action = "remove";
    return reply(record);
  }
  if (path.endsWith("/status")) {
    const record = state.items.find(item => item.sku === body.sku)!;
    record.state = state.failCheck ? "failed" : "retired";
    record.message = state.failCheck ? "Walmart is unavailable. Publication remains stopped. Check again to retry." : "Walmart confirmed this listing is unpublished.";
    return reply(record);
  }
  return reply({ error: "Unexpected lifecycle request" }, 500);
}
