import type { Route } from "@playwright/test";
import {
  listingCatalogItemSchema,
  listingDraftSchema,
  listingOperationSchema,
  listingReviewSchema,
  reviewListingDraftSchema,
  type ListingDraft,
  type ListingCatalogItem,
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
  catalogItems: ListingCatalogItem[];
  pricingRule: ListingPriceRule | null;
  operations: ListingOperation[];
  blockedReview: boolean;
  reviewIncludesUnselected: boolean;
  staleDraft: boolean;
  loseSubmissionResponse: boolean;
  submittedItems: ListingDraftItem[];
  writes: { path: string; body: unknown }[];
  reviews: ListingReview[];
  reviewedItems: Record<string, ListingDraftItem[]>;
  submissionCommands: Record<string, { body: string; operationId: string }>;
  taxonomy: {
    productTypes: string[];
    entries?: { productType: string; path: string[]; description: string | null }[];
  };
  taxonomyError: boolean;
  requirementsSchema: Record<string, unknown> | null;
  requirementsError: boolean;
}
export function createPublicationMock(): PublicationMock {
  return {
    catalogItems: structuredClone(publicationCatalog),
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
    reviewIncludesUnselected: false,
    staleDraft: false,
    loseSubmissionResponse: false,
    writes: [],
    reviews: [],
    reviewedItems: {},
    submissionCommands: {},
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
    requirementsSchema: null,
    requirementsError: false,
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
        ? state.catalogItems.filter((item) =>
            requested.includes(item.variantId),
          )
        : [state.catalogItems[offset > 0 ? 1 : 0]];
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
      return state.requirementsError ? reply({ message: "Requirements temporarily unavailable" }, 503) : reply({
        productType: url.searchParams.get("productType") ?? "",
        method: url.searchParams.get("method") ?? "create",
        version: "5.0",
        schemaHash: "b".repeat(64),
        schema: state.requirementsSchema ?? {
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
    const command = reviewListingDraftSchema.safeParse(input);
    if (!command.success) return reply({ message: command.error.message }, 400);
    if (command.data.expectedRevision !== state.draft.revision)
      return reply({ message: "The draft changed. Reload its saved revision." }, 409);
    const requested = command.data.variantIds ?? state.draft.items.map(item => item.variantId);
    if (!requested.length) return reply({ message: "Select draft variants before reviewing." }, 400);
    const selectedItems = state.draft.items.filter(item => requested.includes(item.variantId));
    if (selectedItems.length !== requested.length)
      return reply({ message: "A selected variant is no longer in the saved draft." }, 409);
    const review = listingReviewSchema.parse({
        id: `11111111-1111-4111-8111-${String(state.reviews.length + 1).padStart(12, "0")}`,
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
        items: (state.reviewIncludesUnselected ? state.draft.items : selectedItems).map((item) => {
          const catalog = state.catalogItems.find(
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
    state.reviewedItems[review.id] = structuredClone(selectedItems);
    return reply(review);
  }
  if (method === "POST" && path.endsWith("/operations")) {
    const commandKey = typeof input.commandKey === "string" ? input.commandKey : "";
    const replay = state.submissionCommands[commandKey];
    if (replay) {
      if (replay.body !== JSON.stringify(input))
        return reply({ message: "The submission command changed." }, 409);
      return reply(state.operations.find(operation => operation.id === replay.operationId));
    }
    const review = state.reviews.find(candidate => candidate.id === input.reviewId);
    if (!commandKey || !review || review.reviewHash !== input.reviewHash ||
      review.draftRevision !== state.draft.revision || !review.canSubmit)
      return reply({ message: "Create a current successful review before publishing." }, 409);
    const reviewedItems = state.reviewedItems[review.id];
    const reviewedIds = new Set(reviewedItems.map(item => item.variantId));
    const operation = listingOperationSchema.parse({
      id:
        state.operations.length === 0
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      channelId: 77,
      state: "processing",
      submissionId: "feed-1",
      items: reviewedItems.map((item) => ({
        variantId: item.variantId,
        sku: state.catalogItems.find(
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
    state.submittedItems.push(...structuredClone(reviewedItems));
    state.operations.push(operation);
    state.submissionCommands[commandKey] = { body: JSON.stringify(input), operationId: operation.id };
    state.draft = {
      ...state.draft,
      revision: state.draft.revision + 1,
      items: state.draft.items.filter(item => !reviewedIds.has(item.variantId)),
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
