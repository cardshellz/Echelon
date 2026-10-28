import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  STOCK_LINK_DECIMAL_ID_PATTERN,
  STOCK_LINK_SKU_MAX_LENGTH,
  type StockLinkCheckStatus,
  type StockLinkStoreItem,
} from "@shared/types/stock-link";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "./stock-link-errors";

/**
 * The stock-link engine's pure rules (channels PR2, PLAN-CH2 v4.1 §4.2): how a Card Shellz size is matched to the
 * one store item that carries its SKU, when an existing link is kept, moved or retired, the joint rule for a claimed
 * batch, the two safety stops, the retry schedule and the command keys. No I/O, no clock, no randomness of its own:
 * the tick passes the facts it read and an injected `random`; the same facts always give the same plan.
 *
 * The decision tables are Shopify's (the only policy PR2 runs): identity = the decimal InventoryItem id, "on sale" =
 * product status ACTIVE, SKU equality = trimmed and case-insensitive (the shopify-link route's rule, DV4-9).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The actor of every engine write: retires (`retired_by`), drafts, audit rows. The retire count reads it (§4.2). */
export const STOCK_LINK_ACTOR = "system:stock-link";
/** Prefix of every engine key: the command lock and receipt `stock-link:<commandKey>`, each draft
 * `stock-link:<commandKey>:<variantId>` (C14). Dropship keeps its own `dropship-ebay-stock` prefix. */
export const STOCK_LINK_KEY_PREFIX = "stock-link";
/** The only Shopify product status that is on sale (C10): an archived or draft copy can't oversell. */
export const STOCK_LINK_SHOPIFY_ON_SALE_STATUS = "ACTIVE";
/** Members of one command (one destination, one product), as the Dropship contract bounds them. */
export const STOCK_LINK_COMMAND_MEMBERS_MAX = 500;
/** Provider evidence older than this is re-read, never applied (§4.3 step 0, STOCK_LINK_EVIDENCE_STALE). */
export const STOCK_LINK_EVIDENCE_MAX_AGE_MS = 5 * MINUTE_MS;
/** Linked items outside the retiring set the tick may observe as a control (one extra observeItems call, SAF-7). */
export const STOCK_LINK_CONTROL_READ_MAX = 3;

/**
 * The retire hold (V3-5, TST-8): retires without replacement by STOCK_LINK_ACTOR, counted over `windowHours` from
 * `max(now − windowHours, retires_released_at)` with the injected clock, may reach `limit` per destination; the next
 * one is held until a person presses Continue. One constant feeds the engine's count and the Ops Health SQL (§8).
 */
export const STOCK_LINK_RETIRE_HOLD = Object.freeze({ windowHours: 24, limit: 25 });

/** Row outcomes the decision names (§10). F1-F4 are flags, the rest waits or a transient self-check. */
export const STOCK_LINK_DECISION_CODES = Object.freeze({
  skuBlank: "STOCK_LINK_SKU_BLANK",
  storeSkuBlank: "STOCK_LINK_STORE_SKU_BLANK",
  skuDuplicate: "STOCK_LINK_SKU_DUPLICATE",
  itemShared: "STOCK_LINK_ITEM_SHARED",
  notListed: "STOCK_LINK_NOT_LISTED",
  notOnSale: "STOCK_LINK_NOT_ON_SALE",
  selectionBlocked: "STOCK_LINK_SELECTION_BLOCKED",
  waitingForFreedItem: "STOCK_LINK_WAITING_FOR_FREED_ITEM",
  lookupMissed: STOCK_LINK_ERROR_CODES.lookupMissed,
  storeNotAnswering: STOCK_LINK_ERROR_CODES.storeNotAnswering,
  retiresHeld: "STOCK_LINK_RETIRES_HELD",
  /** A size whose reads did not fit this tick's call budget (§7.2 step 5, TST-12): released busy, read first next tick. */
  notRead: STOCK_LINK_ERROR_CODES.callBudgetUsed,
});

const D = STOCK_LINK_DECISION_CODES;

// ---------------------------------------------------------------------------
// SKU and id rules
// ---------------------------------------------------------------------------

/** A SKU as the engine compares it: blank, or its trimmed value, its comparison key and whether it fits 100 chars. */
export type StockLinkSku =
  | { readonly kind: "blank" }
  | { readonly kind: "sku"; readonly value: string; readonly key: string; readonly storable: boolean };

const BLANK_SKU: StockLinkSku = Object.freeze({ kind: "blank" });

/**
 * Trim; blank after trim = blank; compare upper-cased (DV4-9). The length is counted in characters, as Postgres
 * varchar(100) counts them, before upper-casing (which can lengthen some letters). A SKU longer than
 * STOCK_LINK_SKU_MAX_LENGTH is not storable: it equals nothing and is never written (TST-12).
 */
export function normalizeStockLinkSku(raw: string | null | undefined): StockLinkSku {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) return BLANK_SKU;
  return Object.freeze({ kind: "sku", value, key: value.toUpperCase(),
    storable: Array.from(value).length <= STOCK_LINK_SKU_MAX_LENGTH });
}

/** Two SKUs are equal only when both are storable and their keys match: blank never equals blank. */
export function stockLinkSkusEqual(left: StockLinkSku, right: StockLinkSku): boolean {
  return left.kind === "sku" && right.kind === "sku" && left.storable && right.storable && left.key === right.key;
}

const SHOPIFY_INVENTORY_ITEM_GID = /^gid:\/\/shopify\/InventoryItem\/([1-9]\d{0,19})$/;

/**
 * A saved Shopify item id in the one form the engine compares (§4.2): a decimal REST id stays; exactly
 * `gid://shopify/InventoryItem/<decimal>` becomes that decimal; anything else is unparseable (null) and equals nothing.
 */
export function normalizeShopifyItemId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (STOCK_LINK_DECIMAL_ID_PATTERN.test(raw)) return raw;
  return SHOPIFY_INVENTORY_ITEM_GID.exec(raw)?.[1] ?? null;
}

/** On sale = the store item's product is ACTIVE (C10, DV4-1). */
export function isStockLinkItemOnSale(item: Pick<StockLinkStoreItem, "productStatus">): boolean {
  return item.productStatus === STOCK_LINK_SHOPIFY_ON_SALE_STATUS;
}

// ---------------------------------------------------------------------------
// N6: Card Shellz SKUs shared by carried sizes (SAF-3)
// ---------------------------------------------------------------------------

export interface StockLinkCarriedSku {
  readonly productVariantId: number;
  /** COALESCE(sku_override, v.sku) for this channel, as stored. */
  readonly sku: string | null;
}

/** Normalised Card Shellz SKU → every carried size of the destination (publish and zero) that has it. */
export function buildCarriedSkuIndex(carried: readonly StockLinkCarriedSku[]): ReadonlyMap<string, readonly number[]> {
  const index = new Map<string, number[]>();
  for (const row of carried) {
    const sku = normalizeStockLinkSku(row.sku);
    if (sku.kind !== "sku" || !sku.storable) continue;
    const sizes = index.get(sku.key) ?? [];
    if (!sizes.includes(row.productVariantId)) sizes.push(row.productVariantId);
    index.set(sku.key, sizes);
  }
  for (const sizes of index.values()) sizes.sort((a, b) => a - b);
  return index;
}

