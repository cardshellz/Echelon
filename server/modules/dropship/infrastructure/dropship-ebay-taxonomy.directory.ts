import {
  EBAY_CATEGORY_ID_PATTERN,
  MAX_EBAY_CATEGORY_CHILDREN,
  MAX_EBAY_CATEGORY_NAME_LENGTH,
  MAX_EBAY_CATEGORY_PATH_DEPTH,
  MAX_EBAY_CATEGORY_SEARCH_RESULTS,
  type EbayCategoryBrowseResult,
  type EbayCategoryOption,
} from "../../../../shared/dropship/ebay-category-rules";
import {
  EBAY_CATEGORIES_PERMISSION_REQUIRED,
  type EbayCategoryIdentity,
  type EbayCategoryTaxonomy,
} from "../application/dropship-ebay-category-rules-service";
import type { DropshipClock, DropshipLogger } from "../application/dropship-ports";
import { DropshipError } from "../domain/errors";
import {
  resolveDropshipEbayProviderEnvironment,
  type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";
import { ebayResourceErrorIdentifiers, withEbaySafeReadRecovery } from "./dropship-ebay-safe-read-recovery";
import type { DropshipMarketplaceStoreCredentials } from "./dropship-marketplace-credentials";

type FetchLike = typeof fetch;
type ProviderEnvironment = "sandbox" | "production";

const EBAY_TAXONOMY_BASE_URLS: Record<ProviderEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};
/** The eBay US category tree. The admin taxonomy routes read the same tree (server/routes/ebay/ebay-taxonomy.routes.ts). */
export const EBAY_US_CATEGORY_TREE_ID = "0";
/** The tree changes rarely; one download per process per day keeps every browse and check local. */
export const EBAY_CATEGORY_TREE_TTL_MS = 24 * 60 * 60 * 1000;
/** Under Heroku's 30-second router limit, so a slow eBay answer fails cleanly inside the request. */
export const EBAY_CATEGORY_TREE_TIMEOUT_MS = 25_000;
export const EBAY_CATEGORY_SEARCH_TIMEOUT_MS = 10_000;
/** Bounds on an untrusted provider document. HYPOTHESIS: the real eBay US tree sits well inside both. */
export const MAX_EBAY_CATEGORY_TREE_BYTES = 128 * 1024 * 1024;
export const MAX_EBAY_CATEGORY_TREE_NODES = 100_000;
const MAX_EBAY_CATEGORY_SEARCH_BYTES = 1024 * 1024;
const MAX_EBAY_ERROR_BODY_BYTES = 64 * 1024;

interface CategoryNode {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly parentId: string | null;
  readonly childIds: string[];
  /** False whenever eBay listed children, even if some of them were dropped as invalid. */
  readonly leaf: boolean;
}

export interface EbayCategoryTreeIndex {
  readonly treeVersion: string | null;
  readonly topLevelIds: readonly string[];
  readonly nodes: ReadonlyMap<string, CategoryNode>;
  /** Nodes left out, with their subtrees, because eBay sent an invalid or duplicate entry. */
  readonly skippedNodes: number;
}

interface TreeFlight {
  readonly storeConnectionId: number;
  readonly promise: Promise<EbayCategoryTreeIndex>;
}

/**
 * eBay's category tree read with each vendor's own eBay connection. The whole
 * US tree is downloaded once per day per process and kept as an index, so
 * browsing, paths and leaf checks never call eBay again. Search asks eBay for
 * its own suggestions and maps them onto the index.
 */
export class EbayDropshipCategoryTaxonomy implements EbayCategoryTaxonomy {
  private readonly trees = new Map<ProviderEnvironment, { index: EbayCategoryTreeIndex; loadedAtMs: number }>();
  private readonly flights = new Map<ProviderEnvironment, TreeFlight>();
  private readonly fetchFn: FetchLike;

  constructor(private readonly deps: {
    credentials: DropshipEbayRegistrationCredentialProvider;
    clock: DropshipClock;
    logger: DropshipLogger;
    fetchFn?: FetchLike;
  }) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async search(identity: EbayCategoryIdentity, query: string): Promise<EbayCategoryOption[]> {
    return this.withCredential(identity, "category_search", async (credential) => {
      const environment = resolveDropshipEbayProviderEnvironment(credential);
      const index = await this.treeIndex(identity, environment, credential);
      const text = await this.get(credential, environment,
        `/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}/get_category_suggestions?q=${encodeURIComponent(query)}`,
        { identity, operation: "category_search", timeoutMs: EBAY_CATEGORY_SEARCH_TIMEOUT_MS, maxBytes: MAX_EBAY_CATEGORY_SEARCH_BYTES });
      const options: EbayCategoryOption[] = [];
      let outsideTree = 0;
      for (const categoryId of text === null ? [] : parseEbayCategorySuggestionIds(text, identity.storeConnectionId)) {
        const option = categoryOption(index, categoryId);
        if (option) options.push(option);
        else outsideTree += 1;
        if (options.length === MAX_EBAY_CATEGORY_SEARCH_RESULTS) break;
      }
      if (outsideTree > 0) {
        this.deps.logger.info({
          code: "DROPSHIP_EBAY_CATEGORY_SUGGESTIONS_OUTSIDE_TREE",
          message: "eBay suggested categories the cached category tree does not contain; they were left out.",
          context: { ...identity, outsideTree, treeVersion: index.treeVersion },
        });
      }
      return options;
    });
  }

