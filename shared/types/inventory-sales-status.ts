import { z } from "zod";

import { salesStatusScopeKey } from "../inventory/sales-status-resolution";

/**
 * Sales status (owner decision 2026-11-07): stop or resume selling a product
 * or SKU on every sales channel at once, with optional per-channel exceptions
 * ("stopped everywhere except Shopify"). A change takes effect when it is
 * saved: no draft and no channel review. Every change is kept in an
 * append-only history (inventory.sales_status_events).
 *
 * Stopped publishes 0 and keeps the listing. The planner still records the
 * SKU's real canonical ATP, so resuming restores the calculated quantity.
 * This is the operator's holder. Automation holds (Dropship listing tiers and
 * cost-change pauses, Walmart unpublish) are separate holders: any holder
 * stops a SKU, and resuming here never releases theirs.
 *
 * Precedence lives in shared/inventory/sales-status-resolution.ts.
 */

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const id = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
/** A version stamp from inventory.sales_status_revision_seq: never reused, so a stale view is always detected. */
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const timestamp = z.string().datetime({ offset: true });

export const SALES_STATUS_NOTE_MAX_LENGTH = 500;
/** One command changes at most this many scopes; it runs in one transaction. */
export const SALES_STATUS_MAX_CHANGES = 500;
/** The catalog-wide list returns at most this many settings. */
export const SALES_STATUS_LIST_LIMIT = 500;

export const salesStatusSchema = z.enum(["selling", "stopped"]);
export type SalesStatus = z.infer<typeof salesStatusSchema>;

export const salesStatusScopeSchema = z.object({
  /** Null: every sales channel. */
  channelId: id.nullable(),
  productId: id,
  /** Null: the whole product, including SKUs added later. */
  productVariantId: id.nullable(),
}).strict();
export type SalesStatusScope = z.infer<typeof salesStatusScopeSchema>;

export const salesStatusScopeKeySchema = z.string().max(80)
  .regex(/^(all|channel:[1-9][0-9]{0,9}):(product|variant):[1-9][0-9]{0,9}$/);

/** An explicit setting at one scope. A scope with no entry inherits. */
export const salesStatusEntrySchema = z.object({
  scopeKey: salesStatusScopeKeySchema,
  scope: salesStatusScopeSchema,
  status: salesStatusSchema,
  note: z.string().max(SALES_STATUS_NOTE_MAX_LENGTH).nullable(),
  revision,
  updatedBy: nonblank(100),
  updatedAt: timestamp,
}).strict().superRefine((entry, context) => {
  if (entry.scopeKey !== salesStatusScopeKey(entry.scope)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeKey"], message: "The scope key does not match the scope." });
  }
});
export type SalesStatusEntry = z.infer<typeof salesStatusEntrySchema>;

/** The state requested at one scope. "inherit" removes this scope's own setting. */
export const salesStatusTargetSchema = z.enum(["selling", "stopped", "inherit"]);
export type SalesStatusTarget = z.infer<typeof salesStatusTargetSchema>;

export const salesStatusChangeSchema = z.object({
  scope: salesStatusScopeSchema,
  status: salesStatusTargetSchema,
  /** The revision of the entry the operator saw at this scope; null when there was none. */
  expectedRevision: revision.nullable(),
}).strict();
export type SalesStatusChange = z.infer<typeof salesStatusChangeSchema>;

/** A written note is optional context for the history, never a gate on the change. Blank becomes null. */
const optionalNote = z.string().trim().max(SALES_STATUS_NOTE_MAX_LENGTH).nullable().optional()
  .transform((value) => (value ? value : null));

export const changeSalesStatusRequestSchema = z.object({
  changes: z.array(salesStatusChangeSchema).min(1).max(SALES_STATUS_MAX_CHANGES),
  note: optionalNote,
  idempotencyKey: nonblank(120),
}).strict().superRefine((request, context) => {
  const seen = new Set<string>();
  request.changes.forEach((change, index) => {
    const key = salesStatusScopeKey(change.scope);
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", index, "scope"], message: "Each scope may appear only once in a change." });
    }
    seen.add(key);
  });
});
export type ChangeSalesStatusRequest = z.infer<typeof changeSalesStatusRequestSchema>;