/** The other carried sizes of the destination whose Card Shellz SKU equals this one (none for a blank SKU). */
export function sizesSharingSku(index: ReadonlyMap<string, readonly number[]>, sku: StockLinkSku,
  productVariantId: number): number[] {
  if (sku.kind !== "sku" || !sku.storable) return [];
  return (index.get(sku.key) ?? []).filter(id => id !== productVariantId);
}

// ---------------------------------------------------------------------------
// Decision inputs and outputs
// ---------------------------------------------------------------------------

export type StockLinkSelectionAction = "publish" | "zero" | "read_only" | "none";
export type StockLinkPurpose = "publish" | "sync";
export type StockLinkMappingAction = "create" | "promote_draft" | "replace_draft";
export type StockLinkChange = "none" | "link" | "relink" | "retire";

export interface StockLinkMappingFact {
  readonly mappingId: number;
  /** external_inventory_item_id as saved (any form; the engine normalises it). */
  readonly itemId: string;
  readonly externalSku: string | null;
}
export interface StockLinkDraftFact extends StockLinkMappingFact {
  readonly definitionHash: string;
}
export interface StockLinkHeadFact {
  readonly revision: string;
  readonly active: StockLinkMappingFact | null;
  readonly draft: StockLinkDraftFact | null;
}

/** One claimed size, as the tick read it (§4.2 "Inputs per size"). */
export interface StockLinkSizeFacts {
  readonly productVariantId: number;
  readonly productId: number;
  /** COALESCE(sku_override, v.sku) for this channel, as stored. */
  readonly cardShellzSku: string | null;
  /** The listing owner's selection (readPublicationStockSelection): publish → purpose publish, zero → sync. */
  readonly selection: { readonly action: StockLinkSelectionAction; readonly blockerCodes: readonly string[] };
  readonly head: StockLinkHeadFact | null;
  /** The check row's grandfathered store SKU (V6). */
  readonly observedSku: string | null;
  /** The size's saved feed item (channel_feeds.channel_inventory_item_id): a hint, never proof. */
  readonly feedHintItemId: string | null;
}

/** Every mapping head of the destination, not only the batch: the item each one holds. */
export interface StockLinkDestinationHead {
  readonly productVariantId: number;
  readonly activeItemId: string | null;
  readonly draftItemId: string | null;
}

export interface StockLinkBatchReads {
  /** The Card Shellz SKUs this tick looked up (complete for each; a short read never reaches the decision). */
  readonly lookedUpSkus: readonly string[];
  /** Every item those lookups returned. */
  readonly lookupItems: readonly StockLinkStoreItem[];
  /** Saved items observed by id this tick (linked items, feed hints, control reads); `item: null` = gone. */
  readonly observations: readonly { readonly itemId: string; readonly item: StockLinkStoreItem | null }[];
  /** Whether the tick already made the extra control read this plan asked for (SAF-7). */
  readonly controlReadDone: boolean;
}

export interface StockLinkBatchInput {
  readonly sizes: readonly StockLinkSizeFacts[];
  readonly destinationHeads: readonly StockLinkDestinationHead[];
  /** N6: every carried size of the destination (listCarriedSkus), not only the batch. */
  readonly carriedSkus: readonly StockLinkCarriedSku[];
  readonly reads: StockLinkBatchReads;
  /** Retires without replacement in the hold window (STOCK_LINK_RETIRE_HOLD), counted with the injected clock. */
  readonly recentRetireCount: number;
}

export type StockLinkDecisionDetail =
  | { readonly kind: "ECHELON_SKU_SHARED"; readonly productVariantIds: readonly number[] }
  | { readonly kind: "ITEM_HELD"; readonly itemId: string; readonly heldByProductVariantIds: readonly number[] }
  | { readonly kind: "SKU_DUPLICATE"; readonly itemIds: readonly string[] }
  | { readonly kind: "SELECTION_BLOCKED"; readonly action: StockLinkSelectionAction; readonly blockerCodes: readonly string[] }
  | { readonly kind: "WAITING_FOR_FREED_ITEM"; readonly itemId: string; readonly freedByProductVariantIds: readonly number[] };

/** The store item a member links to, and how the mapping is written (§4.2 rows 8-10). */
export interface StockLinkLinkChoice {
  /** Decimal REST id. */
  readonly itemId: string;
  /** The store's SKU, trimmed (≤ 100 characters), written as external_sku. */
  readonly storeSku: string;
  readonly mappingAction: StockLinkMappingAction;
  /** The pending draft this member promotes or replaces in place (V3-7). */
  readonly draft: { readonly mappingId: number; readonly definitionHash: string } | null;
}

/** One size's outcome for this tick. Every claimed size gets exactly one. */
export interface StockLinkSizeDecision {
  readonly productVariantId: number;
  readonly productId: number;
  readonly change: StockLinkChange;
  /** The check row's status after this tick; "unchanged" when nothing was decided (not read, or a stopped retire). */
  readonly status: Exclude<StockLinkCheckStatus, "error"> | "unchanged";
  /** Why; null for a link that is (or just became) correct with nothing to report. */
  readonly code: string | null;
  /** transient: an attempt is counted and backed off; busy: released, no attempt; null: settled. */
  readonly retry: "transient" | "busy" | null;
  readonly link: StockLinkLinkChoice | null;
  /** The sealed version a relink or retire replaces. */
  readonly replacesMappingId: number | null;
  /** The head revision the command must still find (§4.3 step 6); "0" = no head. */
  readonly expectedHeadRevision: string;
  /** The Card Shellz SKU (trimmed) the command re-confirms under lock (§4.3 step 5). */
  readonly cardShellzSku: string | null;
  readonly selectionAction: StockLinkSelectionAction;
  /** F4 and WAITING_FOR_FREED_ITEM: the item this row waits on; a command that frees it wakes the row (SAF-5). */
  readonly waitingItemId: string | null;
  /** WAITING_FOR_FREED_ITEM: due again next tick, never backed off. */
  readonly dueNextTick: boolean;
  /** V6: the store SKU to record once as the row's observed_sku. */
  readonly recordObservedSku: string | null;
  readonly detail: StockLinkDecisionDetail | null;
  /** The table row that decided (L1-L10 first link, V1-V10 verify, S1/S2 safety stops), for logs and tests. */
  readonly rule: string;
}

/** One command = one destination, one product (§4.3): every size of the product that links, relinks or retires. */
export interface StockLinkCommandPlan {
  readonly productId: number;
  /** sync when any member is a removed (`zero`) size, so retained zero may link (allowRetainedZero). */
  readonly purpose: StockLinkPurpose;
  /** In variant-id order. The command retires every replaced version before it links (§4.3 step 7). */
  readonly members: readonly StockLinkSizeDecision[];
  /** Items this command retires or relinks away, or whose draft it replaces: rows waiting on them are woken in the
   * same transaction (SAF-5, §4.3 step 10). */
  readonly freedItemIds: readonly string[];
}

export type StockLinkControlStatus =
  | { readonly status: "present" }
  | { readonly status: "not_needed" }
  | { readonly status: "needs_read"; readonly itemIds: readonly string[] }
  | { readonly status: "impossible" }
  | { readonly status: "absent" };