  async describe(identity: EbayCategoryIdentity, categoryIds: readonly string[]): Promise<Map<string, EbayCategoryOption>> {
    return this.withCredential(identity, "category_describe", async (credential) => {
      const index = await this.treeIndex(identity, resolveDropshipEbayProviderEnvironment(credential), credential);
      const found = new Map<string, EbayCategoryOption>();
      for (const categoryId of categoryIds) {
        const option = categoryOption(index, categoryId);
        if (option) found.set(categoryId, option);
      }
      return found;
    });
  }

  async browse(identity: EbayCategoryIdentity, parentId: string | null): Promise<EbayCategoryBrowseResult | null> {
    return this.withCredential(identity, "category_browse", async (credential) => {
      const index = await this.treeIndex(identity, resolveDropshipEbayProviderEnvironment(credential), credential);
      const parent = parentId === null ? null : categoryOption(index, parentId);
      if (parentId !== null && !parent) return null;
      const childIds = parentId === null ? index.topLevelIds : index.nodes.get(parentId)?.childIds ?? [];
      if (childIds.length > MAX_EBAY_CATEGORY_CHILDREN) {
        this.deps.logger.warn({
          code: "DROPSHIP_EBAY_CATEGORY_CHILDREN_TRUNCATED",
          message: "An eBay category has more direct children than the browse view returns.",
          context: { ...identity, parentId, childCount: childIds.length, returned: MAX_EBAY_CATEGORY_CHILDREN },
        });
      }
      const children = childIds.slice(0, MAX_EBAY_CATEGORY_CHILDREN)
        .map((childId) => categoryOption(index, childId))
        .filter((option): option is EbayCategoryOption => option !== null);
      return { parent, children };
    });
  }

  private withCredential<T>(
    identity: EbayCategoryIdentity,
    operation: string,
    read: (credential: DropshipMarketplaceStoreCredentials) => Promise<T>,
  ): Promise<T> {
    return withEbaySafeReadRecovery({
      credentials: this.deps.credentials,
      vendorId: identity.vendorId,
      storeConnectionId: identity.storeConnectionId,
      operation,
      reauthorizationCode: EBAY_CATEGORIES_PERMISSION_REQUIRED,
      read,
    });
  }

  private async treeIndex(
    identity: EbayCategoryIdentity,
    environment: ProviderEnvironment,
    credential: DropshipMarketplaceStoreCredentials,
  ): Promise<EbayCategoryTreeIndex> {
    const cached = this.trees.get(environment);
    if (cached && this.nowMs() - cached.loadedAtMs < EBAY_CATEGORY_TREE_TTL_MS) return cached.index;
    const flight = this.flights.get(environment) ?? this.startTreeLoad(identity, environment, credential);
    try {
      return await flight.promise;
    } catch (error) {
      if (flight.storeConnectionId !== identity.storeConnectionId && !isProviderSideFailure(error)) {
        // Another store's credential failing says nothing about this store's; load with this store's own.
        try {
          return await this.startTreeLoad(identity, environment, credential).promise;
        } catch (ownError) {
          return this.staleOrThrow(cached, ownError, identity);
        }
      }
      return this.staleOrThrow(cached, error, identity);
    }
  }