const statusVersionSchema = z.object({ status: salesStatusSchema, revision }).strict();

export const salesStatusChangeResultSchema = z.object({
  changes: z.array(z.object({
    scopeKey: salesStatusScopeKeySchema,
    scope: salesStatusScopeSchema,
    /** Null: no setting at this scope (it inherited). */
    before: statusVersionSchema.nullable(),
    after: statusVersionSchema.nullable(),
    /** False when the scope was already in the requested state. */
    changed: z.boolean(),
  }).strict()),
  /** Products whose published stock follows from the changed scopes, in id order. */
  affectedProductIds: z.array(id),
  /** Products republished inside this change. */
  republished: z.array(z.object({
    productId: id,
    /** Stock updates queued for the channels. */
    publicationRows: z.number().int().nonnegative(),
    /** Destinations skipped because their own listing data cannot be published; they keep their last quantity until fixed. */
    skippedDestinations: z.array(z.object({
      publicationTargetId: id,
      channelId: id,
      channelName: z.string(),
      errorCode: z.string(),
    }).strict()),
  }).strict()),
  /**
   * Products handed to the stock-update worker, which plans them within a
   * minute or two and retries on failure: a large change ("large_change"), or
   * a product whose stock could not be planned right now
   * ("could_not_republish", with the planner's code). The setting is saved
   * either way; only its stock update is pending.
   */
  queued: z.array(z.object({
    productId: id,
    reason: z.enum(["large_change", "could_not_republish"]),
    errorCode: z.string().max(100).nullable(),
  }).strict()),
  alreadyApplied: z.boolean(),
  providerWriteAttempted: z.literal(false),
}).strict();
export type SalesStatusChangeResult = z.infer<typeof salesStatusChangeResultSchema>;

export const salesStatusProductViewSchema = z.object({
  runtimeAuthority: z.enum(["legacy", "canonical"]),
  product: z.object({ id, sku: z.string().max(100).nullable(), name: z.string() }).strict(),
  /** Every SKU of the product. Only sellable SKUs publish stock. */
  variants: z.array(z.object({
    id,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    unitsPerVariant: id,
    sellable: z.boolean(),
  }).strict()),
  channels: z.array(z.object({
    id,
    name: z.string(),
    provider: z.string(),
    status: z.string(),
    /** True when Echelon sends stock to at least one live destination of the channel. */
    publishesStock: z.boolean(),
  }).strict()),
  /** Every explicit setting for the product and its SKUs. */
  entries: z.array(salesStatusEntrySchema),
  /** Other holders that also keep stock at 0 on a destination. Resuming here does not release them. */
  otherHolds: z.array(z.object({
    publicationTargetId: id,
    channelId: id,
    /** Null: the whole destination is held. */
    productVariantId: id.nullable(),
    reason: z.string(),
    heldBy: z.string(),
    heldAt: timestamp,
  }).strict()),
}).strict();
export type SalesStatusProductView = z.infer<typeof salesStatusProductViewSchema>;

export const salesStatusListQuerySchema = z.object({
  status: salesStatusSchema.default("stopped"),
}).strict();

export const salesStatusListSchema = z.object({
  entries: z.array(z.object({
    entry: salesStatusEntrySchema,
    productName: z.string(),
    productSku: z.string().max(100).nullable(),
    /** Null for a whole-product setting. */
    variantSku: z.string().max(100).nullable(),
    /** Null for an all-channels setting. */
    channelName: z.string().nullable(),
  }).strict()),
  /** True when more settings exist than SALES_STATUS_LIST_LIMIT; the newest are returned. */
  truncated: z.boolean(),
}).strict();
export type SalesStatusList = z.infer<typeof salesStatusListSchema>;