export interface StockLinkBatchPlan {
  readonly decisions: readonly StockLinkSizeDecision[];
  readonly commands: readonly StockLinkCommandPlan[];
  /** Holders of an item a size found held (F4), outside this batch: set due now (SAF-5). */
  readonly wakeVariantIds: readonly number[];
  /**
   * The control evidence for retires (SAF-7). `needs_read`: observe `itemIds` and plan again; this plan already
   * treats the control as absent (no retire), so applying it anyway is safe.
   */
  readonly control: StockLinkControlStatus;
  /** set: pause the destination STOCK_LINK_STORE_NOT_ANSWERING; clear: a control answered, lift that pause. */
  readonly pause: "set" | "clear" | null;
  /** Retires the STOCK_LINK_RETIRES_HELD stop kept this tick (the links keep writing). */
  readonly retiresHeld: number;
}

// ---------------------------------------------------------------------------
// The batch decision
// ---------------------------------------------------------------------------

type HolderRole = "active" | "draft";

interface Context {
  readonly sizes: ReadonlyMap<number, StockLinkSizeFacts>;
  readonly skuIndex: ReadonlyMap<string, readonly number[]>;
  /** Normalised item id → the heads that hold it, and as what. */
  readonly holders: ReadonlyMap<string, readonly { readonly productVariantId: number; readonly role: HolderRole }[]>;
  readonly lookedUpKeys: ReadonlySet<string>;
  /** Normalised SKU key → the lookup's items with that SKU. */
  readonly lookupByKey: ReadonlyMap<string, readonly StockLinkStoreItem[]>;
  readonly observations: ReadonlyMap<string, StockLinkStoreItem | null>;
}

type Prelim =
  | { readonly kind: "unread" }
  | { readonly kind: "first" }
  | { readonly kind: "verified"; readonly rule: "V5" | "V6"; readonly storedItemId: string; readonly observed: StockLinkStoreItem;
      readonly recordObservedSku: string | null }
  | { readonly kind: "changed"; readonly rule: "V1" | "V2" | "V3" | "V4" | "V6b"; readonly oldItemId: string | null };

type CandidateOutcome =
  | { readonly kind: "link"; readonly rule: string; readonly choice: StockLinkLinkChoice }
  | { readonly kind: "wait" | "flag" | "transient"; readonly rule: string; readonly code: string;
      readonly waitingItemId: string | null; readonly dueNextTick: boolean; readonly detail: StockLinkDecisionDetail | null;
      readonly wake: readonly number[] };

/**
 * Decide a destination's claimed batch together (§4.2 tables, joint rule V3-8, safety stops V3-5/SAF-7).
 *
 * "Held" ignores an item a changed size of this batch frees (its retire or relink moves the active version away);
 * a swap inside one product becomes one command, a swap across products waits one tick. The safety stops keep a
 * retire without replacement from happening; a kept retire frees nothing, so the plan is re-decided until no new
 * retire is stopped (a stopped set only grows, so this ends).
 */
export function planStockLinkBatch(input: StockLinkBatchInput): StockLinkBatchPlan {
  const context = buildContext(input);
  const prelims = new Map<number, Prelim>();
  for (const size of context.sizes.values()) prelims.set(size.productVariantId, preliminary(size, context));
  const changedIds = new Set([...prelims].filter(([, prelim]) => prelim.kind === "changed").map(([variantId]) => variantId));

  const stopped = new Map<number, "S1" | "S2">();
  let outcomes = decideAll(context, prelims, stopped);
  const firstRetires = retiresWithoutReplacement(outcomes, prelims, stopped);
  const control = controlStatus(input, context, changedIds, firstRetires.length > 0);
  const allowance = Math.max(0, STOCK_LINK_RETIRE_HOLD.limit - nonNegativeCount(input.recentRetireCount));
  let notAnswering = false;
  for (;;) {
    const retires = retiresWithoutReplacement(outcomes, prelims, stopped);
    if (retires.length === 0) break;
    // S1 STORE_NOT_ANSWERING: no control → no retire this tick. With no control possible at all (no other linked
    // item and empty lookups) one retire may proceed (§4.2, residual §16); once the stop fired it stays for the tick.
    if (notAnswering || control.status === "absent" || control.status === "needs_read"
      || (control.status === "impossible" && retires.length > 1)) {
      notAnswering = true;
      for (const variantId of retires) stopped.set(variantId, "S1");
    } else {
      // S2 RETIRES_HELD: the window allows `limit` retires in all; the rest keep their links (lowest variant ids first).
      const held = retires.slice(allowance);
      if (held.length === 0) break;
      for (const variantId of held) stopped.set(variantId, "S2");
    }
    outcomes = decideAll(context, prelims, stopped);
  }

  const decisions = [...context.sizes.values()].map(size => toDecision(size, prelims.get(size.productVariantId)!,
    outcomes.get(size.productVariantId) ?? null, stopped.get(size.productVariantId) ?? null));
  assertDistinctLinks(decisions);
  const wake = new Set<number>();
  for (const [variantId, outcome] of outcomes) {
    if (stopped.has(variantId) || !outcome || outcome.kind === "link") continue;
    for (const holder of outcome.wake) if (!context.sizes.has(holder)) wake.add(holder);
  }
  return Object.freeze({
    decisions: Object.freeze(decisions),
    commands: Object.freeze(groupCommands(decisions, prelims, context)),
    wakeVariantIds: Object.freeze([...wake].sort((a, b) => a - b)),
    control,
    pause: notAnswering ? "set" : control.status === "present" ? "clear" : null,
    retiresHeld: [...stopped.values()].filter(rule => rule === "S2").length,
  });
}

function buildContext(input: StockLinkBatchInput): Context {
  const sizes = new Map<number, StockLinkSizeFacts>();
  for (const size of [...input.sizes].sort((a, b) => a.productVariantId - b.productVariantId)) {
    if (sizes.has(size.productVariantId)) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A stock-link batch names a size twice.",
        { productVariantId: size.productVariantId });
    }
    const cardShellzSku = normalizeStockLinkSku(size.cardShellzSku);
    if (cardShellzSku.kind === "sku" && !cardShellzSku.storable) {
      // Impossible by schema (both SKU columns are varchar(100)); a halt is the answer to impossible state.
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A Card Shellz SKU is longer than 100 characters.",
        { productVariantId: size.productVariantId });
    }
    sizes.set(size.productVariantId, size);
  }
  const holders = new Map<string, { productVariantId: number; role: HolderRole }[]>();
  const hold = (raw: string | null, productVariantId: number, role: HolderRole) => {
    const itemId = normalizeShopifyItemId(raw);
    if (itemId === null) return;
    const entries = holders.get(itemId) ?? [];
    entries.push({ productVariantId, role });
    holders.set(itemId, entries);
  };
  // The DB's one-item rule counts COALESCE(draft, active); an active item behind a pending draft is still the
  // live link the outbox writes, so both hold (BUILD-NOTES D-P2-3).
  for (const head of input.destinationHeads) {
    hold(head.activeItemId, head.productVariantId, "active");
    hold(head.draftItemId, head.productVariantId, "draft");
  }
  const lookedUpKeys = new Set<string>();
  for (const raw of input.reads.lookedUpSkus) {
    const sku = normalizeStockLinkSku(raw);
    if (sku.kind === "sku" && sku.storable) lookedUpKeys.add(sku.key);
  }
  const lookupByKey = new Map<string, StockLinkStoreItem[]>();
  for (const item of input.reads.lookupItems) {
    const sku = normalizeStockLinkSku(item.sku);
    // Only an exact match of a SKU that was asked for is a lookup result; anything else the store returned is not.
    if (sku.kind !== "sku" || !sku.storable || !lookedUpKeys.has(sku.key)) continue;
    const items = lookupByKey.get(sku.key) ?? [];
    if (!items.some(existing => existing.itemId === item.itemId)) items.push(item);
    lookupByKey.set(sku.key, items);
  }
  const observations = new Map<string, StockLinkStoreItem | null>();
  for (const row of input.reads.observations) observations.set(row.itemId, row.item);
  return { sizes, skuIndex: batchSkuIndex(sizes.values(), input.carriedSkus), holders, lookedUpKeys, lookupByKey, observations };
}

