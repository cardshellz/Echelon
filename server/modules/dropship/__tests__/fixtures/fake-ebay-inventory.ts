/**
 * A stateful fake of the eBay Sell Inventory API, for end-to-end tests that run
 * the real Dropship push provider, the shared connector, the inventory admission
 * and the outbox adapter against it (plan F2 9.3). It keeps inventory items
 * (sku -> body) and offers (id -> body + status + listingId), answers like eBay
 * for the endpoints those owners call, and records every call in order.
 * Nothing here decides a quantity: it stores what it is sent.
 */
export interface FakeEbayCall {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeEbayOffer {
  offerId: string;
  sku: string;
  marketplaceId: string;
  format: string;
  status: "PUBLISHED" | "UNPUBLISHED";
  availableQuantity: number;
  listingId?: string;
  [field: string]: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const notFound = (errorId: number, message: string) => json({ errors: [{ errorId, category: "REQUEST", message }] }, 404);

export class FakeEbayInventory {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly offers = new Map<string, FakeEbayOffer>();
  /** Inventory item groups (key -> group body with variantSKUs), for multi-variation listings. */
  readonly groups = new Map<string, Record<string, unknown>>();
  readonly calls: FakeEbayCall[] = [];
  /** Runs before a call is answered (after it is recorded); tests use it to interleave other work. */
  beforeRequest?: (call: FakeEbayCall) => Promise<void>;
  private offerSequence = 0;
  private listingSequence = 0;

  constructor(private readonly prefix = "fake") {}

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) as unknown : undefined;
    const call = { method, path: `${parsed.pathname}${parsed.search}`, body };
    this.calls.push(call);
    if (this.beforeRequest) await this.beforeRequest(call);
    return this.answer(method, parsed, body);
  };

  /** A PUBLISHED offer already on eBay for a SKU (a pre-existing listing). */
  seedOffer(offer: Partial<FakeEbayOffer> & { sku: string }): FakeEbayOffer {
    const offerId = offer.offerId ?? this.nextOfferId();
    const seeded: FakeEbayOffer = { offerId, marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "PUBLISHED",
      availableQuantity: 0, listingId: offer.status === "UNPUBLISHED" ? undefined : this.nextListingId(), ...offer };
    this.offers.set(offerId, seeded);
    if (!this.items.has(offer.sku)) this.items.set(offer.sku, { sku: offer.sku, availability: { shipToLocationAvailability: { quantity: seeded.availableQuantity } } });
    return seeded;
  }

  /** Inventory-item or offer writes (PUT/POST), the calls a refused stock link must never reach. */
  inventoryOrOfferMutations(): FakeEbayCall[] {
    return this.calls.filter(call => call.method !== "GET" && /^\/sell\/inventory\/v1\/(inventory_item|offer)/.test(call.path));
  }

  bulkQuantityUpdates(): FakeEbayCall[] {
    return this.calls.filter(call => call.path === "/sell/inventory/v1/bulk_update_price_quantity");
  }

  offersForSku(sku: string): FakeEbayOffer[] {
    return [...this.offers.values()].filter(offer => offer.sku === sku);
  }

  /** An offer as eBay sends it: a published offer carries `listing: { listingId, listingStatus }`, not a top-level listingId. */
  private wire(offer: FakeEbayOffer): Record<string, unknown> {
    const { listingId, ...rest } = structuredClone(offer);
    return offer.status === "PUBLISHED" && listingId ? { ...rest, listing: { listingId, listingStatus: "ACTIVE" } } : rest;
  }

  private nextOfferId(): string { this.offerSequence += 1; return `${this.prefix}-offer-${this.offerSequence}`; }
  private nextListingId(): string { this.listingSequence += 1; return `${this.prefix}-listing-${this.listingSequence}`; }

