import type { ListingSettingRequestOperation } from "../../../../shared/dropship/listing-setting-values";

/**
 * What a listing-settings request key has already written, and whether a
 * request with that key is new, a replay of a committed request, or a reuse
 * of the key for another change (plan PR 9, P16, section 4.6). Pure: no
 * clock, no I/O, nothing thrown, inputs never mutated (CLAUDE.md §4). The
 * services turn `conflict` and `incomplete` into their errors.
 */

/**
 * The child kinds a listing-settings writer can write under a request key:
 * size prices and the three per-size leftover tables. The order is the replay
 * probe's ($3-$6), and the probe's row parser accepts exactly these kinds.
 */
export const REQUEST_KEY_CHILD_SOURCES = ["size", "policy", "shelf", "content"] as const;
export type RequestKeyChildSource = (typeof REQUEST_KEY_CHILD_SOURCES)[number];

/** Every row the request key wrote, read by one statement under the request lock (findRequestKeyUse). */
export interface RequestKeyUse {
  /** The product revision under the key itself (W5's saveProduct); bulk product rows carry child keys and are covered by their ledger row. */
  productRevision: { revisionId: number; productId: number; storeConnectionId: number; requestHash: string; requestId: number | null } | null;
  categoryRevision: { revisionId: number; categoryId: number; storeConnectionId: number; requestHash: string } | null;
  ledger: { requestId: number; operation: ListingSettingRequestOperation; storeConnectionId: number; requestHash: string } | null;
  /** Every child under the key's size, policy, shelf and content prefixes. */
  children: ReadonlyArray<{ kind: RequestKeyChildSource; revisionId: number; productVariantId: number;
    storeConnectionId: number; requestHash: string }>;
}

/** The PR 9 writers: W8, W5, W6, W12, W7 apply and W13. */
export type ListingSettingWriter = "size_prices" | "product_settings" | "product_settings_bulk" | "category_settings"
  | "price_change_apply" | "category_moves_acknowledge";

export type RequestKeyUseDecision =
  | { kind: "new" }
  | { kind: "replay" }
  | { kind: "conflict"; mismatched: string[] }
  | { kind: "incomplete" };

/**
 * What each writer may have written under its key (plan 4.6 table), and what
 * a replay needs. W7 apply's `price_change_apply` is a ledger operation from
 * migration 0750 on: its apply replays from its ledger row, with the
 * category revision (category kind) and the size, policy and shelf children
 * (releases, clean-ups) that request wrote.
 */
interface WriterScope {
  ledgerOperations: readonly ListingSettingRequestOperation[];
  productRevision: boolean;
  categoryRevision: boolean;
  childKinds: readonly RequestKeyChildSource[];
  /** `ledger`: only the ledger row proves the request committed; `any`: any row does; `sizes`: W8's own size children. */
  replayWhen: "ledger" | "any" | "sizes";
}

const WRITER_SCOPES: Readonly<Record<ListingSettingWriter, WriterScope>> = Object.freeze({
  size_prices: { ledgerOperations: [], productRevision: false, categoryRevision: false, childKinds: ["size"], replayWhen: "sizes" },
  product_settings: {
    ledgerOperations: [], productRevision: true, categoryRevision: false,
    childKinds: ["size", "policy", "shelf", "content"], replayWhen: "any",
  },
  product_settings_bulk: {
    ledgerOperations: ["product_settings_bulk"], productRevision: false, categoryRevision: false,
    childKinds: ["policy", "shelf", "content"], replayWhen: "ledger",
  },
  category_settings: {
    ledgerOperations: ["category_settings_clear"], productRevision: false, categoryRevision: true,
    childKinds: ["policy", "shelf"], replayWhen: "any",
  },
  price_change_apply: {
    ledgerOperations: ["price_change_apply"], productRevision: false, categoryRevision: true,
    childKinds: ["size", "policy", "shelf"], replayWhen: "ledger",
  },
  category_moves_acknowledge: {
    ledgerOperations: ["category_moves_acknowledge"], productRevision: false, categoryRevision: false,
    childKinds: [], replayWhen: "ledger",
  },
});

export interface RequestKeyUseExpectation {
  writer: ListingSettingWriter;
  storeConnectionId: number;
  requestHash: string;
  /** The path's product (W5); a product revision for any other product is a key reuse. */
  productId?: number;
  /** The path's category (W12, W7 category kind); without it a category revision is a key reuse. */
  categoryId?: number;
  /** W8's sizes: a replay must have written exactly these. */
  sizeIds?: readonly number[];
}

/**
 * Nothing found → `new`. Every found row must carry this store and this
 * request hash and be of a kind, ledger operation and target id the writer
 * writes, else `conflict` naming the mismatched fields. Then `replay` when the
 * rows prove the request committed (the writer's `replayWhen`), else
 * `incomplete`: rows a committed request cannot have left on their own.
 */
export function classifyRequestKeyUse(use: RequestKeyUse, expected: RequestKeyUseExpectation): RequestKeyUseDecision {
  const { productRevision, categoryRevision, ledger, children } = use;
  if (!productRevision && !categoryRevision && !ledger && children.length === 0) return { kind: "new" };
  const scope = WRITER_SCOPES[expected.writer];
  const mismatched = new Set<string>();
  const sameRequest = (source: string, row: { storeConnectionId: number; requestHash: string }) => {
    if (row.storeConnectionId !== expected.storeConnectionId) mismatched.add(`${source}.storeConnectionId`);
    if (row.requestHash !== expected.requestHash) mismatched.add(`${source}.requestHash`);
  };

  if (productRevision) {
    if (!scope.productRevision) mismatched.add("productRevision");
    else {
      if (productRevision.productId !== expected.productId) mismatched.add("productRevision.productId");
      // saveProduct writes no ledger row; a revision tied to one came from another writer.
      if (productRevision.requestId !== null) mismatched.add("productRevision.requestId");
    }
    sameRequest("productRevision", productRevision);
  }
  if (categoryRevision) {
    if (!scope.categoryRevision || expected.categoryId === undefined) mismatched.add("categoryRevision");
    else if (categoryRevision.categoryId !== expected.categoryId) mismatched.add("categoryRevision.categoryId");
    sameRequest("categoryRevision", categoryRevision);
  }
  if (ledger) {
    if (!scope.ledgerOperations.includes(ledger.operation)) mismatched.add("ledger.operation");
    sameRequest("ledger", ledger);
  }
  for (const child of children) {
    if (!scope.childKinds.includes(child.kind)) mismatched.add(child.kind);
    sameRequest(child.kind, child);
  }
  if (mismatched.size > 0) return { kind: "conflict", mismatched: [...mismatched].sort() };

  switch (scope.replayWhen) {
    case "any":
      return { kind: "replay" };
    case "ledger":
      return ledger ? { kind: "replay" } : { kind: "incomplete" };
    case "sizes":
      return sameIds(children.map((child) => child.productVariantId), expected.sizeIds ?? []) ? { kind: "replay" } : { kind: "incomplete" };
  }
}

/** The same ids, each once, in any order. */
function sameIds(found: readonly number[], wanted: readonly number[]): boolean {
  const foundSet = new Set(found);
  const wantedSet = new Set(wanted);
  if (foundSet.size !== found.length || wantedSet.size !== wanted.length || foundSet.size !== wantedSet.size) return false;
  return [...wantedSet].every((id) => foundSet.has(id));
}