/**
 * N6 over the whole destination, with each claimed size's own SKU read for this batch: two claimed sizes that share
 * a SKU are always seen as shared, even if listCarriedSkus was read a moment apart.
 */
function batchSkuIndex(sizes: Iterable<StockLinkSizeFacts>, carriedSkus: readonly StockLinkCarriedSku[]):
  ReadonlyMap<string, readonly number[]> {
  const claimed = [...sizes];
  const claimedIds = new Set(claimed.map(size => size.productVariantId));
  return buildCarriedSkuIndex([
    ...carriedSkus.filter(row => !claimedIds.has(row.productVariantId)),
    ...claimed.filter(size => size.selection.action === "publish" || size.selection.action === "zero")
      .map(size => ({ productVariantId: size.productVariantId, sku: size.cardShellzSku })),
  ]);
}

/** What the tick must read from the store for one claimed size before planStockLinkBatch can decide it. */
export interface StockLinkReadNeed {
  readonly productVariantId: number;
  /** The trimmed Card Shellz SKU to look up, or null when no lookup decides this size (blank, shared, not linkable). */
  readonly lookupSku: string | null;
  /** Saved items to observe by id (normalised decimal ids): the linked item, and the feed hint of a looked-up size. */
  readonly observeItemIds: readonly string[];
}

/**
 * The provider reads that make each claimed size decidable (§7.2 step 5), by the decision's own rules: a size is
 * "read" when its linked item was observed, and, when a lookup decides it, its SKU was looked up and its feed hint
 * observed. A size with an active version may be verified, so it takes the wider (verified) lookup rule. With exactly
 * these reads made, planStockLinkBatch decides every size; a size whose reads did not fit the budget is released busy.
 */
export function planStockLinkReads(input: Pick<StockLinkBatchInput, "sizes" | "carriedSkus">): StockLinkReadNeed[] {
  const sizes = [...input.sizes].sort((a, b) => a.productVariantId - b.productVariantId);
  const context = { skuIndex: batchSkuIndex(sizes, input.carriedSkus) };
  return sizes.map(size => {
    const active = size.head?.active ?? null;
    const observe = new Set<string>();
    const stored = active === null ? null : normalizeShopifyItemId(active.itemId);
    if (stored !== null) observe.add(stored);
    const lookup = needsLookup(size, context, active !== null);
    const hint = lookup ? normalizeShopifyItemId(size.feedHintItemId) : null;
    if (hint !== null) observe.add(hint);
    const sku = normalizeStockLinkSku(size.cardShellzSku);
    return Object.freeze({ productVariantId: size.productVariantId,
      lookupSku: lookup && sku.kind === "sku" ? sku.value : null, observeItemIds: Object.freeze([...observe].sort(compareIds)) });
  });
}

/** A selection the mapping review accepts for a link: publish, or a removed size's zero; no blockers. */
function linkableSelection(size: StockLinkSizeFacts): boolean {
  return (size.selection.action === "publish" || size.selection.action === "zero") && size.selection.blockerCodes.length === 0;
}

/** Whether deciding this size needs the lookup of its Card Shellz SKU (and its feed hint's observation). */
function needsLookup(size: StockLinkSizeFacts, context: Pick<Context, "skuIndex">, verified: boolean): boolean {
  const sku = normalizeStockLinkSku(size.cardShellzSku);
  if (sku.kind !== "sku" || sizesSharingSku(context.skuIndex, sku, size.productVariantId).length > 0) return false;
  return verified || linkableSelection(size);
}

function readsComplete(size: StockLinkSizeFacts, context: Context, verified: boolean): boolean {
  if (!needsLookup(size, context, verified)) return true;
  const sku = normalizeStockLinkSku(size.cardShellzSku);
  if (sku.kind !== "sku" || !context.lookedUpKeys.has(sku.key)) return false;
  const hint = normalizeShopifyItemId(size.feedHintItemId);
  return hint === null || context.observations.has(hint);
}

/** Verify (§4.2 V1-V6) for a size with an active version, or "first" for one without; no candidate is chosen here. */
function preliminary(size: StockLinkSizeFacts, context: Context): Prelim {
  const active = size.head?.active ?? null;
  if (active === null) return readsComplete(size, context, false) ? { kind: "first" } : { kind: "unread" };
  const stored = normalizeShopifyItemId(active.itemId);
  const changed = (rule: "V1" | "V2" | "V3" | "V4" | "V6b"): Prelim =>
    readsComplete(size, context, false) ? { kind: "changed", rule, oldItemId: stored } : { kind: "unread" };
  if (stored === null) return changed("V1");
  if (!context.observations.has(stored)) return { kind: "unread" };
  const observed = context.observations.get(stored) ?? null;
  if (observed === null) return changed("V2");
  const storeSku = normalizeStockLinkSku(observed.sku);
  if (storeSku.kind === "blank") return changed("V3");
  const cardShellzSku = normalizeStockLinkSku(size.cardShellzSku);
  // V4 (V3-6): the item now carries another carried size's SKU, so by the owner's rule it is that size's item.
  if (!stockLinkSkusEqual(storeSku, cardShellzSku) && sizesSharingSku(context.skuIndex, storeSku, size.productVariantId).length > 0)
    return changed("V4");
  const accepted = [active.externalSku, size.cardShellzSku, size.observedSku].map(normalizeStockLinkSku);
  const verified = (rule: "V5" | "V6", recordObservedSku: string | null): Prelim =>
    readsComplete(size, context, true) ? { kind: "verified", rule, storedItemId: stored, observed, recordObservedSku } : { kind: "unread" };
  if (accepted.some(sku => stockLinkSkusEqual(storeSku, sku))) return verified("V5", null);
  // V6 (grandfathered, V3-6): a link made before PR2 with no recorded SKU is kept once, and its store SKU recorded.
  if (normalizeStockLinkSku(active.externalSku).kind === "blank" && normalizeStockLinkSku(size.observedSku).kind === "blank"
    && storeSku.storable) return verified("V6", storeSku.value);
  return changed("V6b");
}

