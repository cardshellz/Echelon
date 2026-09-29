import { z } from "zod";

/**
 * What became of a push the vendor queued, read from
 * GET /api/dropship/listing-push-jobs/:jobId and put into the vendor's words.
 */

const positiveInteger = z.number().int().positive();

const listingPushItemSchema = z.object({
  itemId: positiveInteger,
  listingId: positiveInteger.nullable(),
  productVariantId: positiveInteger,
  sku: z.string().nullable(),
  productName: z.string(),
  variantName: z.string(),
  status: z.string().min(1),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean().nullable(),
  externalListingId: z.string().nullable(),
  /** false: the store saved a draft that buyers cannot see; null: the push did not say. */
  published: z.boolean().nullable(),
  // Rendered as a link: only an https page is ever accepted.
  listingUrl: z.string().url().regex(/^https:\/\//).nullable(),
}).strict();

const listingPushJobSchema = z.object({
  jobId: positiveInteger,
  storeConnectionId: positiveInteger,
  platform: z.string().min(1),
  /** eBay's sandbox is a test site: a listing there is not on the real eBay. */
  environment: z.enum(["sandbox", "production"]).nullable(),
  status: z.string().min(1),
  finished: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  items: z.array(listingPushItemSchema),
}).strict();

export type DropshipListingPushItem = z.infer<typeof listingPushItemSchema>;
export type DropshipListingPushJob = z.infer<typeof listingPushJobSchema>;

export function listingPushJobUrl(jobId: number): string {
  if (!positiveInteger.safeParse(jobId).success) throw new Error("The listing push id is invalid.");
  return `/api/dropship/listing-push-jobs/${jobId}`;
}

export function parseDropshipListingPushJob(value: unknown): DropshipListingPushJob {
  const result = z.object({ job: listingPushJobSchema }).strict().safeParse(value);
  if (!result.success) throw new Error("The listing push status response was invalid. Refresh the page to see the result.");
  return result.data.job;
}

/** The page asks every few seconds; after this many answers (about five minutes) it stops and says where else to look. */
export const LISTING_PUSH_POLL_INTERVAL_MS = 3_000;
export const LISTING_PUSH_MAX_POLLS = 100;

/** Whether the page should ask again: the job is unfinished (or not yet read) and the answer limit is not reached. */
export function listingPushPollingContinues(job: DropshipListingPushJob | undefined, answers: number): boolean {
  if (job?.finished) return false;
  return answers < LISTING_PUSH_MAX_POLLS;
}

/** Whether the page stopped asking with the job still unfinished: the answer limit was reached first. */
export function listingPushPollingGaveUp(job: DropshipListingPushJob | undefined, answers: number): boolean {
  if (job === undefined || job.finished) return false;
  return answers >= LISTING_PUSH_MAX_POLLS;
}

export type ListingPushOutcomeTone = "pending" | "success" | "partial" | "failed";

export interface ListingPushItemOutcome {
  itemId: number;
  /** "Armalope Envelope Single Pocket · Pack of 50 · ARM-ENV-SGL-P50" */
  name: string;
  state: "pending" | "live" | "draft" | "failed";
  /** One sentence in the vendor's words. */
  line: string;
  /** The step to take, for a failed item or a draft. */
  nextStep: string | null;
  listingUrl: string | null;
  /** The words on the link, when there is one. */
  listingUrlLabel: string | null;
}

export interface ListingPushOutcome {
  tone: ListingPushOutcomeTone;
  title: string;
  items: ListingPushItemOutcome[];
}

const LIVE_ITEM_STATUSES = new Set(["completed"]);
const FAILED_ITEM_STATUSES = new Set(["failed", "blocked", "cancelled"]);

/** The store's name as the vendor sees it: eBay is a public marketplace, the rest are "your store". */
export function listingPushStoreLabel(platform: string, storeName: string | null): string {
  if (storeName && storeName.trim()) return storeName.trim();
  return platform === "ebay" ? "eBay" : "your store";
}

const SANDBOX_NOTE = "This is eBay's sandbox test site, not the real eBay.";

export function describeListingPushOutcome(job: DropshipListingPushJob, storeName: string | null): ListingPushOutcome {
  const store = listingPushStoreLabel(job.platform, storeName);
  const sandbox = job.environment === "sandbox";
  const linkLabel = job.platform === "ebay" ? (sandbox ? "View on eBay sandbox" : "View on eBay") : "View listing";
  const items = job.items.map((item): ListingPushItemOutcome => {
    const name = [item.productName, item.variantName, item.sku].filter((part) => part && part.trim()).join(" · ");
    const base = { itemId: item.itemId, name, listingUrl: null, listingUrlLabel: null };
    if (LIVE_ITEM_STATUSES.has(item.status) && item.published === false) {
      return {
        ...base, state: "draft", line: `Saved on ${store} as an unpublished draft. Buyers cannot see it yet.`,
        nextStep: "Your store is set to save drafts instead of publishing. Ask support to switch your store to live listings, then queue it again.",
      };
    }
    if (LIVE_ITEM_STATUSES.has(item.status)) {
      return {
        ...base, state: "live", line: sandbox ? `Live on ${store} (eBay sandbox).` : `Live on ${store}.`, nextStep: null,
        listingUrl: item.listingUrl, listingUrlLabel: item.listingUrl ? linkLabel : null,
      };
    }
    if (FAILED_ITEM_STATUSES.has(item.status)) {
      const reason = item.errorMessage?.trim() || "the store did not say why";
      return { ...base, state: "failed", line: `Could not list: ${reason}`, nextStep: listingPushNextStep(item.errorCode, item.retryable) };
    }
    return { ...base, state: "pending", line: `Sending to ${store}…`, nextStep: null };
  });
  const total = items.length;
  const count = (state: ListingPushItemOutcome["state"]) => items.filter((item) => item.state === state).length;
  const live = count("live");
  const draft = count("draft");
  const failed = count("failed");
  const noun = (n: number) => `${n} listing${n === 1 ? "" : "s"}`;
  if (!job.finished) {
    const pending = total - live - draft - failed;
    const title = pending > 0
      ? `Sending ${noun(pending)} to ${store}. This usually takes under a minute; the result shows here.`
      : `Finishing up at ${store}…`;
    return { tone: "pending", title, items };
  }
  if (total > 0 && live === total) {
    return { tone: "success", title: `Live on ${store}: ${noun(live)}.${sandbox ? ` ${SANDBOX_NOTE}` : ""}`, items };
  }
  if (total > 0 && draft === total) {
    return { tone: "partial", title: `Saved on ${store} as unpublished drafts: ${noun(draft)}. Buyers cannot see them yet.`, items };
  }
  if (live === 0 && draft === 0) {
    return { tone: "failed", title: `Could not list ${noun(total)} on ${store}.`, items };
  }
  const parts = [
    live > 0 ? `${live} live` : null,
    draft > 0 ? `${draft} saved as ${draft === 1 ? "a draft" : "drafts"}` : null,
    failed > 0 ? `${failed} could not be listed` : null,
  ].filter((part): part is string => part !== null);
  return { tone: "partial", title: `Of ${noun(total)} on ${store}: ${parts.join(", ")}.${sandbox ? ` ${SANDBOX_NOTE}` : ""}`, items };
}

/**
 * The step to take after a refusal. The reason itself comes from the store
 * (already in the item's line); this says what to do about it.
 */
export function listingPushNextStep(errorCode: string | null, retryable: boolean | null): string {
  switch (errorCode) {
    case "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR":
    case "DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR":
      return retryable
        ? "This was a temporary problem at the store. Queue the listing again in a few minutes."
        : "Fix what the store named, then queue the listing again.";
    case "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW":
      return "Its price moved after it was queued. Check the price on this page, then queue the listing again.";
    case "DROPSHIP_LISTING_PREVIEW_DRIFT":
      return "The listing changed while it was queued. Queue it again.";
    case "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
      return "Your account or store cannot list right now. See the notice at the top of this card.";
    default:
      return retryable
        ? "Queue the listing again in a few minutes. Contact support with this message if it keeps failing."
        : "Fix the reason above and queue the listing again, or contact support with this message.";
  }
}
