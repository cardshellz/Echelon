import { z } from "zod";

// Shopify caps a connection at 25,000 objects. Split before reaching that cap.
// https://shopify.dev/docs/api/usage/pagination-graphql#pagination-limits
export const ACCOUNT_NATIVE_RANGE_RECORD_BUDGET = 10_000;
export const ACCOUNT_NATIVE_CHECKPOINT_LIMIT = 16_384;
const bound = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const positive = z.string().regex(/^[1-9][0-9]{0,29}$/);
const opaque = z.string().min(1).max(4096);

export const accountNativeScanSchema = z.object({
  version: z.literal(1), kind: z.literal("scan"),
  connectionId: z.number().int().positive().safe(),
  since: z.string().datetime({ offset: true }).nullable(),
  lower: bound, upper: positive.nullable(),
  pending: z.array(positive).max(100),
  pageCursor: opaque.nullable(),
  seen: z.number().int().nonnegative().max(ACCOUNT_NATIVE_RANGE_RECORD_BUDGET - 1),
}).strict().superRefine((state, context) => {
  let previous = BigInt(state.upper ?? state.lower);
  if (state.upper !== null && previous <= BigInt(state.lower))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Empty scan range" });
  for (const end of state.pending) {
    if (BigInt(end) <= previous)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Unordered pending ranges" });
    previous = BigInt(end);
  }
  if ((state.upper === null && (state.pending.length > 0 || state.pageCursor !== null || state.seen !== 0))
    || ((state.pageCursor === null) !== (state.seen === 0)))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent scan position" });
});
export type AccountNativeScan = z.infer<typeof accountNativeScanSchema>;
export const accountNativeCheckpointSchema = z.union([
  accountNativeScanSchema,
  z.object({ version: z.literal(1), kind: z.literal("complete") }).strict(),
]);
export const accountNativePageInfoSchema = z.object({
  hasNextPage: z.boolean(), endCursor: opaque.nullable(),
}).strict();
type PageInfo = z.infer<typeof accountNativePageInfoSchema>;
type Step = { kind: "complete" } | { kind: "range" | "continue"; scan: AccountNativeScan };

export class AccountNativePaginationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message); this.name = "AccountNativePaginationError";
  }
}

export function readAccountNativeScan(connectionId: number, after: string | null, since: Date | null): AccountNativeScan {
  const expectedSince = since === null ? null : z.date().parse(since).toISOString();
  const scan = after === null
    ? accountNativeScanSchema.parse({ version: 1, kind: "scan", connectionId, since: expectedSince,
        lower: "0", upper: null, pending: [], pageCursor: null, seen: 0 })
    : accountNativeScanSchema.parse(JSON.parse(z.string().max(ACCOUNT_NATIVE_CHECKPOINT_LIMIT).parse(after)));
  if (scan.connectionId !== connectionId || scan.since !== expectedSince)
    throw new AccountNativePaginationError("ACCOUNT_NATIVE_CURSOR_SCOPE_CHANGED", "The checkpoint belongs to another connection or update scan.");
  return scan;
}

export function serializeAccountNativeScan(scan: AccountNativeScan): string {
  return z.string().max(ACCOUNT_NATIVE_CHECKPOINT_LIMIT).parse(JSON.stringify(accountNativeScanSchema.parse(scan)));
}

export function accountNativeScanQuery(scan: AccountNativeScan) {
  return {
    after: scan.pageCursor,
    search: [scan.since === null ? null : `updated_at:>=\"${scan.since}\"`,
      scan.lower === "0" ? null : `id:>${scan.lower}`, scan.upper === null ? null : `id:<=${scan.upper}`]
      .filter(Boolean).join(" AND ") || null,
    sort: "ID" as const,
  };
}

/** Numeric IDs bound a fully exhausted range; they never stand in for a page
 * cursor. Never jump to the maximum row of a partially read page. */
export function advanceAccountNativeScan(scan: AccountNativeScan, ids: readonly string[], rawInfo: PageInfo): Step {
  const info = accountNativePageInfoSchema.parse(rawInfo);
  const parsed = z.array(positive).max(100).parse(ids);
  if (new Set(parsed).size !== parsed.length || parsed.some(id => BigInt(id) <= BigInt(scan.lower)
    || (scan.upper !== null && BigInt(id) > BigInt(scan.upper))))
    throw new AccountNativePaginationError("ACCOUNT_NATIVE_PAGE_RANGE_INVALID", "The page returned a duplicate or out-of-range order identity.");
  if (info.hasNextPage && (parsed.length === 0 || info.endCursor === null || info.endCursor === scan.pageCursor))
    throw new AccountNativePaginationError("ACCOUNT_NATIVE_CURSOR_NOT_ADVANCING", "The provider did not advance its page cursor.");
  if (scan.upper === null) {
    if (!info.hasNextPage) return { kind: "complete" };
    const upper = parsed.reduce((maximum, id) => BigInt(id) > BigInt(maximum) ? id : maximum);
    // Discovery does not checkpoint these rows. Re-read the entire bounded
    // range with provider cursors, including rows omitted at this page boundary.
    return { kind: "range", scan: { ...scan, upper } };
  }
  if (!info.hasNextPage) {
    const [upper = null, ...pending] = scan.pending;
    return { kind: "continue", scan: { ...scan, lower: scan.upper, upper, pending, pageCursor: null, seen: 0 } };
  }
  const seen = scan.seen + parsed.length;
  if (seen >= ACCOUNT_NATIVE_RANGE_RECORD_BUDGET) {
    // IDs can be sparse and far above zero. Prefer an observed pivot so an
    // old store does not repeatedly scan 10,000 rows to bisect empty ID space.
    // Both resulting ranges are fully re-read; the sample never proves absence.
    const ordered = [...parsed].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const sample = BigInt(ordered[Math.floor(ordered.length / 2)]);
    const middle = sample < BigInt(scan.upper) ? sample
      : (BigInt(scan.lower) + BigInt(scan.upper)) / BigInt(2);
    if (middle <= BigInt(scan.lower))
      throw new AccountNativePaginationError("ACCOUNT_NATIVE_PAGE_RANGE_INCONSISTENT", "A single-ID range returned too many records.");
    return { kind: "continue", scan: accountNativeScanSchema.parse({ ...scan, upper: String(middle),
      pending: [scan.upper, ...scan.pending], pageCursor: null, seen: 0 }) };
  }
  return { kind: "continue", scan: { ...scan, pageCursor: info.endCursor, seen } };
}