function decideAll(context: Context, prelims: ReadonlyMap<number, Prelim>, stopped: ReadonlyMap<number, string>):
  Map<number, CandidateOutcome | null> {
  // Items this batch frees: the active item of every changed size whose retire is not stopped.
  const freed = new Map<string, number>();
  for (const [variantId, prelim] of prelims) {
    if (prelim.kind === "changed" && prelim.oldItemId !== null && !stopped.has(variantId)) freed.set(prelim.oldItemId, variantId);
  }
  const outcomes = new Map<number, CandidateOutcome | null>();
  for (const size of context.sizes.values()) {
    const prelim = prelims.get(size.productVariantId)!;
    if (prelim.kind === "unread") outcomes.set(size.productVariantId, null);
    else if (prelim.kind === "verified") outcomes.set(size.productVariantId, verifyOutcome(size, prelim, context, freed));
    else outcomes.set(size.productVariantId, candidateOutcome(size, context, freed,
      prelim.kind === "changed" ? prelim.oldItemId : null, prelim.kind === "changed" ? prelim.rule : null));
  }
  return outcomes;
}

interface SettledExtra {
  readonly waitingItemId?: string | null;
  readonly dueNextTick?: boolean;
  readonly detail?: StockLinkDecisionDetail | null;
  readonly wake?: readonly number[];
}

function settled(kind: "wait" | "flag" | "transient", rule: string, code: string, extra: SettledExtra = {}): CandidateOutcome {
  return { kind, rule, code, waitingItemId: extra.waitingItemId ?? null, dueNextTick: extra.dueNextTick ?? false,
    detail: extra.detail ?? null, wake: extra.wake ?? [] };
}

/** The items carrying this size's Card Shellz SKU that the tick saw: lookup ∪ observed hint ∪ observed linked item. */
function skuPool(size: StockLinkSizeFacts, sku: Extract<StockLinkSku, { kind: "sku" }>, context: Context,
  linked: StockLinkStoreItem | null, excludeItemId: string | null) {
  const lookup = (context.lookupByKey.get(sku.key) ?? []).filter(item => item.itemId !== excludeItemId);
  const hintId = normalizeShopifyItemId(size.feedHintItemId);
  const hintObserved = hintId === null ? null : context.observations.get(hintId) ?? null;
  const carries = (item: StockLinkStoreItem | null): item is StockLinkStoreItem =>
    item !== null && item.itemId !== excludeItemId && stockLinkSkusEqual(normalizeStockLinkSku(item.sku), sku);
  const hint = carries(hintObserved) ? hintObserved : null;
  const exact = new Map<string, StockLinkStoreItem>();
  for (const item of [...lookup, ...(hint ? [hint] : []), ...(carries(linked) ? [linked] : [])])
    if (!exact.has(item.itemId)) exact.set(item.itemId, item);
  // SAF-10: the candidates are every on-sale item any read saw, never only what the search returned.
  const candidates = [...exact.values()].filter(isStockLinkItemOnSale).sort((a, b) => compareIds(a.itemId, b.itemId));
  return { lookup, lookupOnSale: lookup.filter(isStockLinkItemOnSale), hint, exactCount: exact.size, candidates };
}

/** Who else holds `itemId`, and whether this batch frees it (only by the active version of a changed size). */
function holdState(size: StockLinkSizeFacts, itemId: string, context: Context, freed: ReadonlyMap<string, number>):
  { blocking: number[]; freeing: number[] } {
  const blocking = new Set<number>();
  const freeing = new Set<number>();
  for (const holder of context.holders.get(itemId) ?? []) {
    if (holder.productVariantId === size.productVariantId) continue;
    if (holder.role === "active" && freed.get(itemId) === holder.productVariantId) freeing.add(holder.productVariantId);
    else blocking.add(holder.productVariantId);
  }
  for (const variantId of blocking) freeing.delete(variantId);
  return { blocking: [...blocking].sort((a, b) => a - b), freeing: [...freeing].sort((a, b) => a - b) };
}

/** The held rule for one chosen item (§4.2 row 7, SAF-5, joint rule V3-8); null when the item is free to link. */
function heldOutcome(size: StockLinkSizeFacts, itemId: string, context: Context, freed: ReadonlyMap<string, number>,
  rule: string): CandidateOutcome | null {
  const { blocking, freeing } = holdState(size, itemId, context, freed);
  if (blocking.length > 0) {
    return settled("flag", rule, D.itemShared, { waitingItemId: itemId, wake: blocking,
      detail: { kind: "ITEM_HELD", itemId, heldByProductVariantIds: blocking } });
  }
  const otherProduct = freeing.filter(variantId => context.sizes.get(variantId)?.productId !== size.productId);
  if (otherProduct.length > 0) {
    return settled("wait", `${rule}b`, D.waitingForFreedItem, { waitingItemId: itemId, dueNextTick: true,
      detail: { kind: "WAITING_FOR_FREED_ITEM", itemId, freedByProductVariantIds: otherProduct } });
  }
  return null;
}

/** The mapping write for a chosen item (§4.2 rows 8-10): promote a draft that already names it, else replace it. */
function linkChoice(size: StockLinkSizeFacts, item: StockLinkStoreItem): StockLinkLinkChoice {
  const storeSku = normalizeStockLinkSku(item.sku);
  if (storeSku.kind !== "sku" || !storeSku.storable) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A chosen store item has no storable SKU.",
      { productVariantId: size.productVariantId, itemId: item.itemId });
  }
  const draft = size.head?.draft ?? null;
  if (draft === null) return { itemId: item.itemId, storeSku: storeSku.value, mappingAction: "create", draft: null };
  const sameDraft = draft.itemId === item.itemId && stockLinkSkusEqual(normalizeStockLinkSku(draft.externalSku), storeSku);
  return { itemId: item.itemId, storeSku: storeSku.value, mappingAction: sameDraft ? "promote_draft" : "replace_draft",
    draft: { mappingId: draft.mappingId, definitionHash: draft.definitionHash } };
}

/** First link (§4.2 rows 1-10), also the replacement search of a changed link (old item excluded). */
function candidateOutcome(size: StockLinkSizeFacts, context: Context, freed: ReadonlyMap<string, number>,
  excludeItemId: string | null, changedRule: string | null): CandidateOutcome {
  const rule = (row: string) => (changedRule ? `${changedRule}/${row}` : row);
  const sku = normalizeStockLinkSku(size.cardShellzSku);
  if (sku.kind !== "sku") return settled("flag", rule("L1"), D.skuBlank);
  const shared = sizesSharingSku(context.skuIndex, sku, size.productVariantId);
  if (shared.length > 0) {
    return settled("flag", rule("L2"), D.itemShared,
      { detail: { kind: "ECHELON_SKU_SHARED", productVariantIds: [size.productVariantId, ...shared].sort((a, b) => a - b) } });
  }
  if (!linkableSelection(size)) {
    return settled("wait", rule("L3"), D.selectionBlocked,
      { detail: { kind: "SELECTION_BLOCKED", action: size.selection.action, blockerCodes: [...size.selection.blockerCodes] } });
  }
  const pool = skuPool(size, sku, context, null, excludeItemId);
  // Row 4: never link on the hint alone. The hint is on sale with this SKU but the search returned no on-sale item:
  // the search missed it (SAF-10, DV4-2; BUILD-NOTES D-P2-4 for an archived-only search result).
  if (pool.lookupOnSale.length === 0 && pool.hint !== null && isStockLinkItemOnSale(pool.hint))
    return settled("transient", rule("L4"), D.lookupMissed, { waitingItemId: null });
  if (pool.candidates.length === 0) {
    const code = pool.exactCount > 0 ? D.notOnSale : D.notListed;
    // V3: the linked item's SKU was erased and nothing replaces it → F2 once retired.
    return changedRule === "V3" ? settled("flag", rule("L5"), D.storeSkuBlank) : settled("wait", rule("L5"), code);
  }
  if (pool.candidates.length >= 2) {
    return settled("flag", rule("L6"), D.skuDuplicate,
      { detail: { kind: "SKU_DUPLICATE", itemIds: pool.candidates.map(item => item.itemId) } });
  }
  const candidate = pool.candidates[0]!;
  const held = heldOutcome(size, candidate.itemId, context, freed, rule("L7"));
  if (held) return held;
  const choice = linkChoice(size, candidate);
  const row = choice.mappingAction === "promote_draft" ? "L8" : choice.mappingAction === "replace_draft" ? "L9" : "L10";
  return { kind: "link", rule: rule(row), choice };
}

