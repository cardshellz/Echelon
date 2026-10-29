import type {
  EbayBulkPriceQuantityRequest,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../../adapters/ebay/ebay-types";
import { executeEbayQuantityHttp } from "../../adapters/ebay/ebay-quantity-http";
import { EbayApiRequestError } from "../../adapters/ebay/ebay-api-error";
import type { EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import type { EbayQuantityHttpRequest } from "../../quantity-publication-request";

export const automaticSyncPhotos = [
  "https://example.test/current-front.jpg",
  "https://example.test/current-back.jpg",
] as const;
export const automaticSyncOldPhotos = ["https://example.test/old.jpg"];

/** Stateful provider double. A lost response does not cancel the remote write:
 * tests explicitly deliver it later, after a newer request has completed. Every
 * ordinary request still crosses production HTTP classification/evidence code. */
export class AutomaticSyncEbayProvider {
  readonly writes: EbayQuantityHttpRequest[] = [];
  readonly lateWrites: EbayQuantityHttpRequest[] = [];
  private fault: { path: string; applyBeforeFailure: boolean; publicationOnly?: boolean } | null = null;
  private failPublicationPreflight: { read: "offer" | "group"; sku?: string } | null = null;
  private publicationGroupPrepared = false;
  private groupExists = true;
  private groupAttached = true;
  private nextReadFailure: { path: string; status: number } | null = null;
  private nextWriteRejection: { path: string; message: string } | null = null;
  private heldPreflightRead: { entered: () => void; gate: Promise<void> } | null = null;
  private held: { path: string; entered: () => void; gate: Promise<void> } | null = null;
  private readonly members = new Map<string, { item: EbayInventoryItem; offer: EbayObservedOffer }>();
  private group: EbayInventoryItemGroup = {
    title: "Old title", description: "Description", aspects: { Brand: ["Shellz"] },
    imageUrls: [...automaticSyncOldPhotos], variantSKUs: ["P5"],
    variesBy: { specifications: [{ name: "Pack Size", values: ["5"] }] },
  };

  constructor(private readonly clock: () => Date, private readonly publicationEnabled = false, skus: readonly string[] = ["P5"],
    private readonly listingShape: "group" | "single" = "group") {
    if (listingShape === "single" && skus.length !== 1) throw new Error("A single-listing provider fixture requires exactly one SKU.");
    for (const sku of skus) {
      if (!sku || this.members.has(sku)) throw new Error("Provider fixture requires distinct nonempty SKUs.");
      this.members.set(sku, {
        item: { sku, condition: "NEW",
          product: { title: "Old title", description: "Description", imageUrls: [...automaticSyncOldPhotos] },
          availability: { shipToLocationAvailability: { quantity: 999 } } },
        offer: { sku, offerId: `offer-${sku}`, listingId: publicationEnabled ? undefined : "listing-20",
          status: publicationEnabled ? "UNPUBLISHED" : "PUBLISHED", marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 999,
          categoryId: "183454", merchantLocationKey: "main",
          listingPolicies: { fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" },
          pricingSummary: { price: { value: "9.99", currency: "USD" } } },
      });
    }
    this.group.variantSKUs = [...skus];
  }

  failNextPublicationPreflight(read: "offer" | "group" = "offer", sku?: string): void { this.failPublicationPreflight = { read, sku }; }

  detachUnpublishedGroup(existingSkus: readonly string[] | null = null): void {
    if (!this.publicationEnabled || [...this.members.values()].some(member => member.offer.status !== "UNPUBLISHED"))
      throw new Error("Only unpublished fixture resources can be detached.");
    this.groupAttached = false;
    this.groupExists = existingSkus !== null;
    if (existingSkus !== null) this.group.variantSKUs = [...existingSkus];
  }

  failNextRead(path: string, status = 503): void { this.nextReadFailure = { path, status }; }

  rejectNextWrite(path: string, message: string): void {
    if (this.nextWriteRejection) throw new Error("Only one provider rejection may be armed at a time.");
    this.nextWriteRejection = { path, message };
  }

  holdNextPublicationPreflightRead(): { entered: Promise<void>; release(): void } {
    if (this.heldPreflightRead) throw new Error("Only one publication read may be held at a time.");
    let entered!: () => void;
    let release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.heldPreflightRead = { entered, gate };
    return { entered: observed, release };
  }

  snapshot(sku = "P5") {
    return structuredClone({ ...this.member(sku), group: this.group });
  }

  loseNextResponse(path: string, applyBeforeFailure = false): void {
    if (this.fault) throw new Error("Only one provider failure may be armed at a time.");
    this.fault = { path, applyBeforeFailure };
  }

  loseNextPublicationStockResponse(): void {
    if (this.fault) throw new Error("Only one provider failure may be armed at a time.");
    this.fault = { path: "/sell/inventory/v1/bulk_update_price_quantity", applyBeforeFailure: false, publicationOnly: true };
  }

  holdNextWrite(path: string): { entered: Promise<void>; release(): void } {
    if (this.held) throw new Error("Only one provider write may be held at a time.");
    let entered!: () => void;
    let release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.held = { path, entered, gate };
    return { entered: observed, release };
  }

  deliverLateWrites(): void {
    for (const request of this.lateWrites.splice(0)) this.apply(request);
  }

  async request<T>(input: EbayQuantityHttpRequest): Promise<T> {
    const request = structuredClone(input);
    return executeEbayQuantityHttp<T>({
      url: `https://example.test${request.path}`, path: request.path,
      method: request.method, body: request.body, headers: {}, now: this.clock,
      // Production read requests preserve the API's HTTP error contract;
      // mutations retain the quantity transport's uncertainty classification.
      onFailure: request.method === "GET" ? async (status, body) => {
        throw new EbayApiRequestError(status, `eBay API GET ${request.path} failed (${status}): ${body}`, body);
      } : undefined,
      request: async () => {
        if (request.method === "GET" && this.nextReadFailure?.path === request.path) {
          const failure = this.nextReadFailure; this.nextReadFailure = null;
          return new Response(JSON.stringify({ errors: [{ errorId: 25001, message: "Injected read failure" }] }), { status: failure.status });
        }
        if (request.method === "GET" && request.path === "/sell/inventory/v1/inventory_item_group/PACK" && !this.groupExists)
          return new Response(JSON.stringify({ errors: [{ errorId: 25705, message: "Inventory item group not found" }] }), { status: 404 });
        if (request.method === "GET" && this.heldPreflightRead && this.publicationGroupPrepared
          && request.path === "/sell/inventory/v1/inventory_item_group/PACK") {
          const held = this.heldPreflightRead;
          this.heldPreflightRead = null;
          held.entered();
          await held.gate;
        }
        if (request.method === "GET" && this.failPublicationPreflight && this.publicationGroupPrepared
          && (this.failPublicationPreflight.read === "offer" ? request.path.startsWith("/sell/inventory/v1/offer?")
            && (!this.failPublicationPreflight.sku || new URL(request.path, "https://example.test").searchParams.get("sku") === this.failPublicationPreflight.sku)
            : request.path === "/sell/inventory/v1/inventory_item_group/PACK")) {
          this.failPublicationPreflight = null;
          return new Response(JSON.stringify({ errors: [{ errorId: 25001, domain: "API_INVENTORY", category: "System", message: "Injected provider lookup failure" }] }), { status: 500 });
        }
        if (request.method === "GET") return this.response(this.read(request.path));
        this.writes.push(request);
        if (this.nextWriteRejection?.path === request.path) {
          const rejection = this.nextWriteRejection;
          this.nextWriteRejection = null;
          return new Response(JSON.stringify({ errors: [{ errorId: 25002, category: "REQUEST", message: rejection.message }] }), { status: 400 });
        }
        if (this.held?.path === request.path) {
          const held = this.held;
          this.held = null;
          held.entered();
          await held.gate;
        }
        if (this.fault?.path === request.path && (!this.fault.publicationOnly || this.publicationGroupPrepared)) {
          const fault = this.fault;
          this.fault = null;
          if (fault.applyBeforeFailure) this.apply(request);
          else this.lateWrites.push(request);
          throw Object.assign(new Error("Injected response loss; provider may still apply this write."), { code: "ECONNRESET" });
        }
        const body = this.apply(request);
        return body === undefined ? new Response(null, { status: 204 }) : this.response(body);
      },
    });
  }

  private response(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  private read(path: string): unknown {
    const url = new URL(path, "https://example.test");
    if (url.pathname === "/commerce/identity/v1/user/") return { userId: "seller-36" };
    const sku = url.pathname.match(/^\/sell\/inventory\/v1\/inventory_item\/([^/]+)$/)?.[1];
    if (sku) return { ...structuredClone(this.member(decodeURIComponent(sku)).item), groupIds: this.listingShape === "group" && this.groupAttached ? ["PACK"] : [] };
    if (url.pathname === "/sell/inventory/v1/inventory_item_group/PACK") return structuredClone(this.group);
    const offer = [...this.members.values()].find(member => url.pathname === `/sell/inventory/v1/offer/${member.offer.offerId}`)?.offer;
    if (offer) return structuredClone(offer);
    if (url.pathname === "/sell/inventory/v1/offer" && url.searchParams.has("sku")) {
      const current = this.member(url.searchParams.get("sku")!).offer;
      return { offers: [{ ...structuredClone(current), ...(current.status === "PUBLISHED"
        ? { listing: { listingId: current.listingId, listingStatus: "ACTIVE" } } : {}) }], total: 1 };
    }
    throw new Error(`Unexpected fake eBay GET ${path}`);
  }

  private apply(request: EbayQuantityHttpRequest): unknown {
    const sku = request.path.match(/^\/sell\/inventory\/v1\/inventory_item\/([^/]+)$/)?.[1];
    if (request.method === "PUT" && sku) {
      const decoded = decodeURIComponent(sku);
      this.member(decoded).item = { ...structuredClone(request.body as EbayInventoryItem), sku: decoded };
      return;
    }
    const member = [...this.members.values()].find(candidate => request.path === `/sell/inventory/v1/offer/${candidate.offer.offerId}`);
    if (request.method === "PUT" && member) {
      member.offer = { ...structuredClone(request.body as EbayOffer), offerId: member.offer.offerId, listingId: member.offer.listingId, status: member.offer.status };
      return;
    }
    if (request.method === "PUT" && request.path === "/sell/inventory/v1/inventory_item_group/PACK") {
      const { inventoryItemGroupKey: _requestIdentity, ...body } = structuredClone(request.body as EbayInventoryItemGroup);
      this.group = body;
      this.groupExists = true;
      this.groupAttached = true;
      this.publicationGroupPrepared = true;
      return;
    }
    if (request.method === "POST" && request.path === "/sell/inventory/v1/bulk_update_price_quantity") {
      const body = request.body as EbayBulkPriceQuantityRequest;
      return { responses: body.requests.map(row => {
        const current = this.member(row.sku);
        if (row.shipToLocationAvailability?.quantity !== undefined) {
          current.item.availability.shipToLocationAvailability.quantity = row.shipToLocationAvailability.quantity;
        }
        return { sku: row.sku, statusCode: 200, offers: (row.offers ?? []).map(offer => {
          if (offer.offerId !== current.offer.offerId) throw new Error("Unexpected fake eBay offer.");
          if (offer.availableQuantity !== undefined) current.offer.availableQuantity = offer.availableQuantity;
          return { offerId: offer.offerId, statusCode: 200 };
        }) };
      }) };
    }
    if (this.publicationEnabled && this.listingShape === "group" && request.method === "POST" && request.path === "/sell/inventory/v1/offer/publish_by_inventory_item_group") {
      for (const current of this.members.values()) current.offer = { ...current.offer, status: "PUBLISHED", listingId: "listing-20" };
      return { listingId: "listing-20" };
    }
    if (this.publicationEnabled && this.listingShape === "single" && request.method === "POST") {
      const target = [...this.members.values()].find(current => request.path === `/sell/inventory/v1/offer/${current.offer.offerId}/publish`);
      if (target) {
        target.offer = { ...target.offer, status: "PUBLISHED", listingId: "listing-20" };
        return { listingId: "listing-20" };
      }
    }
    // Any accidental create/publish/delete in existing-listing recovery fails
    // the test instead of quietly manufacturing another listing.
    throw new Error(`Unexpected fake eBay mutation ${request.method} ${request.path}`);
  }

  private member(sku: string): { item: EbayInventoryItem; offer: EbayObservedOffer } {
    const member = this.members.get(sku);
    if (!member) throw new Error(`Unexpected fake eBay SKU ${sku}.`);
    return member;
  }
}
