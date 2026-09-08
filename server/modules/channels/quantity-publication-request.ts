import { createHash } from "node:crypto";
import { QuantityPublicationAdmissionError } from "../inventory-planning/domain/quantity-publication-admission";

export interface EbayQuantityHttpRequest {
  method: string; path: string; body?: unknown; expectNoContent?: boolean;
}
export interface EbayQuantityRequestAdmission {
  item<T>(sku: string, work: (quantity: number | null) => Promise<T>): Promise<T>;
  group<T>(groupKey: string, skus: readonly string[], work: (quantities: ReadonlyMap<string, number> | null) => Promise<T>): Promise<T>;
  reducing<T>(identity: string, work: () => Promise<T>, memberSkus?: readonly string[]): Promise<T>;
}

/** Includes lifecycle mutations that can expose retained quantity; price-only bulk requests are excluded. */
export function ebayQuantityMutationIdentity(method: string, path: string, body: unknown): string | null {
  if (method === "GET" || !path.startsWith("/sell/inventory/v1/")) return null;
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (path.includes("bulk_update_price_quantity")) {
    const requests = Array.isArray(record.requests) ? record.requests : [];
    const quantityRequests = requests.filter(hasQuantity);
    if (quantityRequests.length === 0) return null;
    if (quantityRequests.length === 1 && typeof quantityRequests[0]?.sku === "string") return quantityRequests[0].sku;
    return `batch:${createHash("sha256").update(JSON.stringify(quantityRequests.map(row => row.sku ?? null))).digest("hex")}`;
  }
  const inventory = path.match(/^\/sell\/inventory\/v1\/inventory_item\/([^/?]+)$/);
  if (inventory) return decodeURIComponent(inventory[1]);
  if (/\/inventory_item_group\//.test(path)) return `group:${decodeURIComponent(path.split("/").pop()!)}`;
  if (path.includes("/offer")) {
    if (typeof record.sku === "string" && record.sku.trim()) return record.sku;
    if (typeof record.inventoryItemGroupKey === "string") return `group:${record.inventoryItemGroupKey}`;
    return `offer:${path.split("/").slice(5).join(":")}`;
  }
  return null;
}

function hasQuantity(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasQuantity);
  return Object.entries(value).some(([key, nested]) => key === "availableQuantity" || key === "quantity" || hasQuantity(nested));
}

/** Clones every nested quantity-bearing field; never modifies a persisted listing intent or caller object. */
export function rewriteEbayCanonicalQuantities(value: unknown, quantity: number): unknown {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("Canonical listing quantity is invalid.");
  if (Array.isArray(value)) return value.map(entry => rewriteEbayCanonicalQuantities(entry, quantity));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
    key === "quantity" || key === "availableQuantity" ? quantity : rewriteEbayCanonicalQuantities(nested, quantity)]));
}

/** One low-level protocol shared by routed eBay, maintenance routes, and Dropship.
 * Numeric writes are admitted by exact SKU. Publishing a retained group first
 * refreshes ALL member inventory items/offers under the group's held member locks.
 */
