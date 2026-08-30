import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayStoreCategory,
  DropshipEbayStoreCategoryDirectory,
} from "../application/dropship-ebay-store-category-service";
import type { DropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import { resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-registration-credentials";

type FetchLike = typeof fetch;

const EBAY_STORES_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;
const MAX_STORE_CATEGORY_NODES = 2_000;
const MAX_STORE_CATEGORY_DEPTH = 10;

interface EbayStoreCategoryNode {
  categoryId?: unknown;
  categoryName?: unknown;
  childrenCategories?: unknown;
  level?: unknown;
}

interface EbayStoreCategoryResponse {
  storeCategories?: unknown;
}

export class EbayDropshipStoreCategoryDirectory implements DropshipEbayStoreCategoryDirectory {
  constructor(
    private readonly credentials: DropshipEbayRegistrationCredentialProvider,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async listLeafCategories(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategory[]> {
    const credential = await this.credentials.loadFreshForStoreConnection(input);
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    let response: Response;
    try {
      response = await this.fetchFn(
        `${EBAY_STORES_BASE_URLS[environment]}/sell/stores/v1/store/categories`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.accessToken}`,
          },
        },
      );
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
        "The connected eBay Store categories could not be loaded.",
        {
          storeConnectionId: input.storeConnectionId,
          retryable: true,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const permissionFailure = response.status === 401 || response.status === 403;
      throw new DropshipError(
        permissionFailure
          ? "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED"
          : "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
        permissionFailure
          ? "Reconnect the eBay store to grant Store-category access."
          : "The connected eBay account did not return a Store category hierarchy.",
        {
          storeConnectionId: input.storeConnectionId,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }

    return parseEbayStoreCategories(text, input.storeConnectionId);
  }
}

export function parseEbayStoreCategories(
  text: string,
  storeConnectionId: number,
): DropshipEbayStoreCategory[] {
  let raw: EbayStoreCategoryResponse;
  try {
    raw = JSON.parse(text) as EbayStoreCategoryResponse;
  } catch {
    throw invalidStoreCategoryResponse(storeConnectionId, "Response was not valid JSON.");
  }
  if (!Array.isArray(raw.storeCategories)) {
    throw invalidStoreCategoryResponse(storeConnectionId, "storeCategories must be an array.");
  }

  const categories: DropshipEbayStoreCategory[] = [];
  const categoryIds = new Set<string>();
  let visitedNodes = 0;

  const visit = (node: unknown, parentNames: readonly string[], depth: number): void => {
    visitedNodes += 1;
    if (visitedNodes > MAX_STORE_CATEGORY_NODES || depth > MAX_STORE_CATEGORY_DEPTH) {
      throw invalidStoreCategoryResponse(storeConnectionId, "Store category hierarchy exceeded safe limits.");
    }
    if (!isRecord(node)) {
      throw invalidStoreCategoryResponse(storeConnectionId, "Store category node must be an object.");
    }
    const typedNode = node as EbayStoreCategoryNode;
    const categoryId = requiredProviderString(typedNode.categoryId);
    const categoryName = requiredProviderString(typedNode.categoryName);
    if (!categoryId || !categoryName) {
      throw invalidStoreCategoryResponse(storeConnectionId, "Store category id and name are required.");
    }
    if (categoryIds.has(categoryId)) {
      throw invalidStoreCategoryResponse(storeConnectionId, "Store category ids must be unique.");
    }
    categoryIds.add(categoryId);
    const children = typedNode.childrenCategories ?? [];
    if (!Array.isArray(children)) {
      throw invalidStoreCategoryResponse(storeConnectionId, "childrenCategories must be an array.");
    }
    const pathParts = [...parentNames, categoryName];
    if (children.length === 0) {
      const providerLevel = typedNode.level;
      categories.push({
        categoryId,
        categoryName,
        path: pathParts.join(":"),
        level: typeof providerLevel === "number" && Number.isSafeInteger(providerLevel)
          ? providerLevel
          : depth,
      });
      return;
    }
    for (const child of children) {
      visit(child, pathParts, depth + 1);
    }
  };

  for (const category of raw.storeCategories) {
    visit(category, [], 1);
  }
  return categories.sort((left, right) => left.path.localeCompare(right.path));
}

function invalidStoreCategoryResponse(
  storeConnectionId: number,
  reason: string,
): DropshipError {
  return new DropshipError(
    "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE",
    "eBay returned an invalid Store category hierarchy.",
    { storeConnectionId, reason, retryable: true },
  );
}

function requiredProviderString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
