import { vi } from "vitest";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { EbayPublicationCompletionExecution, type PreparedEbayPublication } from "../../ebay-publication-completion.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type { EbayListingExecutionContext } from "../../ebay-listing-sync.service";
import { resolveEbayPublicationTarget } from "../../ebay-publication-completion.domain";
import { syncIdentity, syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

export async function publicationCompletionFixture(automaticRecovery?: ConstructorParameters<typeof EbayPublicationCompletionExecution>[4], options: { missing?: boolean; source?: EbayListingSyncIdentity } = {}) {
  const base = syncProviderFixture();
  let published = false; let visible = true; let offerExists = !options.missing;
  let readResponse: { status: number; body: unknown; requestId?: string } | null = null;
  const source: EbayListingSyncIdentity = { ...(options.source ?? syncIdentity), groupKey: null,
    variants: (options.source ?? syncIdentity).variants.map(member => ({ ...member, offerId: options.missing ? null : member.offerId, externalSku: null, listingId: null, mappingExists: true })) };
  const getOffers = base.client.getOffers;
  base.client.getOffers = vi.fn(async (sku, marketplaceId) => ({ offers: !offerExists ? [] : (await getOffers(sku, marketplaceId)).offers.map(offer => ({ ...offer,
    status: published && visible ? "PUBLISHED" : "UNPUBLISHED", listingId: published && visible ? "listing-20" : undefined })) }));
  vi.mocked(base.client.publishOffer).mockImplementation(async () => { published = true; return { listingId: "listing-20" }; });
  vi.mocked(base.client.createOffer).mockImplementation(async () => { offerExists = true; return "offer-101"; });
  const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) }, {
    get: async request => {
      const url = new URL(request.path, "https://example.invalid");
      if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: source.accountId } };
      if (url.pathname.includes("/inventory_item/")) return { status: 200, body: { sku: "P5", groupIds: [] } };
      if (readResponse) return readResponse;
      if (!offerExists) return { status: 404, body: { errors: [{ errorId: 25713, message: "This Offer is not available." }] } };
      const offers = (await base.client.getOffers("P5", "EBAY_US")).offers.map(offer => ({ ...offer,
        ...(offer.status === "PUBLISHED" ? { listing: { listingId: "listing-20", listingStatus: "ACTIVE" } } : {}) }));
      return { status: 200, body: { offers, total: offers.length } };
    },
  }, { now: () => new Date("2026-10-11T20:00:00Z") });
  const observationInput = { owner: { kind: "channel" as const, channelId: source.channelId, productId: source.productId, provider: "ebay", marketplaceId: "EBAY_US" },
    memberCandidates: [{ productVariantId: 101, sku: "P5", isActive: true, availableQuantity: 7 }], unpublishedGroupKey: null };
  const inspect = () => observer.inspectExistingPublication(observationInput);
  const original = await base.prepare();
  const assertInventoryReady = vi.fn(async () => {});
  const prepare = vi.fn(async (): Promise<PreparedEbayPublication> => {
    const inspection = await inspect();
    return { ...original, assertInventoryReady, sourceIdentity: source, identity: resolveEbayPublicationTarget(source, inspection), inspection, inspect,
      draft: { ...original.draft, itemGroup: null, publishMode: "publish", hasExistingExternalIds: false,
        existingOfferIdsByVariantId: options.missing ? {} : { 101: "offer-101" } },
      resolvePublishedIdentity: async () => (await inspect()).publication!,
    };
  });
  const recovery = { reconcile: vi.fn(async (): Promise<{ busy: boolean; resolved: string[]; unresolved: string[] }> => ({ busy: false, resolved: [], unresolved: [] })) };
  const context: EbayListingExecutionContext = { operation: "publish", publicationTarget: null, publicationAccepted: null,
    publicationWriteStarted: false, publicationAcceptedRevision: null, claimedRevision: "1", publicationIntentHash: null,
    publicationWriteCompleted: false, bindPublicationTarget: vi.fn(async value => { context.publicationTarget = value; }),
    bindPublicationAccepted: vi.fn(async value => { context.publicationAccepted = value; }) };
  const bind = vi.fn(); const compatibility = vi.fn(); const stages: string[] = [];
  const stage = vi.fn(async (key: string, _hash: string, work: () => Promise<void>) => {
    stages.push(`start:${key}`); if (key === "publish") context.publicationWriteStarted = true;
    await work(); stages.push(`done:${key}`);
    if (key === "publish") context.publicationWriteCompleted = true;
  });
  const executor = new EbayPublicationCompletionExecution(prepare, recovery, new EbayMarketplaceListingConnector(), compatibility, automaticRecovery);
  return { ...base, source, prepare, recovery, context, bind, compatibility, stages, stage, executor, assertInventoryReady,
    run: () => executor.execute(source, stage, null, bind, context),
    setReadResponse: (value: typeof readResponse) => { readResponse = value; },
    setVisibility: (value: boolean) => { visible = value; }, setPublished: () => { published = true; } };
}
