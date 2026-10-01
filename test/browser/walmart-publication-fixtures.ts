import type { Route } from "@playwright/test";
import {
  listingCatalogItemSchema,
  listingDraftSchema,
  listingOperationSchema,
  listingReviewSchema,
  type ListingDraft,
  type ListingDraftItem,
  type ListingOperation,
  type ListingPriceRule,
  type ListingReview,
} from "../../shared/types/channel-listing-publication";

export const PUBLICATION_BASE = "/api/channels/77/listing-publications";
export const publicationCatalog = [1, 26].map((id) =>
  listingCatalogItemSchema.parse({
    variantId: id,
    productId: id,
    sku: `CARD-${id}`,
    name: id === 1 ? "Clear card sleeves" : "Standard toploaders",
    variantName: id === 1 ? "100 pack" : "25 pack",
    unitLabel: id === 1 ? "1 pack = 100 sleeves" : "1 pack = 25 toploaders",
    productType: "card-protection",
    title: "Trading card protection",
    description: "Protect your cards",
    brand: "Card Shellz",
    images: ["https://example.com/product.png"],
    identifier: { type: "UPC", value: "012345678905" },
    priceCents: 499,
    basePriceCents: 499,
    priceSource: "catalog_variant",
    appliedRule: null,
    appliedRuleScope: null,
    eligible: true,
    alreadyLinked: false,
    sourceHash: "a".repeat(64),
  }),
);

export interface PublicationMock {
  draft: ListingDraft;
  pricingRule: ListingPriceRule | null;
  operations: ListingOperation[];
  blockedReview: boolean;
  staleDraft: boolean;
  loseSubmissionResponse: boolean;
  submittedItems: ListingDraftItem[];
  writes: { path: string; body: unknown }[];
  reviews: ListingReview[];
  taxonomy: {
    productTypes: string[];
    entries?: { productType: string; path: string[]; description: string | null }[];
  };
  taxonomyError: boolean;
}
export function createPublicationMock(): PublicationMock {
  return {
    draft: listingDraftSchema.parse({
      channelId: 77,
      revision: 0,
      items: [],
      updatedAt: null,
    }),
    pricingRule: null,
    operations: [],
    submittedItems: [],
    blockedReview: false,
    staleDraft: false,
    loseSubmissionResponse: false,
    writes: [],
    reviews: [],
    taxonomy: {
      productTypes: ["Trading Card Accessories", "Trading Card Storage", "Office Folders"],
      // Synthetic categories exercise the picker; they are not Walmart assignments.
      entries: [
        { productType: "Trading Card Accessories", path: ["Collectibles", "Card Protection"], description: null },
        { productType: "Trading Card Storage", path: ["Collectibles", "Card Storage"], description: null },
        { productType: "Office Folders", path: ["Office", "Organization"], description: null },
      ],
    },
    taxonomyError: false,
  };
}