  private startTreeLoad(
    identity: EbayCategoryIdentity,
    environment: ProviderEnvironment,
    credential: DropshipMarketplaceStoreCredentials,
  ): TreeFlight {
    const startedMs = this.nowMs();
    const promise = this.get(credential, environment, `/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}`,
      { identity, operation: "category_tree", timeoutMs: EBAY_CATEGORY_TREE_TIMEOUT_MS, maxBytes: MAX_EBAY_CATEGORY_TREE_BYTES })
      .then((text) => {
        if (text === null) throw invalidResponse(identity.storeConnectionId, "eBay returned an empty category tree.");
        const index = parseEbayCategoryTree(text, identity.storeConnectionId);
        this.trees.set(environment, { index, loadedAtMs: this.nowMs() });
        this.deps.logger.info({
          code: "DROPSHIP_EBAY_CATEGORY_TREE_LOADED",
          message: "eBay category tree loaded.",
          context: { ...identity, environment, nodeCount: index.nodes.size, skippedNodes: index.skippedNodes,
            treeVersion: index.treeVersion, bytes: text.length, durationMs: this.nowMs() - startedMs },
        });
        if (index.skippedNodes > 0) {
          this.deps.logger.warn({
            code: "DROPSHIP_EBAY_CATEGORY_TREE_NODES_SKIPPED",
            message: "eBay category tree entries were invalid and left out with their subtrees.",
            context: { ...identity, environment, skippedNodes: index.skippedNodes, treeVersion: index.treeVersion },
          });
        }
        return index;
      });
    const flight: TreeFlight = { storeConnectionId: identity.storeConnectionId, promise };
    this.flights.set(environment, flight);
    const clear = () => { if (this.flights.get(environment) === flight) this.flights.delete(environment); };
    promise.then(clear, clear);
    return flight;
  }

  /** Only a provider-side failure may fall back to yesterday's tree; a credential failure must reach the vendor. */
  private staleOrThrow(
    cached: { index: EbayCategoryTreeIndex; loadedAtMs: number } | undefined,
    error: unknown,
    identity: EbayCategoryIdentity,
  ): EbayCategoryTreeIndex {
    if (cached && isProviderSideFailure(error)) {
      this.deps.logger.warn({
        code: "DROPSHIP_EBAY_CATEGORY_TREE_STALE",
        message: "eBay category tree refresh failed; the previous tree is still served.",
        context: { ...identity, ageMinutes: Math.floor((this.nowMs() - cached.loadedAtMs) / 60_000),
          errorCode: error instanceof DropshipError ? error.code : undefined },
      });
      return cached.index;
    }
    throw error;
  }

  private async get(
    credential: DropshipMarketplaceStoreCredentials,
    environment: ProviderEnvironment,
    path: string,
    options: { identity: EbayCategoryIdentity; operation: string; timeoutMs: number; maxBytes: number },
  ): Promise<string | null> {
    const { storeConnectionId } = options.identity;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${EBAY_TAXONOMY_BASE_URLS[environment]}${path}`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Accept-Language": "en-US",
            "Content-Language": "en-US",
            Authorization: `Bearer ${credential.accessToken}`,
          },
        });
      } catch (error) {
        throw unavailable(storeConnectionId, options.operation, { retryable: true, errorName: errorName(error) });
      }
      if (response.status === 204) return null;
      if (!response.ok) {
        const body = await readBoundedText(response, MAX_EBAY_ERROR_BODY_BYTES).catch(() => null);
        const denied = response.status === 401 || response.status === 403;
        throw new DropshipError(
          denied ? "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED" : "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE",
          denied
            ? "eBay refused category access for this store's connection. Card Shellz support has to check the eBay application permissions."
            : "eBay categories could not be loaded. Try again shortly.",
          {
            storeConnectionId,
            operation: options.operation,
            status: response.status,
            ...(body ? ebayResourceErrorIdentifiers(body) : { providerErrorIds: [] }),
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }
      let text: string | null;
      try {
        text = await readBoundedText(response, options.maxBytes);
      } catch (error) {
        throw unavailable(storeConnectionId, options.operation, { retryable: true, errorName: errorName(error) });
      }
      if (text === null) throw invalidResponse(storeConnectionId, `eBay's ${options.operation} answer exceeded its size limit.`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private nowMs(): number {
    return this.deps.clock.now().getTime();
  }
}

