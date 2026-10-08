import type { DropshipClock } from "./dropship-ports";

/**
 * Side PR S1: the listing preview checks that the return and payment policy
 * ids a listing would send still exist on the vendor's eBay account, the way
 * it already checks the shipping (fulfillment) policy id.
 *
 * eBay lists a marketplace's return and payment policies in two calls however
 * many ids are checked, and an id missing from the list is clear evidence it
 * is gone. The preview runs for a vendor's preview, for each queue, and again
 * for every listing at push time, so the lists are reused for a short time per
 * store (design 8.12 already accepts eBay-dependent checks up to 5 minutes
 * old). A cached list is only trusted to say an id exists: an id it lacks is
 * re-checked against a fresh list before it is reported missing, so a policy
 * created a moment ago is never blocked by a stale list.
 */

/** The ids a store's eBay account lists for one marketplace. */
export interface DropshipEbayReturnPaymentPolicyIds {
  returnPolicyIds: ReadonlySet<string>;
  paymentPolicyIds: ReadonlySet<string>;
}

export interface DropshipEbayReturnPaymentPolicyStoreInput {
  vendorId: number;
  storeConnectionId: number;
  marketplaceId: string;
}

/** Reads the lists from eBay. Throws a DropshipError when eBay cannot be read. */
export interface DropshipEbayReturnPaymentPolicyDirectory {
  listReturnAndPaymentPolicyIds(
    input: DropshipEbayReturnPaymentPolicyStoreInput,
  ): Promise<DropshipEbayReturnPaymentPolicyIds>;
}

export interface DropshipEbayReturnPaymentPolicyCheckInput extends DropshipEbayReturnPaymentPolicyStoreInput {
  returnPolicyIds: readonly string[];
  paymentPolicyIds: readonly string[];
}

/** The checked ids that the store's eBay account does not list. */
export interface DropshipEbayReturnPaymentPolicyCheckResult {
  missingReturnPolicyIds: ReadonlySet<string>;
  missingPaymentPolicyIds: ReadonlySet<string>;
}

export interface DropshipEbayReturnPaymentPolicyChecker {
  check(input: DropshipEbayReturnPaymentPolicyCheckInput): Promise<DropshipEbayReturnPaymentPolicyCheckResult>;
}

/** How long a store's lists are reused. */
export const EBAY_RETURN_PAYMENT_POLICY_LIST_TTL_MS = 60_000;
/** Stores kept at once; the oldest is dropped first. Far above the number of connected stores. */
export const EBAY_RETURN_PAYMENT_POLICY_LIST_MAX_STORES = 1_000;

interface CachedPolicyLists {
  lists: DropshipEbayReturnPaymentPolicyIds;
  readAtMs: number;
}

/**
 * Checks ids against a store's lists, reusing a list for up to `ttlMs`. Only
 * successful reads are kept, so an eBay failure is retried on the next check.
 * Concurrent checks for one store share one read.
 */
export class CachingDropshipEbayReturnPaymentPolicyChecker implements DropshipEbayReturnPaymentPolicyChecker {
  private readonly cache = new Map<string, CachedPolicyLists>();
  private readonly inFlight = new Map<string, Promise<DropshipEbayReturnPaymentPolicyIds>>();

  constructor(private readonly deps: {
    directory: DropshipEbayReturnPaymentPolicyDirectory;
    clock: DropshipClock;
    ttlMs?: number;
    maxStores?: number;
  }) {}

  async check(input: DropshipEbayReturnPaymentPolicyCheckInput): Promise<DropshipEbayReturnPaymentPolicyCheckResult> {
    if (input.returnPolicyIds.length === 0 && input.paymentPolicyIds.length === 0) {
      return { missingReturnPolicyIds: new Set(), missingPaymentPolicyIds: new Set() };
    }
    const store = {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      marketplaceId: input.marketplaceId,
    };
    const cached = this.freshCachedLists(store);
    if (cached) {
      const result = missingPolicyIds(cached, input);
      if (result.missingReturnPolicyIds.size === 0 && result.missingPaymentPolicyIds.size === 0) return result;
    }
    return missingPolicyIds(await this.read(store), input);
  }

  private freshCachedLists(store: DropshipEbayReturnPaymentPolicyStoreInput): DropshipEbayReturnPaymentPolicyIds | null {
    const entry = this.cache.get(cacheKey(store));
    if (!entry) return null;
    const ageMs = this.deps.clock.now().getTime() - entry.readAtMs;
    // A clock that moved backwards makes the age negative; such an entry is not trusted.
    if (ageMs < 0 || ageMs >= (this.deps.ttlMs ?? EBAY_RETURN_PAYMENT_POLICY_LIST_TTL_MS)) return null;
    return entry.lists;
  }

  private read(store: DropshipEbayReturnPaymentPolicyStoreInput): Promise<DropshipEbayReturnPaymentPolicyIds> {
    const key = cacheKey(store);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const read = this.deps.directory.listReturnAndPaymentPolicyIds(store)
      .then((lists) => {
        this.remember(key, lists);
        return lists;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, read);
    return read;
  }

  private remember(key: string, lists: DropshipEbayReturnPaymentPolicyIds): void {
    this.cache.delete(key);
    this.cache.set(key, { lists, readAtMs: this.deps.clock.now().getTime() });
    const maxStores = this.deps.maxStores ?? EBAY_RETURN_PAYMENT_POLICY_LIST_MAX_STORES;
    while (this.cache.size > maxStores) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

function cacheKey(store: DropshipEbayReturnPaymentPolicyStoreInput): string {
  return `${store.vendorId}:${store.storeConnectionId}:${store.marketplaceId}`;
}

function missingPolicyIds(
  lists: DropshipEbayReturnPaymentPolicyIds,
  input: Pick<DropshipEbayReturnPaymentPolicyCheckInput, "returnPolicyIds" | "paymentPolicyIds">,
): DropshipEbayReturnPaymentPolicyCheckResult {
  return {
    missingReturnPolicyIds: new Set(input.returnPolicyIds.filter((id) => !lists.returnPolicyIds.has(id))),
    missingPaymentPolicyIds: new Set(input.paymentPolicyIds.filter((id) => !lists.paymentPolicyIds.has(id))),
  };
}