/** A correct link (V5/V6), then V7-V10. Every non-link outcome keeps the link writing. */
function verifyOutcome(size: StockLinkSizeFacts, prelim: Extract<Prelim, { kind: "verified" }>, context: Context,
  freed: ReadonlyMap<string, number>): CandidateOutcome | null {
  const sku = normalizeStockLinkSku(size.cardShellzSku);
  // A blank Card Shellz SKU proves nothing new; the link stays and the size is flagged (BUILD-NOTES D-P2-5).
  if (sku.kind !== "sku") return settled("flag", `${prelim.rule}/F1`, D.skuBlank);
  const shared = sizesSharingSku(context.skuIndex, sku, size.productVariantId);
  // V8b before V7: no lookup of a shared SKU is acted on (SAF-3, first-link row 2; BUILD-NOTES D-P2-5).
  if (shared.length > 0) {
    return settled("flag", "V8b", D.itemShared,
      { detail: { kind: "ECHELON_SKU_SHARED", productVariantIds: [size.productVariantId, ...shared].sort((a, b) => a - b) } });
  }
  const linked = prelim.observed;
  const pool = skuPool(size, sku, context, linked, null);
  const linkedOnSale = isStockLinkItemOnSale(linked);
  const others = pool.candidates.filter(item => item.itemId !== prelim.storedItemId);
  if (!linkedOnSale && others.length === 1 && linkableSelection(size)) {
    // V7b, row 4's rule for a relink: never move a link to a copy only the feed hint showed. The search must
    // return the copy itself, or a search that dropped results could hide a second live copy (review LNK-2).
    if (!pool.lookupOnSale.some(item => item.itemId === others[0]!.itemId))
      return settled("transient", "V7b", D.lookupMissed);
    const held = heldOutcome(size, others[0]!.itemId, context, freed, "V7");
    if (held) return held;
    return { kind: "link", rule: "V7", choice: linkChoice(size, others[0]!) };
  }
  if (pool.candidates.length >= 2) {
    return settled("flag", "V8", D.skuDuplicate,
      { detail: { kind: "SKU_DUPLICATE", itemIds: pool.candidates.map(item => item.itemId) } });
  }
  const carriesSku = stockLinkSkusEqual(normalizeStockLinkSku(linked.sku), sku);
  if (linkedOnSale && carriesSku && !pool.lookup.some(item => item.itemId === prelim.storedItemId))
    return settled("transient", "V9", D.lookupMissed);
  // V10: a link saved as a gid is re-pointed to the decimal form of the same item (the outbox writes only that).
  if (size.head!.active!.itemId !== prelim.storedItemId && linkableSelection(size)) {
    // Another head saved the decimal form of the same item: two sizes would hold it (F4, §11.1 gid/decimal pair).
    return heldOutcome(size, prelim.storedItemId, context, freed, "V10") ?? { kind: "link", rule: "V10", choice: linkChoice(size, linked) };
  }
  return null;
}

/** Changed sizes of the plan that retire without a replacement and are not stopped, in variant-id order. */
function retiresWithoutReplacement(outcomes: ReadonlyMap<number, CandidateOutcome | null>,
  prelims: ReadonlyMap<number, Prelim>, stopped: ReadonlyMap<number, string>): number[] {
  return [...prelims].filter(([variantId, prelim]) => prelim.kind === "changed" && !stopped.has(variantId)
    && outcomes.get(variantId)?.kind !== "link").map(([variantId]) => variantId).sort((a, b) => a - b);
}

/**
 * SAF-7: a control is a lookup that returned any item, or a linked item outside the changed set observed present.
 * The changed set (every size this tick found changed, relinks included) is a superset of the retiring set, so an
 * item that is itself being moved never vouches for the store (BUILD-NOTES D-P2-7).
 */
function controlStatus(input: StockLinkBatchInput, context: Context, changedIds: ReadonlySet<number>,
  retiresNeeded: boolean): StockLinkControlStatus {
  const outside = input.destinationHeads
    .filter(head => !changedIds.has(head.productVariantId))
    .map(head => ({ productVariantId: head.productVariantId, itemId: normalizeShopifyItemId(head.activeItemId) }))
    .filter((head): head is { productVariantId: number; itemId: string } => head.itemId !== null)
    .sort((a, b) => a.productVariantId - b.productVariantId);
  if (input.reads.lookupItems.length > 0 || outside.some(head => (context.observations.get(head.itemId) ?? null) !== null))
    return { status: "present" };
  if (!retiresNeeded) return { status: "not_needed" };
  if (outside.length === 0) return { status: "impossible" };
  const unread = outside.filter(head => !context.observations.has(head.itemId));
  if (unread.length > 0 && !input.reads.controlReadDone) {
    return { status: "needs_read", itemIds: [...new Set(unread.map(head => head.itemId))].slice(0, STOCK_LINK_CONTROL_READ_MAX) };
  }
  return { status: "absent" };
}

