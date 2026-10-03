import { createHash } from "node:crypto";
import { z } from "zod";
import {
  listingAccountSchema,
  listingCatalogItemSchema,
  listingDraftSchema,
  listingDraftItemSchema,
  listingIssueSchema,
  listingOperationItemSchema,
  listingReviewSchema,
  type ListingAccount,
  type ListingIssue,
  type ListingDraftItem,
  type ListingOperation,
} from "@shared/types/channel-listing-publication";

export class ListingPublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ListingPublicationError";
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new ListingPublicationError(
        "LISTING_HASH_INPUT_INVALID",
        "Listing evidence contains an invalid value",
      );
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
export function listingHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function listingAccountKey(account: ListingAccount): string {
  return canonical([
    account.provider,
    account.market,
    account.environment,
    account.accountId,
  ]);
}
export function listingIssue(
  code: string,
  message: string,
  field: string | null = null,
): ListingIssue {
  return { code, message, field };
}
export const preparedListingItemSchema = z.object({
  variantId: z.number().int().positive(),
  sku: z.string().min(1).max(100),
  feedType: z.string().min(1),
  schemaVersion: z.string().min(1),
  schemaHash: z.union([z.literal(""), z.string().length(64)]),
  payload: z.record(z.unknown()),
  issues: z.array(listingIssueSchema),
});
export const listingSnapshotSchema = z.object({
  review: listingReviewSchema,
  account: listingAccountSchema,
  draft: listingDraftSchema,
  catalog: z.array(listingCatalogItemSchema),
  prepared: z.array(preparedListingItemSchema),
});
export type ListingSnapshot = z.infer<typeof listingSnapshotSchema>;

/** Validate the exact saved selection before retaining every unreviewed draft item. */
export function remainingDraftAfterReview(
  currentItems: unknown,
  snapshot: ListingSnapshot,
): ListingDraftItem[] {
  const current = z.array(listingDraftItemSchema).max(100).parse(currentItems);
  const selected = snapshot.draft.items;
  const ids = new Set(selected.map((item) => item.variantId));
  const sameIds = (items: readonly { variantId: number }[]) =>
    items.length === ids.size &&
    new Set(items.map((item) => item.variantId)).size === ids.size &&
    items.every((item) => ids.has(item.variantId));
  const currentById = new Map(current.map((item) => [item.variantId, item]));
  const selectedItemsChanged = selected.some((item) => {
    const saved = currentById.get(item.variantId);
    return !saved || listingHash(saved) !== listingHash(item);
  });
  const preparedIds = new Set(snapshot.prepared.map((item) => item.variantId));
  const preparedScopeInvalid =
    preparedIds.size !== snapshot.prepared.length ||
    snapshot.prepared.some((item) => !ids.has(item.variantId)) ||
    (snapshot.review.canSubmit && !sameIds(snapshot.prepared));
  if (
    !ids.size ||
    ids.size !== selected.length ||
    currentById.size !== current.length ||
    !sameIds(snapshot.review.items) ||
    !sameIds(snapshot.catalog) ||
    preparedScopeInvalid ||
    selectedItemsChanged
  )
    throw new ListingPublicationError(
      "LISTING_REVIEW_STALE",
      "The reviewed selection no longer matches the saved draft. Review the items again.",
    );
  return current.filter((item) => !ids.has(item.variantId));
}
export const listingBatchSchema = z.object({
  key: z.string(),
  correlationId: z.string().uuid(),
  variantIds: z.array(z.number().int().positive()),
  submissionId: z.string().nullable(),
  state: z.enum([
    "queued",
    "submitting",
    "processing",
    "processed",
    "needs_reconciliation",
  ]),
});
export const listingProgressSchema = z.object({
  batches: z.array(listingBatchSchema),
  items: z.array(listingOperationItemSchema),
  error: z.string().nullable(),
});
export type ListingProgress = z.infer<typeof listingProgressSchema>;
export interface StoredListingOperation {
  id: string;
  channelId: number;
  version: number;
  leaseToken: string | null;
  state: ListingOperation["state"];
  snapshot: ListingSnapshot;
  progress: ListingProgress;
  createdAt: string;
  updatedAt: string;
}
export function listingOperationView(
  operation: StoredListingOperation,
): ListingOperation {
  const submissions = operation.progress.batches.flatMap((batch) =>
    batch.submissionId ? [batch.submissionId] : [],
  );
  return {
    id: operation.id,
    channelId: operation.channelId,
    state: operation.state,
    submissionId: submissions.length === 1 ? submissions[0] : null,
    items: operation.progress.items,
    error: operation.progress.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}
export function summarizeListingProgress(
  progress: ListingProgress,
): ListingOperation["state"] {
  if (
    progress.batches.some((batch) => batch.state === "needs_reconciliation") ||
    progress.items.some((item) => item.state === "needs_reconciliation")
  )
    return "needs_reconciliation";
  if (progress.batches.some((batch) => batch.state === "submitting"))
    return "submitting";
  if (progress.batches.some((batch) => batch.state === "queued"))
    return "queued";
  if (
    progress.batches.some((batch) => batch.state === "processing") ||
    progress.items.some(
      (item) => item.state === "processing" || item.state === "accepted",
    )
  )
    return "processing";
  if (progress.items.every((item) => item.state === "verified"))
    return "completed";
  return progress.items.some((item) => item.state === "verified")
    ? "partially_completed"
    : "needs_attention";
}