export async function executeAdmittedEbayQuantityRequest<T>(input: EbayQuantityHttpRequest,
  admission: EbayQuantityRequestAdmission, request: <R>(input: EbayQuantityHttpRequest) => Promise<R>): Promise<T> {
  const identity = ebayQuantityMutationIdentity(input.method, input.path, input.body);
  if (!identity) return request<T>(input);
  const body = record(input.body);
  if (input.path.includes("bulk_update_price_quantity") && Array.isArray(body.requests) && body.requests.length > 1) {
    // A single SKU owns each admission/plan. Preserve response shape while avoiding
    // an unproven synthetic batch identity that could hide per-SKU concurrency.
    if (body.requests.length > 250) throw invalid("An eBay quantity batch exceeds the bounded owner limit.");
    const responses: unknown[] = [];
    for (const row of body.requests) {
      const result = await executeAdmittedEbayQuantityRequest<{ responses: unknown[] }>({ ...input, body: { ...body, requests: [row] } }, admission, request);
      if (!Array.isArray(result?.responses)) throw invalid("eBay bulk quantity response omitted its result array.");
      responses.push(...result.responses);
    }
    return { responses } as T;
  }
  // Explicit withdrawals/deletions and all-zero quantities cannot introduce a
  // positive promise. They still participate in durable suppression/drain.
  const aggregateWrite = input.path.includes("bulk_update_price_quantity")
    || /^\/sell\/inventory\/v1\/inventory_item\/[^/?]+$/.test(input.path)
    || /^\/sell\/inventory\/v1\/offer(?:\/[^/?]+)?$/.test(input.path);
  const send = async <R>(next: EbayQuantityHttpRequest): Promise<R> => {
    const result = await request<R>(next);
    if (next.path.includes("bulk_update_price_quantity") && hasQuantity(next.body)) assertBulkSuccess(result, next.body);
    return result;
  };
  if (input.method === "DELETE" || input.path.includes("/withdraw") || (aggregateWrite && allQuantitiesZero(input.body))) {
    if (identity.startsWith("group:")) {
      const group = record(await request({ method: "GET", path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(identity.slice(6))}` }));
      const skus = exactSkus(group.variantSKUs);
      return admission.reducing(identity, async () => {
        const current = record(await request({ method: "GET", path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(identity.slice(6))}` }));
        if (JSON.stringify(exactSkus(current.variantSKUs)) !== JSON.stringify(skus)) throw invalid("Group membership changed before quantity reduction.");
        return send<T>(input);
      }, skus);
    }
    if (identity.startsWith("offer:")) {
      const offerId = input.path.match(/^\/sell\/inventory\/v1\/offer\/([^/]+)(?:\/withdraw)?$/)?.[1];
      if (!offerId) throw invalid("An exact offer identity is required before reducing a retained listing.");
      const offer = record(await request({ method: "GET", path: `/sell/inventory/v1/offer/${offerId}` }));
      return admission.reducing(exactSkus([offer.sku])[0], () => send<T>(input));
    }
    return admission.reducing(identity, () => send<T>(input));
  }
  if (identity.startsWith("group:")) {
    const groupKey = identity.slice("group:".length);
    const group = Array.isArray(body.variantSKUs) ? body : record(await request({
      method: "GET", path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
    }));
    const skus = exactSkus(group.variantSKUs);
    if (hasQuantity(input.body)) throw invalid("A group lifecycle request cannot carry unowned quantity fields.");
    return admission.group(groupKey, skus, async quantities => {
      if (!Array.isArray(body.variantSKUs)) {
        const current = record(await request({ method: "GET", path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}` }));
        if (JSON.stringify(exactSkus(current.variantSKUs)) !== JSON.stringify(skus)) throw invalid("Provider group membership changed before publication.");
      }
      if (quantities) for (const sku of skus) await refreshCanonicalEbayQuantity(sku, quantityFor(quantities, sku), marketplace(body), request);
      return request<T>(input);
    });
  }
  if (identity.startsWith("offer:")) {
    const match = input.path.match(/^\/sell\/inventory\/v1\/offer\/([^/]+)(?:\/publish)?$/);
    if (!match) throw invalid("The offer lifecycle does not have an exact provider offer identity.");
    const offer = record(await request({ method: "GET", path: `/sell/inventory/v1/offer/${match[1]}` }));
    const sku = exactSkus([offer.sku])[0];
    return admission.item(sku, async quantity => {
      if (quantity !== null) await refreshCanonicalEbayQuantity(sku, quantity, marketplace(offer), request);
      return send<T>({ ...input, body: quantity === null ? input.body : canonicalWriteBody(input, quantity) });
    });
  }
  return admission.item(identity, quantity => send<T>({ ...input,
    body: quantity === null ? input.body : canonicalWriteBody(input, quantity) }));
}

function canonicalWriteBody(input: EbayQuantityHttpRequest, quantity: number): unknown {
  const body = record(input.body);
  if (input.method === "PUT" && /^\/sell\/inventory\/v1\/inventory_item\/[^/?]+$/.test(input.path)) {
    const availability = record(body.availability);
    const { quantity: prior, ...locations } = record(availability.shipToLocationAvailability);
    if (hasQuantity(locations) || hasQuantity(availability.pickupAtLocationAvailability)) throw invalid("Per-location quantities require exact location allocation, not duplicated aggregate ATP.");
    return rewriteEbayCanonicalQuantities({ ...body, availability: { ...availability,
      shipToLocationAvailability: { ...record(availability.shipToLocationAvailability), quantity } } }, quantity);
  }
  if ((input.method === "POST" || input.method === "PUT") && /^\/sell\/inventory\/v1\/offer(?:\/[^/?]+)?$/.test(input.path)) {
    return rewriteEbayCanonicalQuantities({ ...body, availableQuantity: quantity }, quantity);
  }
  return rewriteEbayCanonicalQuantities(input.body, quantity);
}

function assertBulkSuccess(value: unknown, body: unknown): void {
  const rows = record(value).responses;
  const failed = (value: unknown): boolean => {
    const row = record(value);
    return typeof row.statusCode !== "number" || row.statusCode < 200 || row.statusCode >= 300
      || (Array.isArray(row.errors) && row.errors.length > 0)
      || (Array.isArray(row.offers) && row.offers.some(failed));
  };
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(failed)) throw invalid("The provider did not confirm every quantity mutation; no successful admission is recorded.");
  const requests = record(body).requests;
  if (!Array.isArray(requests) || requests.length !== 1) throw invalid("One exact SKU is required for a bulk quantity admission.");
  const requested = record(requests[0]);
  if (typeof requested.sku !== "string" || !Array.isArray(requested.offers)) throw invalid("Exact bulk request identity is missing.");
  for (const offered of requested.offers) {
    const offerId = record(offered).offerId;
    if (typeof offerId !== "string" || !rows.some(raw => {
      const row = record(raw);
      if (row.sku !== undefined && row.sku !== requested.sku) return false;
      return row.offerId === offerId || (row.sku === requested.sku && Array.isArray(row.offers)
        && row.offers.some(nested => record(nested).offerId === offerId));
    })) throw invalid("A requested offer quantity was not confirmed by the provider.");
  }
  if (requested.offers.length === 0 && !rows.some(raw => record(raw).sku === requested.sku)) {
    throw invalid("The requested inventory SKU quantity was not confirmed by the provider.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function exactSkus(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 250 || value.some(sku =>
    typeof sku !== "string" || !sku.trim() || sku.trim() !== sku || sku.length > 240)) throw invalid("Exact bounded provider member SKUs are required.");
  const skus = value as string[];
  if (new Set(skus).size !== skus.length) throw invalid("Provider group members are duplicated.");
  return [...skus].sort();
}
function marketplace(value: Record<string, unknown>): string {
  // Existing route/listing providers default to the US marketplace when omitted.
  const result = value.marketplaceId ?? "EBAY_US";
  if (typeof result !== "string" || !/^[A-Z_]{1,40}$/.test(result)) throw invalid("Provider marketplace identity is invalid.");
  return result;
}
function quantityFor(values: ReadonlyMap<string, number>, sku: string): number {
  const quantity = values.get(sku);
  if (quantity === undefined || !Number.isSafeInteger(quantity) || quantity < 0) throw invalid("Canonical group planning omitted a member quantity.");
  return quantity;
}
function allQuantitiesZero(value: unknown): boolean {
  const quantities: unknown[] = [];
  function visit(current: unknown): void {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!current || typeof current !== "object") return;
    for (const [field, nested] of Object.entries(current)) {
      if (field === "quantity" || field === "availableQuantity") quantities.push(nested);
      else visit(nested);
    }
  }
  visit(value);
  return quantities.length > 0 && quantities.every(quantity => quantity === 0);
}
async function refreshCanonicalEbayQuantity(sku: string, quantity: number, marketplaceId: string,
  request: <R>(input: EbayQuantityHttpRequest) => Promise<R>): Promise<void> {
  const inventory = record(await request({ method: "GET", path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}` }));
  if (Object.keys(inventory).length === 0) throw invalid("A retained listing member has no provider inventory item.");
  const availability = record(inventory.availability);
  const { quantity: retainedQuantity, ...shipLocations } = record(availability.shipToLocationAvailability);
  if (hasQuantity(shipLocations) || hasQuantity(availability.pickupAtLocationAvailability)) {
    throw invalid("Retained per-location or pickup quantities require an explicit canonical location mapping before publication.");
  }
  const response = record(await request({ method: "GET", path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}` }));
  if (!Array.isArray(response.offers) || response.offers.length > 250) throw invalid("Provider offer membership could not be verified before publication.");
  if (typeof response.total === "number" && response.total !== response.offers.length) throw invalid("Provider offers are paginated; complete membership is required.");
  const offers = response.offers.map(raw => {
    const offer = record(raw); const offerId = offer.offerId;
    if (typeof offerId !== "string" || !offerId || (offer.sku !== undefined && offer.sku !== sku)) throw invalid("Provider offer membership is inconsistent.");
    return { offerId, availableQuantity: quantity };
  });
  if (offers.length) {
    // The quantity endpoint avoids echoing read-only offer/listing metadata into a PUT.
    const updated = record(await request({ method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity",
      body: { requests: [{ sku, shipToLocationAvailability: { quantity }, offers }] } }));
    const results = Array.isArray(updated.responses) ? updated.responses.map(record) : [];
    const successful = (result: Record<string, unknown>) => typeof result.statusCode === "number"
      && result.statusCode >= 200 && result.statusCode < 300 && (!Array.isArray(result.errors) || result.errors.length === 0);
    if (results.length === 0 || results.some(result => !successful(result)) || offers.some(offer => !results.some(result =>
      result.offerId === offer.offerId || (result.sku === sku && Array.isArray(result.offers)
        && result.offers.some(raw => { const nested = record(raw); return nested.offerId === offer.offerId && successful(nested); }))))) {
      throw invalid("Provider did not confirm every retained offer quantity before publication.");
    }
  } else {
    // No retained offer exists yet. Replace only the inventory item's supported
    // aggregate quantity; unmodeled alternate pools were rejected above.
    const { sku: ignoredSku, ...item } = inventory;
    await request({ method: "PUT", path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, expectNoContent: true,
      body: rewriteEbayCanonicalQuantities({ ...item, availability: { ...availability,
        shipToLocationAvailability: { ...record(availability.shipToLocationAvailability), quantity } } }, quantity) });
  }
}
function invalid(message: string): QuantityPublicationAdmissionError {
  return new QuantityPublicationAdmissionError("PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN", message);
}