function toDecision(size: StockLinkSizeFacts, prelim: Prelim, outcome: CandidateOutcome | null,
  stop: "S1" | "S2" | null): StockLinkSizeDecision {
  const base = {
    productVariantId: size.productVariantId, productId: size.productId,
    expectedHeadRevision: size.head?.revision ?? "0",
    cardShellzSku: (() => { const sku = normalizeStockLinkSku(size.cardShellzSku); return sku.kind === "sku" ? sku.value : null; })(),
    selectionAction: size.selection.action,
    link: null, replacesMappingId: null, waitingItemId: null, dueNextTick: false, recordObservedSku: null, detail: null,
  } as const;
  const activeId = size.head?.active?.mappingId ?? null;
  if (prelim.kind === "unread") {
    return { ...base, change: "none", status: "unchanged", code: D.notRead, retry: "busy", rule: "unread" };
  }
  if (stop !== null) {
    // The retire is not made: the link keeps writing. S1 releases the row (the destination pauses); S2 waits for Continue.
    return { ...base, change: "none", status: "unchanged", code: stop === "S1" ? D.storeNotAnswering : D.retiresHeld,
      retry: stop === "S1" ? "busy" : null, rule: `${prelim.kind === "changed" ? prelim.rule : prelim.kind}/${stop}` };
  }
  if (prelim.kind === "verified") {
    const recordObservedSku = prelim.recordObservedSku;
    if (outcome === null) return { ...base, change: "none", status: "linked", code: null, retry: null, recordObservedSku, rule: prelim.rule };
    if (outcome.kind === "link") {
      return { ...base, change: "relink", status: "linked", code: null, retry: null, link: outcome.choice,
        replacesMappingId: activeId, recordObservedSku: null, rule: outcome.rule };
    }
    // Kept: flags keep writing (V8, V8b), a self-check miss retries (V9), a held replacement waits.
    return { ...base, change: "none", status: outcome.kind === "flag" ? "flagged" : "linked", code: outcome.code,
      retry: outcome.kind === "transient" ? "transient" : null, waitingItemId: outcome.waitingItemId,
      dueNextTick: outcome.dueNextTick, recordObservedSku, detail: outcome.detail, rule: outcome.rule };
  }
  const changed = prelim.kind === "changed";
  if (outcome!.kind === "link") {
    return { ...base, change: changed ? "relink" : "link", status: "linked", code: null, retry: null,
      link: outcome!.choice, replacesMappingId: changed ? activeId : null, rule: outcome!.rule };
  }
  const settledOutcome = outcome as Exclude<CandidateOutcome, { kind: "link" }>;
  return { ...base, change: changed ? "retire" : "none", status: settledOutcome.kind === "flag" ? "flagged" : "waiting",
    code: settledOutcome.code, retry: settledOutcome.kind === "transient" ? "transient" : null,
    replacesMappingId: changed ? activeId : null, waitingItemId: settledOutcome.waitingItemId,
    dueNextTick: settledOutcome.dueNextTick, detail: settledOutcome.detail, rule: settledOutcome.rule };
}

/** Two sizes can never be linked to one item (the DB refuses it at commit); a plan that would is a broken invariant. */
function assertDistinctLinks(decisions: readonly StockLinkSizeDecision[]): void {
  const seen = new Map<string, number>();
  for (const decision of decisions) {
    if (!decision.link) continue;
    const other = seen.get(decision.link.itemId);
    if (other !== undefined) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "Two sizes of one batch chose the same store item.",
        { itemId: decision.link.itemId, productVariantIds: [other, decision.productVariantId] });
    }
    seen.set(decision.link.itemId, decision.productVariantId);
  }
}

function groupCommands(decisions: readonly StockLinkSizeDecision[], prelims: ReadonlyMap<number, Prelim>,
  context: Context): StockLinkCommandPlan[] {
  const byProduct = new Map<number, StockLinkSizeDecision[]>();
  for (const decision of decisions) {
    if (decision.change === "none") continue;
    const members = byProduct.get(decision.productId) ?? [];
    members.push(decision);
    byProduct.set(decision.productId, members);
  }
  return [...byProduct].sort(([a], [b]) => a - b).map(([productId, members]) => {
    if (members.length > STOCK_LINK_COMMAND_MEMBERS_MAX) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A stock-link command has too many members.",
        { productId, members: members.length });
    }
    const freed = new Set<string>();
    for (const member of members) {
      const prelim = prelims.get(member.productVariantId);
      const old = prelim?.kind === "changed" ? prelim.oldItemId
        : prelim?.kind === "verified" && member.change === "relink" ? prelim.storedItemId : null;
      // V10 re-points the same item: nothing is freed.
      if (old !== null && old !== member.link?.itemId) freed.add(old);
      // A replaced draft stops holding its item too (the one-item rule counts COALESCE(draft, active)).
      const draftItem = member.link?.mappingAction === "replace_draft"
        ? normalizeShopifyItemId(context.sizes.get(member.productVariantId)?.head?.draft?.itemId) : null;
      if (draftItem !== null && draftItem !== member.link?.itemId) freed.add(draftItem);
    }
    return Object.freeze({
      productId,
      purpose: members.some(member => member.selectionAction === "zero") ? "sync" as const : "publish" as const,
      members: Object.freeze([...members]),
      freedItemIds: Object.freeze([...freed].sort(compareIds)),
    });
  });
}

/** Decimal ids by numeric value (same length first), so plans list items in one stable order. */
function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function nonNegativeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "The recent retire count must be a whole number.", { value });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Safety stop windows (TST-8)
// ---------------------------------------------------------------------------

/** Start of the retire-hold window: max(now − windowHours, retires_released_at). `now` is the injected clock. */
export function stockLinkRetireWindowStart(now: Date, releasedAt: Date | null): Date {
  const start = now.getTime() - STOCK_LINK_RETIRE_HOLD.windowHours * HOUR_MS;
  return new Date(releasedAt && releasedAt.getTime() > start ? releasedAt.getTime() : start);
}

// ---------------------------------------------------------------------------
// Retry schedule (§4.6, §10)
// ---------------------------------------------------------------------------

export const STOCK_LINK_RETRY = Object.freeze({
  /** Busy: 60-180 s, jittered so released rows do not all return in one tick. */
  busyMinMs: 60_000,
  busyMaxMs: 180_000,
  /** Transient: 10 min × 2^(n−1), at most 24 h, never earlier than the provider's Retry-After. */
  transientBaseMs: 10 * MINUTE_MS,
  transientMaxMs: DAY_MS,
  /** Waits (not listed, not on sale, selection blocked): 15 min doubling to 24 h. */
  waitBaseMs: 15 * MINUTE_MS,
  waitMaxMs: DAY_MS,
  /** Destination pause: 15 min doubling to 24 h. */
  pauseBaseMs: 15 * MINUTE_MS,
  pauseMaxMs: DAY_MS,
  /** A linked or flagged row is re-observed daily. */
  verifyIntervalMs: DAY_MS,
});

/** The injected randomness: a value in [0, 1), like Math.random. */
export type StockLinkRandom = () => number;

function unitRandom(random: StockLinkRandom): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "The injected random value must be in [0, 1).", { value });
  }
  return value;
}

/** Busy: due again in 60-180 s (inclusive), from the injected random. No attempt is counted. */
export function stockLinkBusyDelayMs(random: StockLinkRandom): number {
  const span = STOCK_LINK_RETRY.busyMaxMs - STOCK_LINK_RETRY.busyMinMs;
  return STOCK_LINK_RETRY.busyMinMs + Math.floor(unitRandom(random) * (span + 1));
}

/** Transient after the n-th attempt of a streak (n ≥ 1): max(min(10 min × 2^(n−1), 24 h), Retry-After). */
export function stockLinkTransientDelayMs(attemptCount: number, retryAfterMs: number | null = null): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A transient attempt count starts at 1.", { attemptCount });
  }
  const backoff = Math.min(STOCK_LINK_RETRY.transientBaseMs * 2 ** Math.min(attemptCount - 1, 32), STOCK_LINK_RETRY.transientMaxMs);
  return retryAfterMs !== null && Number.isSafeInteger(retryAfterMs) && retryAfterMs > backoff ? retryAfterMs : backoff;
}

/**
 * A wait that repeats: twice the previous interval (the row's next_check_at − updated_at of the same wait), from
 * 15 min to 24 h. A new wait, or one woken early (a feed change, a freed item), starts again at 15 min.
 */