export async function handlePublicationRequest(
  route: Route,
  state: PublicationMock,
): Promise<boolean> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (!path.startsWith(PUBLICATION_BASE)) return false;
  const method = request.method();
  const reply = async (json: unknown, status = 200) => {
    await route.fulfill({ status, json });
    return true;
  };
  if (method === "GET") {
    if (path === PUBLICATION_BASE)
      return reply({
        draft: state.draft,
        pricingRule: state.pricingRule,
        operations: state.operations,
      });
    if (path.endsWith("/retry-items"))
      return reply({
        items: state.submittedItems.filter((item) =>
          state.operations.some(
            (operation) =>
              path.includes(operation.id) &&
              operation.items.some(
                (outcome) =>
                  outcome.variantId === item.variantId && outcome.canRetry,
              ),
          ),
        ),
      });
    if (path.endsWith("/catalog")) {
      const requested = url.searchParams
        .get("variantIds")
        ?.split(",")
        .map(Number);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = requested
        ? publicationCatalog.filter((item) =>
            requested.includes(item.variantId),
          )
        : [publicationCatalog[offset > 0 ? 1 : 0]];
      return reply({
        items,
        total: requested ? items.length : 26,
        offset,
        limit: 25,
      });
    }
    if (path.endsWith("/taxonomy"))
      return state.taxonomyError
        ? reply({ message: "Product types temporarily unavailable" }, 503)
        : reply(state.taxonomy);
    if (path.endsWith("/requirements"))
      return reply({
        productType: "Trading Card Accessories",
        method: url.searchParams.get("method") ?? "create",
        version: "5.0",
        schemaHash: "b".repeat(64),
        schema: {
          type: "object",
          required: ["Orderable", "Visible"],
          properties: {
            Orderable: {
              type: "object",
              title: "Shipping and offer details",
              required: ["shippingWeight"],
              properties: {
                shippingWeight: { type: "number", title: "Shipping weight" },
              },
            },
            Visible: {
              type: "object",
              title: "Product attributes",
              required: ["countryOfOrigin"],
              properties: {
                countryOfOrigin: {
                  type: "string",
                  title: "Country of origin",
                  enum: ["US", "CN"],
                },
              },
            },
          },
        },
      });
  }
  const input = request.postDataJSON() as Record<string, unknown>;
  state.writes.push({ path, body: input });
  if (method === "PUT" && path.endsWith("/draft")) {
    if (state.staleDraft || input.expectedRevision !== state.draft.revision)
      return reply(
        { message: "The draft changed. Reload its saved revision." },
        409,
      );
    state.draft = listingDraftSchema.parse({
      ...state.draft,
      revision: state.draft.revision + 1,
      items: input.items,
      updatedAt: new Date().toISOString(),
    });
    return reply(state.draft);
  }
  if (method === "PUT" && path.endsWith("/pricing")) {
    state.pricingRule = input as ListingPriceRule;
    return reply(input);
  }
  if (method === "POST" && path.endsWith("/review")) {
    const review = listingReviewSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        draftRevision: state.draft.revision,
        reviewHash: "c".repeat(64),
        account: {
          channelId: 77,
          connectionId: 9,
          provider: "walmart",
          market: "US",
          environment: "production",
          accountId: "10002558022",
          scopeId: "10002558022",
          revision: 1,
        },
        items: state.draft.items.map((item) => {
          const catalog = publicationCatalog.find(
            (candidate) => candidate.variantId === item.variantId,
          )!;
          return {
            variantId: item.variantId,
            productId: catalog.productId,
            sku: catalog.sku,
            title: item.title ?? catalog.title,
            unitLabel: catalog.unitLabel,
            method: item.method,
            productType: item.productType,
            priceCents: item.priceOverrideCents ?? catalog.priceCents,
            priceSource: "catalog_variant",
            issues: state.blockedReview
              ? [
                  {
                    code: "REQUIRED",
                    message: "Shipping weight is required",
                    field: "Orderable.shippingWeight",
                  },
                ]
              : [],
            schemaVersion: "5.0",
          };
        }),
        issues: [],
        canSubmit: !state.blockedReview,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        inventory: {
          ready: false,
          message:
            "Inventory setup required. Items will remain at zero stock until inventory is ready.",
          targetId: null,
        },
      });
    state.reviews.push(review);
    return reply(review);
  }
  if (method === "POST" && path.endsWith("/operations")) {
    if (state.draft.items.length === 0 && state.operations.length)
      return reply(state.operations[state.operations.length - 1]);
    const operation = listingOperationSchema.parse({
      id:
        state.operations.length === 0
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      channelId: 77,
      state: "processing",
      submissionId: "feed-1",
      items: state.draft.items.map((item) => ({
        variantId: item.variantId,
        sku: publicationCatalog.find(
          (candidate) => candidate.variantId === item.variantId,
        )!.sku,
        priceCents: item.priceOverrideCents ?? 499,
        state: "processing",
        externalProductId: null,
        error: null,
        stockState: "waiting_for_item",
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    });
    state.submittedItems.push(...state.draft.items);
    state.operations.push(operation);
    state.draft = {
      ...state.draft,
      revision: state.draft.revision + 1,
      items: [],
    };
    if (state.loseSubmissionResponse) {
      state.loseSubmissionResponse = false;
      return reply(
        {
          message:
            "Submission response interrupted. Retry with the same request.",
        },
        503,
      );
    }
    return reply(operation);
  }
  if (method === "POST" && path.endsWith("/reconcile")) {
    const operation = state.operations.find((item) => path.includes(item.id))!;
    operation.state = "completed";
    operation.items = operation.items.map((item) => ({
      ...item,
      state: "verified",
      stockState: "setup_required",
    }));
    return reply(operation);
  }
  return reply(
    { error: `Unexpected publication request: ${method} ${path}` },
    500,
  );
}

export function createMembershipMock() {
  return {
    included: false,
    revision: "2",
    blocked: false,
    writes: [] as { path: string; body: Record<string, unknown> }[],
  };
}

export async function handleMembershipRequest(
  route: Route,
  state: ReturnType<typeof createMembershipMock>,
): Promise<boolean> {
  const path = new URL(route.request().url()).pathname;
  if (!path.startsWith("/api/inventory-planning/admin/publication-membership/"))
    return false;
  const input = route.request().postDataJSON() as Record<string, unknown>;
  state.writes.push({ path, body: input });
  if (path.endsWith("/inspect"))
    await route.fulfill({
      json: {
        channelId: 77,
        channelConnectionId: 9,
        authority: "canonical",
        authorityRevision: "1",
        targets: state.blocked
          ? []
          : [
              {
                publicationTargetId: 200,
                revision: state.revision,
                mode: "explicit",
                state: "live",
                externalScopeId: "10002558022",
                sourceReady: true,
                variants: [
                  {
                    productVariantId: 1,
                    included: state.included,
                    mappingReady: true,
                    externalInventoryItemId: "CARD-1",
                    externalSku: "CARD-1",
                  },
                ],
              },
            ],
        blockers: state.blocked
          ? [
              {
                code: "TARGET_REQUIRED",
                message: "A Walmart inventory destination is required",
                action: "configure_inventory",
                productVariantId: null,
              },
            ]
          : [],
        ready: !state.blocked,
      },
    });
  else if (path.endsWith("/review"))
    await route.fulfill({
      json: {
        publicationTargetId: 200,
        targetRevision: state.revision,
        authorityRevision: "1",
        reviewHash: "f".repeat(64),
        ready: true,
        blockers: [],
        changes: [{ productVariantId: 1, before: state.included, after: true }],
        affectedProductIds: [1],
        quantities: [{ productVariantId: 1, desiredQuantity: "8" }],
      },
    });
  else if (path.endsWith("/apply")) {
    state.included = true;
    state.revision = "3";
    await route.fulfill({
      json: {
        publicationTargetId: 200,
        revision: "3",
        reviewHash: "f".repeat(64),
        changedProductVariantIds: [1],
        publicationRows: 1,
        appliedAt: new Date().toISOString(),
        appliedBy: "operator",
        alreadyApplied: false,
      },
    });
  } else
    await route.fulfill({
      status: 500,
      json: { error: "Unexpected inventory membership request" },
    });
  return true;
}
