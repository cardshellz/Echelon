import type { Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  listingUpdateContextSchema,
  listingUpdateViewSchema,
  listingUpdateVerificationSchema,
  reviewListingUpdateSchema,
  submitListingUpdateSchema,
  type ListingUpdateView,
} from "../../shared/types/channel-listing-update";
import { editorSchema } from "../../server/modules/channels/adapters/walmart/walmart-listing-schema";

export const UPDATE_BASE = "/api/channels/77/listing-updates";
const productType = "Trading Card Sleeves & Holders";
const maintenanceSchema = JSON.parse(
  readFileSync(
    resolve(
      "server/modules/channels/__tests__/fixtures/walmart-maintenance-sleeves.schema.json",
    ),
    "utf8",
  ),
);
export function createListingUpdateMock() {
  return {
    updates: [] as ListingUpdateView[],
    reviews: [] as ListingUpdateView[],
    writes: [] as { path: string; body: unknown }[],
    commands: [] as string[],
    loseSubmissionResponse: false,
    reportedProductType: productType,
    verificationError: false,
    verificationReads: [] as string[],
    lastSubmitted: {
      description: "A previous description",
      brand: "Shellz",
      images: ["https://example.com/front.jpg", "https://example.com/back.jpg"],
      attributes: {
        Orderable: { ShippingWeight: 2, country_of_origin_substantial_transformation: "China" },
        Visible: { pieceCount: 200, condition: "New", keyFeatures: ["Clear sleeves", "Archival material", "Pack of 100"] },
      },
    },
  };
}
export async function handleListingUpdateRequest(
  route: Route,
  state: ReturnType<typeof createListingUpdateMock>,
): Promise<boolean> {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname;
  if (!path.startsWith(UPDATE_BASE)) return false;
  if (request.method() === "GET") {
    if (path.endsWith("/verification")) {
      state.verificationReads.push(path);
      if (state.verificationError) {
        await route.fulfill({ status: 503, json: { error: "Walmart item check is unavailable" } });
        return true;
      }
      const update = state.updates.find((entry) => entry.id === path.split("/").at(-2))!;
      await route.fulfill({ json: listingUpdateVerificationSchema.parse({
        updateId: update.id,
        requestedProductType: update.productType,
        categoryMatches: update.productType === state.reportedProductType,
        current: {
          sku: update.sku, externalProductId: `WPID-${update.sku}`,
          identifier: { type: "GTIN", value: "00036000291452" },
          title: update.title, productType: state.reportedProductType,
          priceCents: 2499, lifecycleStatus: "ACTIVE", publishedStatus: "SYSTEM_PROBLEM",
        },
        checkedAt: "2026-10-06T18:30:00.000Z",
      }) });
      return true;
    }
    if (path === UPDATE_BASE) {
      await route.fulfill({ json: state.updates });
      return true;
    }
    if (path === `${UPDATE_BASE}/item`) {
      const sku = url.searchParams.get("sku")!;
      await route.fulfill({
        json: listingUpdateContextSchema.parse({
          current: {
            sku,
            externalProductId: `WPID-${sku}`,
            identifier: { type: "GTIN", value: "00036000291452" },
            title: "55PT Toploader Essentials Clear+ Easy Glide Combo Pack",
            productType: state.reportedProductType,
            priceCents: 2499,
            lifecycleStatus: "ACTIVE",
            publishedStatus: "SYSTEM_PROBLEM",
          },
          sourceHash: "a".repeat(64),
          suggestedProductType:
            state.reportedProductType === "default"
              ? productType
              : state.reportedProductType,
          lastSubmitted: state.lastSubmitted,
          updates: state.updates.filter((update) => update.sku === sku),
        }),
      });
      return true;
    }
    if (path === `${UPDATE_BASE}/requirements`) {
      await route.fulfill({
        json: editorSchema(maintenanceSchema, "MP_MAINTENANCE", productType),
      });
      return true;
    }
  }
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    state.writes.push({ path, body });
    if (path === `${UPDATE_BASE}/review`) {
      const input = reviewListingUpdateSchema.parse(body);
      const review = listingUpdateViewSchema.parse({
        id: `00000000-0000-4000-8000-${String(state.reviews.length + 1).padStart(12, "0")}`,
        sku: input.sku,
        title:
          input.changes.title ??
          "55PT Toploader Essentials Clear+ Easy Glide Combo Pack",
        state: "reviewed",
        reviewHash: "b".repeat(64),
        productType: input.productType,
        changes: input.changes,
        issues: [],
        submissionId: null,
        message: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
      state.reviews.push(review);
      await route.fulfill({ json: review });
      return true;
    }
    const id = path.split("/").at(-2);
    if (path.endsWith("/submit")) {
      const command = submitListingUpdateSchema.parse(body);
      state.commands.push(command.commandKey);
      const existing = state.updates.find((update) => update.id === id);
      const update: ListingUpdateView = existing ?? {
        ...state.reviews.find((review) => review.id === id)!,
        state: "processing",
        submissionId: "update-feed@US",
        message: "Walmart is processing these changes.",
      };
      if (!existing) state.updates.push(update);
      if (state.loseSubmissionResponse) {
        state.loseSubmissionResponse = false;
        await route.fulfill({
          status: 503,
          json: { error: "Connection interrupted. Try again." },
        });
        return true;
      }
      await route.fulfill({ json: update });
      return true;
    }
    if (path.endsWith("/status")) {
      const update = state.updates.find((update) => update.id === id)!;
      update.state = "accepted";
      update.message =
        "Walmart processed this feed. Check the item on Walmart to verify its category and listing status.";
      await route.fulfill({ json: update });
      return true;
    }
  }
  await route.fulfill({
    status: 500,
    json: { error: "Unexpected listing update request" },
  });
  return true;
}
