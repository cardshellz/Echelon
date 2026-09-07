import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnIntakeFetchResult,
  DropshipReturnIntakeProvider,
  DropshipReturnIntakeStoreConnection,
} from "../application/dropship-return-intake-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  buildEbayReturnIntakeDraft,
  shouldRecordEbayReturnCase,
  type EbayReturnCase,
} from "./dropship-ebay-return-intake.mapper";
import {
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
} from "./dropship-ebay-auth-failure";
import { DropshipEbayTokenOwner, resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";
import { buildEbayPostOrderAuthorization } from "./dropship-ebay-post-order-auth";

/**
 * eBay return-intake provider (design spec D2a): polls the Post-Order API
 * return search endpoint for one connected eBay store and maps each return
 * case to a normalized draft. Read-only — all persistence lives in the poll
 * service / intake service.
 *
 * Tokens are loaded through the shared eBay token owner so background polling
 * preserves the same seller grant as listing setup. Resource retries are bounded.
 */

type FetchLike = typeof fetch;
type EbayEnvironment = "sandbox" | "production";

interface Clock {
  now(): Date;
}

interface EbayReturnSearchResponse {
  returns?: EbayReturnCase[];
  total?: number;
  limit?: number;
  offset?: number;
}

const EBAY_BASE_URLS: Record<EbayEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

const EBAY_MAX_ATTEMPTS = 3;
const EBAY_PAGE_SIZE = 50;

export class EbayDropshipReturnIntakeProvider implements DropshipReturnIntakeProvider {
  private readonly tokenOwner: DropshipEbayTokenOwner;

  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    this.tokenOwner = new DropshipEbayTokenOwner({
      credentials,
      fetchFn: fetchImpl,
      clock,
    });
  }

  async fetchReturns(input: {
    connection: DropshipReturnIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipReturnIntakeFetchResult> {
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      operation: "return_intake",
    });
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    const marketplaceId = resolveMarketplaceId(credential.config);

    const returnCases = await this.fetchAllReturnCases({
      credential,
      environment,
      marketplaceId,
      since: input.since,
      until: input.until,
    });

    const result: DropshipReturnIntakeFetchResult = { drafts: [], ignored: 0 };
    for (const returnCase of returnCases) {
      const decision = shouldRecordEbayReturnCase({ returnCase });
      if (!decision.record) {
        result.ignored += 1;
        continue;
      }
      result.drafts.push(buildEbayReturnIntakeDraft({ returnCase }));
    }
    return result;
  }

  private async fetchAllReturnCases(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
  }): Promise<EbayReturnCase[]> {
    const returns: EbayReturnCase[] = [];
    let offset = 0;
    while (true) {
      const response = await this.fetchReturnPage({ ...input, offset });
      if (!Array.isArray(response.returns) || response.returns.length === 0) {
        break;
      }
      returns.push(...response.returns);
      offset += response.returns.length;
      if (response.returns.length < EBAY_PAGE_SIZE || offset >= (response.total ?? offset)) {
        break;
      }
    }
    return returns;
  }

  private async fetchReturnPage(input: {
    credential: DropshipMarketplaceStoreCredentials;
    environment: EbayEnvironment;
    marketplaceId: string;
    since: Date;
    until: Date;
    offset: number;
  }): Promise<EbayReturnSearchResponse> {
    const params = new URLSearchParams({
      creation_date_range_from: input.since.toISOString(),
      creation_date_range_to: input.until.toISOString(),
      limit: String(EBAY_PAGE_SIZE),
      offset: String(input.offset),
    });
    return this.requestEbay<EbayReturnSearchResponse>({
      environment: input.environment,
      credential: input.credential,
      marketplaceId: input.marketplaceId,
      path: `/post-order/v2/return/search?${params.toString()}`,
    });
  }

  private async requestEbay<T>(input: {
    environment: EbayEnvironment;
    credential: DropshipMarketplaceStoreCredentials;
    marketplaceId: string;
    path: string;
  }): Promise<T> {
    for (let attempt = 1; attempt <= EBAY_MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${EBAY_BASE_URLS[input.environment]}${input.path}`, {
          method: "GET",
          headers: {
            Authorization: buildEbayPostOrderAuthorization(input.credential.accessToken),
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": input.marketplaceId,
          },
        });
      } catch (error) {
        if (attempt < EBAY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_EBAY_RETURN_INTAKE_NETWORK_ERROR",
          "eBay return intake failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }

      const text = await response.text();
      if (response.ok) {
        return parseEbayJson<T>({
          text,
          code: "DROPSHIP_EBAY_RETURN_INTAKE_INVALID_RESPONSE",
          message: "eBay return intake returned invalid JSON.",
        });
      }
      const accessTokenRejected = isEbayResourceAuthFailureStatus(response.status);
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential: input.credential,
          status: response.status,
          failureCode: "DROPSHIP_EBAY_RETURN_INTAKE_HTTP_ERROR",
          message: `eBay return intake failed with HTTP ${response.status}.`,
          now: this.clock.now(),
        });
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < EBAY_MAX_ATTEMPTS) {
        await delay(resolveRetryDelayMs(response, attempt));
        continue;
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_RETURN_INTAKE_HTTP_ERROR",
        `eBay return intake failed with HTTP ${response.status}.`,
        {
          retryable: retryable || accessTokenRejected,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }
    throw new DropshipError(
      "DROPSHIP_EBAY_RETURN_INTAKE_RETRY_EXHAUSTED",
      "eBay return intake retry attempts were exhausted.",
      { retryable: true },
    );
  }

}

function resolveMarketplaceId(config: Record<string, unknown>): string {
  return typeof config.marketplaceId === "string" && config.marketplaceId.trim()
    ? config.marketplaceId.trim()
    : "EBAY_US";
}

function parseEbayJson<T>(input: { text: string; code: string; message: string }): T {
  try {
    return JSON.parse(input.text) as T;
  } catch {
    throw new DropshipError(input.code, input.message, {
      body: input.text.slice(0, 1000),
      retryable: true,
    });
  }
}

function resolveRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