export function stockLinkWaitDelayMs(previousIntervalMs: number | null): number {
  if (previousIntervalMs === null || !Number.isFinite(previousIntervalMs) || previousIntervalMs < STOCK_LINK_RETRY.waitBaseMs)
    return STOCK_LINK_RETRY.waitBaseMs;
  return Math.min(Math.floor(previousIntervalMs) * 2, STOCK_LINK_RETRY.waitMaxMs);
}

/**
 * A destination pause lasts as long as it has already lasted (so the total doubles), from 15 min to 24 h, measured
 * from `paused_since` with the injected clock.
 */
export function stockLinkPauseDelayMs(pausedSince: Date | null, now: Date): number {
  const elapsed = pausedSince === null ? 0 : now.getTime() - pausedSince.getTime();
  return Math.min(Math.max(STOCK_LINK_RETRY.pauseBaseMs, Number.isFinite(elapsed) ? elapsed : 0), STOCK_LINK_RETRY.pauseMaxMs);
}

/** A newly found linked size's first verify, spread over the next 24 h so a backlog is not read in one tick. */
export function stockLinkFirstVerifyDelayMs(random: StockLinkRandom): number {
  return Math.floor(unitRandom(random) * STOCK_LINK_RETRY.verifyIntervalMs);
}

// ---------------------------------------------------------------------------
// Keys (v3 3.4 Keys + SAF-2)
// ---------------------------------------------------------------------------

/** Fixed root namespace of the engine's UUIDv5 command keys (each policy derives its own from it). */
const STOCK_LINK_COMMAND_NAMESPACE = Buffer.from("c67561be42647c706520873cd3209d4a", "hex");

/** RFC 4122 UUIDv5 (SHA-1, name-based), as the other IP command keys (domain/dropship-ebay-stock-readiness.ts). */
function uuidV5Bytes(namespace: Buffer, name: string): Buffer {
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Buffer.from(bytes);
}

function uuidText(bytes: Buffer): string {
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** One command member as the keys see it. */
export interface StockLinkKeyMember {
  readonly productVariantId: number;
  /** The Card Shellz SKU the command re-confirms under lock (trimmed), or null. */
  readonly cardShellzSku: string | null;
  /** The chosen store item, or null for a retire-only member. */
  readonly itemId: string | null;
  readonly storeSku: string | null;
  readonly mappingAction: StockLinkMappingAction | "none";
  readonly draftMappingId: number | null;
  readonly replacesMappingId: number | null;
  /** SAF-2: the head revision the decision read ("0" = no head). Every link, retire or draft write moves it. */
  readonly expectedHeadRevision: string;
}

const byVariant = (members: readonly StockLinkKeyMember[]) =>
  [...members].sort((a, b) => a.productVariantId - b.productVariantId);

/** Covers what the store showed and what the command will write: chosen items, both SKUs, replaced versions. */
export function stockLinkLookupHash(members: readonly StockLinkKeyMember[]): string {
  return sha256(byVariant(members).map(member => ({ productVariantId: member.productVariantId,
    cardShellzSku: member.cardShellzSku, itemId: member.itemId, storeSku: member.storeSku,
    replacesMappingId: member.replacesMappingId })));
}

/**
 * The background origin key: `<variantId>@<headRevision>,…:<lookupHash>` (v3 + SAF-2). The head revision makes
 * link → retire → re-link of the same item a new command: a replay of one head state reuses its key and receipt,
 * a new head state never collides with an old receipt (no false COMMAND_CONFLICT or LINK_CHANGED_AFTER_APPLY).
 */
export function stockLinkBackgroundOriginKey(members: readonly StockLinkKeyMember[]): string {
  const sizes = byVariant(members).map(member => `${member.productVariantId}@${member.expectedHeadRevision}`).join(",");
  return `${sizes}:${stockLinkLookupHash(members)}`;
}

/** UUIDv5 under the policy's namespace (destination kind + provider) of {targetId, originKind, originKey}. */
export function stockLinkCommandKey(input: {
  destinationKind: string; providerKey: string; publicationTargetId: number; originKind: string; originKey: string;
}): string {
  const namespace = uuidV5Bytes(STOCK_LINK_COMMAND_NAMESPACE, `${input.destinationKind}:${input.providerKey}`);
  return uuidText(uuidV5Bytes(namespace, canonicalJson({
    publicationTargetId: input.publicationTargetId, originKind: input.originKind, originKey: input.originKey,
  })));
}

/** Binds a command key to its exact request: the same key with anything else is STOCK_MAPPING_COMMAND_CONFLICT. */
export function stockLinkRequestHash(input: {
  publicationTargetId: number; productId: number; purpose: StockLinkPurpose; members: readonly StockLinkKeyMember[]; actor: string;
}): string {
  return sha256({ publicationTargetId: input.publicationTargetId, productId: input.productId, purpose: input.purpose,
    members: byVariant(input.members), actor: input.actor });
}

/** `<prefix>:<commandKey>`: the command lock string, the engine's receipt key and the mapping-preparation key. */
export const stockLinkPreparationKey = (prefix: string, commandKey: string): string => `${prefix}:${commandKey}`;
/** `<prefix>:<commandKey>:<variantId>`: each draft's idempotency key (exact-ebay-sku-mapping.apply.ts template). */
export const stockLinkDraftKey = (prefix: string, commandKey: string, productVariantId: number): string =>
  `${prefix}:${commandKey}:${productVariantId}`;

/** The key members of a planned command. */
export function stockLinkKeyMembers(command: StockLinkCommandPlan): StockLinkKeyMember[] {
  return command.members.map(member => ({
    productVariantId: member.productVariantId, cardShellzSku: member.cardShellzSku,
    itemId: member.link?.itemId ?? null, storeSku: member.link?.storeSku ?? null,
    mappingAction: member.link?.mappingAction ?? "none", draftMappingId: member.link?.draft?.mappingId ?? null,
    replacesMappingId: member.replacesMappingId, expectedHeadRevision: member.expectedHeadRevision,
  }));
}

export interface StockLinkCommandIdentity {
  readonly originKind: "background";
  readonly originKey: string;
  readonly lookupHash: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly preparationKey: string;
}

/** Every key of one background command (§4.3 steps 3, 8, 10), from its plan, destination and actor. */
export function stockLinkCommandIdentity(input: {
  destination: { destinationKind: string; providerKey: string; publicationTargetId: number };
  command: StockLinkCommandPlan; actor: string; prefix?: string;
}): StockLinkCommandIdentity {
  const members = stockLinkKeyMembers(input.command);
  const originKey = stockLinkBackgroundOriginKey(members);
  const commandKey = stockLinkCommandKey({ ...input.destination, originKind: "background", originKey });
  return Object.freeze({
    originKind: "background", originKey, lookupHash: stockLinkLookupHash(members), commandKey,
    requestHash: stockLinkRequestHash({ publicationTargetId: input.destination.publicationTargetId,
      productId: input.command.productId, purpose: input.command.purpose, members, actor: input.actor }),
    preparationKey: stockLinkPreparationKey(input.prefix ?? STOCK_LINK_KEY_PREFIX, commandKey),
  });
}