/** The US tree as an index. Entries with an invalid id or name, and duplicates, are dropped with their subtrees. */
export function parseEbayCategoryTree(text: string, storeConnectionId: number): EbayCategoryTreeIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalidResponse(storeConnectionId, "The category tree was not valid JSON.");
  }
  if (!isRecord(raw) || !isRecord(raw.rootCategoryNode)) throw invalidResponse(storeConnectionId, "The category tree has no root node.");
  if (raw.categoryTreeId !== EBAY_US_CATEGORY_TREE_ID) throw invalidResponse(storeConnectionId, "The category tree is not the eBay US tree.");
  const rootChildren = raw.rootCategoryNode.childCategoryTreeNodes;
  if (!Array.isArray(rootChildren)) throw invalidResponse(storeConnectionId, "The category tree has no top-level categories.");

  const nodes = new Map<string, CategoryNode>();
  const topLevelIds: string[] = [];
  let skippedNodes = 0;
  // Depth-first with reversed pushes, so every parent keeps eBay's child order.
  const stack: Array<{ raw: unknown; parentId: string | null; depth: number }> = [];
  for (let position = rootChildren.length - 1; position >= 0; position -= 1) {
    stack.push({ raw: rootChildren[position], parentId: null, depth: 1 });
  }
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const node = readTreeNode(entry.raw);
    if (!node || entry.depth > MAX_EBAY_CATEGORY_PATH_DEPTH || nodes.has(node.categoryId)) {
      skippedNodes += 1;
      continue;
    }
    if (nodes.size >= MAX_EBAY_CATEGORY_TREE_NODES) throw invalidResponse(storeConnectionId, "The category tree exceeds the node limit.");
    nodes.set(node.categoryId, {
      categoryId: node.categoryId,
      categoryName: node.categoryName,
      parentId: entry.parentId,
      childIds: [],
      leaf: node.children.length === 0 && node.leafFlag !== false,
    });
    if (entry.parentId === null) topLevelIds.push(node.categoryId);
    else nodes.get(entry.parentId)!.childIds.push(node.categoryId);
    for (let position = node.children.length - 1; position >= 0; position -= 1) {
      stack.push({ raw: node.children[position], parentId: node.categoryId, depth: entry.depth + 1 });
    }
  }
  if (topLevelIds.length === 0) throw invalidResponse(storeConnectionId, "The category tree has no top-level categories.");
  return {
    treeVersion: typeof raw.categoryTreeVersion === "string" ? raw.categoryTreeVersion : null,
    topLevelIds,
    nodes,
    skippedNodes,
  };
}

/** eBay's suggested category ids, in eBay's order, without duplicates or malformed entries. */
export function parseEbayCategorySuggestionIds(text: string, storeConnectionId: number): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalidResponse(storeConnectionId, "The category suggestions were not valid JSON.");
  }
  if (!isRecord(raw)) throw invalidResponse(storeConnectionId, "The category suggestions were not an object.");
  const suggestions = raw.categorySuggestions ?? [];
  if (!Array.isArray(suggestions)) throw invalidResponse(storeConnectionId, "categorySuggestions must be an array.");
  const ids: string[] = [];
  for (const suggestion of suggestions) {
    const categoryId = isRecord(suggestion) && isRecord(suggestion.category) ? suggestion.category.categoryId : undefined;
    if (typeof categoryId === "string" && EBAY_CATEGORY_ID_PATTERN.test(categoryId) && !ids.includes(categoryId)) {
      ids.push(categoryId);
    }
  }
  return ids;
}

function categoryOption(index: EbayCategoryTreeIndex, categoryId: string): EbayCategoryOption | null {
  const node = index.nodes.get(categoryId);
  if (!node) return null;
  const path: string[] = [];
  for (let current: CategoryNode | undefined = node; current;
    current = current.parentId === null ? undefined : index.nodes.get(current.parentId)) {
    path.unshift(current.categoryName);
  }
  return { categoryId: node.categoryId, categoryName: node.categoryName, path, leaf: node.leaf };
}

function readTreeNode(raw: unknown): { categoryId: string; categoryName: string; children: unknown[]; leafFlag: boolean | undefined } | null {
  if (!isRecord(raw) || !isRecord(raw.category)) return null;
  const categoryId = raw.category.categoryId;
  const categoryName = typeof raw.category.categoryName === "string" ? raw.category.categoryName.trim() : "";
  if (typeof categoryId !== "string" || !EBAY_CATEGORY_ID_PATTERN.test(categoryId)) return null;
  if (!categoryName || categoryName.length > MAX_EBAY_CATEGORY_NAME_LENGTH) return null;
  const children = raw.childCategoryTreeNodes === undefined ? [] : raw.childCategoryTreeNodes;
  if (!Array.isArray(children)) return null;
  return {
    categoryId,
    categoryName,
    children,
    leafFlag: typeof raw.leafCategoryTreeNode === "boolean" ? raw.leafCategoryTreeNode : undefined,
  };
}

/** A body bounded in bytes after decompression; null when it would exceed the bound. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isProviderSideFailure(error: unknown): boolean {
  return error instanceof DropshipError
    && (error.code === "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE" || error.code === "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE");
}

function unavailable(storeConnectionId: number, operation: string, extra: { retryable: boolean; errorName: string }): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "eBay categories could not be loaded. Try again shortly.",
    { storeConnectionId, operation, ...extra });
}

function invalidResponse(storeConnectionId: number, reason: string): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE", "eBay returned category data that could not be read.",
    { storeConnectionId, reason, retryable: true });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