  private answer(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    const inventory = path.match(/^\/sell\/inventory\/v1\/inventory_item\/([^/]+)$/);
    if (inventory) {
      const sku = decodeURIComponent(inventory[1]!);
      if (method === "GET") {
        const item = this.items.get(sku);
        return item ? json({ ...structuredClone(item), sku }) : notFound(25702, `SKU ${sku} is not available.`);
      }
      if (method === "PUT") {
        this.items.set(sku, { ...structuredClone(body as Record<string, unknown>), sku });
        return new Response(null, { status: 204 });
      }
    }
    const group = path.match(/^\/sell\/inventory\/v1\/inventory_item_group\/([^/]+)$/);
    if (group && method === "GET") {
      const key = decodeURIComponent(group[1]!);
      const found = this.groups.get(key);
      return found ? json({ ...structuredClone(found), inventoryItemGroupKey: key }) : notFound(25705, `Group ${key} is not available.`);
    }
    if (path === "/sell/inventory/v1/offer" && method === "GET") {
      const sku = url.searchParams.get("sku");
      const marketplaceId = url.searchParams.get("marketplace_id");
      const all = [...this.offers.values()].filter(offer => offer.sku === sku && (!marketplaceId || offer.marketplaceId === marketplaceId));
      // eBay answers 404 (25713 "This Offer is not available") for a SKU with no offer.
      if (all.length === 0) return notFound(25713, "This Offer is not available.");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json({ total: all.length, offers: all.slice(offset, offset + limit).map(offer => this.wire(offer)) });
    }
    if (path === "/sell/inventory/v1/offer" && method === "POST") {
      const draft = body as Record<string, unknown>;
      const offerId = this.nextOfferId();
      this.offers.set(offerId, { ...structuredClone(draft), offerId, sku: String(draft.sku), marketplaceId: String(draft.marketplaceId),
        format: String(draft.format), status: "UNPUBLISHED", availableQuantity: Number(draft.availableQuantity ?? 0) });
      return json({ offerId }, 201);
    }
    const offerPath = path.match(/^\/sell\/inventory\/v1\/offer\/([^/]+)(\/publish)?$/);
    if (offerPath) {
      const offer = this.offers.get(decodeURIComponent(offerPath[1]!));
      if (!offer) return notFound(25713, "This Offer is not available.");
      if (offerPath[2] && method === "POST") {
        offer.status = "PUBLISHED";
        offer.listingId ??= this.nextListingId();
        return json({ listingId: offer.listingId });
      }
      if (method === "GET") return json(this.wire(offer));
      if (method === "PUT") {
        const update = body as Record<string, unknown>;
        Object.assign(offer, structuredClone(update), { offerId: offer.offerId, status: offer.status, listingId: offer.listingId,
          availableQuantity: Number(update.availableQuantity ?? offer.availableQuantity) });
        return new Response(null, { status: 204 });
      }
    }
    if (path === "/sell/inventory/v1/bulk_update_price_quantity" && method === "POST") {
      const requests = (body as { requests: Array<{ sku: string; shipToLocationAvailability?: { quantity: number };
        offers?: Array<{ offerId: string; availableQuantity: number }> }> }).requests;
      const responses: unknown[] = [];
      for (const request of requests) {
        const item = this.items.get(request.sku);
        if (item && request.shipToLocationAvailability) {
          item.availability = { shipToLocationAvailability: { quantity: request.shipToLocationAvailability.quantity } };
        }
        for (const target of request.offers ?? []) {
          const offer = this.offers.get(target.offerId);
          if (offer) offer.availableQuantity = target.availableQuantity;
          responses.push({ sku: request.sku, offerId: target.offerId, statusCode: 200 });
        }
        if (!request.offers?.length) responses.push({ sku: request.sku, statusCode: 200 });
      }
      return json({ responses });
    }
    return json({ errors: [{ errorId: 2003, category: "APPLICATION", message: `Fake eBay has no route for ${method} ${path}.` }] }, 500);
  }
}
