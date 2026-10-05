import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ChannelProviderError } from "../../channel-provider.error";
import { observeQuantityProviderRequest, recordQuantityProviderResponse } from "../../../inventory-planning/application/quantity-provider-request-evidence";

export const walmartCredentialsSchema = z.object({
  clientId: z.string().trim().min(1).max(500).refine((value) => !value.includes(":")),
  clientSecret: z.string().min(1).max(2_000),
  environment: z.enum(["production", "sandbox"]),
  market: z.enum(["us", "ca", "mx", "cl"]),
}).strict();
export type WalmartCredentials = z.infer<typeof walmartCredentialsSchema>;

export class WalmartApiError extends ChannelProviderError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly requestMetadata?: WalmartResponseMetadata,
  ) {
    super(code, message, retryable, status);
    this.name = "WalmartApiError";
  }
}

export interface WalmartResponseMetadata {
  /** Physical write outcome recorded by the quantity evidence collector, if any. */
  readonly quantityOutcome?: "completed" | "rejected" | "uncertain";
  readonly correlationId: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly remainingTokens: number | null;
  readonly nextReplenishmentAt: string | null;
}
export interface WalmartRequestOptions {
  /** Persisted by the operation owner; reuse when renewing rejected credentials. */
  readonly correlationId?: string;
}
export interface WalmartResponse {
  readonly data: unknown;
  readonly metadata: WalmartResponseMetadata;
}

export interface WalmartClientDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly correlationId: () => string;
}

const API_ORIGINS = {
  production: "https://marketplace.walmartapis.com",
  sandbox: "https://sandbox.walmartapis.com",
} as const;
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32_000),
  token_type: z.string().optional(),
  expires_in: z.number().int().min(60).max(86_400),
});

/** One instance belongs to one credential version; tokens never cross accounts. */
export class WalmartClient {
  private readonly credentials: WalmartCredentials;
  private readonly dependencies: WalmartClientDependencies;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(credentials: WalmartCredentials, dependencies: Partial<WalmartClientDependencies> = {}) {
    this.credentials = walmartCredentialsSchema.parse(credentials);
    this.dependencies = {
      fetch: dependencies.fetch ?? fetch,
      now: dependencies.now ?? (() => new Date()),
      correlationId: dependencies.correlationId ?? randomUUID,
    };
  }

  /** Authentication is a read-only account check, not permission to import or publish. */
  async authenticate(): Promise<void> {
    await this.accessToken();
  }

  async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown, options?: WalmartRequestOptions): Promise<unknown> {
    return (await this.requestWithMetadata(method, path, body, options)).data;
  }

  async requestWithMetadata(method: "GET" | "POST" | "PUT", path: string, body?: unknown, options?: WalmartRequestOptions): Promise<WalmartResponse> {
    // Never follow a provider cursor or redirect to a different origin with credentials.
    if (!path.startsWith("/v3/") || path.includes("\\") || path.includes("#") || /[\r\n]/.test(path)) {
      throw new WalmartApiError("WALMART_INVALID_PATH", "Invalid Walmart API request path", false);
    }
    const origin = API_ORIGINS[this.credentials.environment];
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/v3/")) {
      throw new WalmartApiError("WALMART_INVALID_PATH", "Invalid Walmart API request path", false);
    }
    const correlationId = z.string().uuid().parse(options?.correlationId ?? this.dependencies.correlationId());
    const token = await this.accessToken();
    try {
      return await this.send(url.href, method, {
        "WM_SEC.ACCESS_TOKEN": token,
        "WM_GLOBAL_VERSION": "3.1",
        "Content-Type": "application/json",
      }, body === undefined ? undefined : JSON.stringify(body), correlationId);
    } catch (error) {
      if (!(error instanceof WalmartApiError) || error.status !== 401) throw error;
      // A 401 rejects the request before execution. Ambiguous failures are never
      // retried here: the operation owner must reconcile provider state first.
      if (this.token?.value === token) this.token = null;
      // The quantity owner persists each physical rejection. It schedules the next
      // attempt; replaying inside that owner would invalidate its terminal evidence.
      if (isQuantityRequest(method, url) || isListingMaintenanceRequest(method, url)) throw error;
      const renewed = await this.accessToken();
      return this.send(url.href, method, {
        "WM_SEC.ACCESS_TOKEN": renewed,
        "WM_GLOBAL_VERSION": "3.1",
        "Content-Type": "application/json",
      }, body === undefined ? undefined : JSON.stringify(body), correlationId);
    }
  }

  private async accessToken(): Promise<string> {
    const now = this.dependencies.now().getTime();
    if (!Number.isFinite(now)) throw new WalmartApiError("WALMART_INVALID_CLOCK", "Invalid integration clock", false);
    if (this.token && now < this.token.expiresAt) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.issueToken(now);
    try {
      return await this.tokenInFlight;
    } finally {
      this.tokenInFlight = null;
    }
  }

  private async issueToken(requestedAt: number): Promise<string> {
    const result = await this.send(`${API_ORIGINS[this.credentials.environment]}/v3/token`, "POST", {
      Authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`, "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    }, "grant_type=client_credentials");
    const parsed = tokenSchema.safeParse(result.data);
    if (!parsed.success) throw new WalmartApiError("WALMART_INVALID_TOKEN_RESPONSE", "Walmart returned an invalid token response", false);
    this.token = {
      value: parsed.data.access_token,
      expiresAt: requestedAt + parsed.data.expires_in * 1_000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return this.token.value;
  }

  private async send(url: string, method: string, headers: Record<string, string>, body?: string,
    correlationId = z.string().uuid().parse(this.dependencies.correlationId())): Promise<WalmartResponse> {
    const target = new URL(url);
    const quantityRequest = isQuantityRequest(method, target);
    const work = () => this.sendOnce(url, method, headers, body, correlationId, quantityRequest);
    return quantityRequest ? observeQuantityProviderRequest({ method, path: `${target.pathname}${target.search}`,
      body: body === undefined ? undefined : JSON.parse(body) as unknown }, work) : work();
  }

  private async sendOnce(url: string, method: string, headers: Record<string, string>, body: string | undefined,
    correlationId: string, quantityRequest: boolean): Promise<WalmartResponse> {
    let metadata: WalmartResponseMetadata = { correlationId, status: null, retryAfterMs: null,
      remainingTokens: null, nextReplenishmentAt: null };
    let recorded = false;
    try {
      let requestBody: BodyInit | undefined = body;
      const requestHeaders = { ...headers };
      if ((isListingSetupFeedRequest(method, new URL(url)) || isListingMaintenanceRequest(method, new URL(url))) && body !== undefined) {
        // The feed endpoint documents a multipart file upload. Keep the exact
        // approved JSON as the file content; send() still records its semantic
        // hash before transport encoding, independent of multipart boundaries.
        // https://developer.walmart.com/global-marketplace/reference/itembulkuploads
        const form = new FormData();
        form.append("file", new Blob([body], { type: "application/json" }), "items.json");
        requestBody = form;
        delete requestHeaders["Content-Type"];
      }
      const response = await this.dependencies.fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "WM_SVC.NAME": "Walmart Marketplace",
          "WM_MARKET": this.credentials.market,
          ...(this.credentials.environment === "sandbox" && this.credentials.market === "us" ? { "WM_SANDBOX": "v2" } : {}),
          "WM_QOS.CORRELATION_ID": correlationId,
          ...requestHeaders,
        },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      metadata = responseMetadata(response, correlationId, this.dependencies.now());
      const bytes = await readBytes(response);
      let data: unknown;
      let validJson = true;
      try { data = JSON.parse(bytes.toString("utf8")) as unknown; } catch { validJson = false; }
      if (quantityRequest) {
        const errors = z.object({ error: z.array(z.object({ code: z.string(), category: z.string() })).min(1) }).safeParse(data);
        const rejected = [401, 403, 429].includes(response.status)
          || (response.status === 400 && errors.success && errors.data.error.every(error => error.category === "DATA"));
        const isFeed = new URL(url).pathname === "/v3/feeds";
        const noErrors = z.object({error: z.array(z.unknown()).max(0).nullish(), errors: z.array(z.unknown()).max(0).nullish()}).safeParse(data).success;
        const completed = response.status === 200 && validJson && noErrors && (isFeed
          ? z.object({ feedId: z.string().min(1).max(200) }).safeParse(data).success
          : z.object({ sku: z.string().min(1), quantity: z.object({ unit: z.literal("EACH"), amount: z.number().int().nonnegative() }) }).safeParse(data).success);
        const observedAt = this.dependencies.now().getTime();
        const retryAt = observedAt + Math.max(metadata.retryAfterMs ?? 0, 60_000);
        const retryNotBefore = rejected && Number.isSafeInteger(retryAt) && retryAt <= 8_640_000_000_000_000 ? new Date(retryAt).toISOString() : null;
        const quantityOutcome = completed ? "completed" : rejected ? "rejected" : "uncertain";
        recordQuantityProviderResponse({ outcome: quantityOutcome,
          httpStatus: response.status, providerRequestId: correlationId,
          responseHash: createHash("sha256").update(bytes).digest("hex"),
          errorCodes: [`WALMART_HTTP_${response.status}`], retryNotBefore,
          cooldownScope: retryNotBefore ? "account" : null });
        recorded = true;
        metadata = {...metadata, quantityOutcome};
      }
      if (!response.ok) {
        // Provider bodies can echo authorization or customer data. Never surface them.
        throw new WalmartApiError(
          `WALMART_HTTP_${response.status}`,
          `Walmart request failed (HTTP ${response.status}, request ${correlationId})`,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status,
          metadata,
        );
      }
      if (!validJson) throw new WalmartApiError("WALMART_INVALID_JSON", "Walmart returned invalid JSON", true, response.status, metadata);
      return { data, metadata };
    } catch (error) {
      if (quantityRequest && !recorded) recordQuantityProviderResponse({ outcome: "uncertain", httpStatus: metadata.status,
        providerRequestId: correlationId, responseHash: null, errorCodes: [], retryNotBefore: null, cooldownScope: null });
      if (error instanceof WalmartApiError) {
        if (error.requestMetadata) throw error;
        throw new WalmartApiError(error.code, error.message, error.retryable, error.status, metadata);
      }
      throw new WalmartApiError("WALMART_NETWORK_ERROR", `Walmart request did not complete (request ${correlationId})`, true, null, metadata);
    }
  }
}

function isQuantityRequest(method: string, url: URL): boolean {
  return (method === "PUT" && url.pathname === "/v3/inventory")
    || isListingSetupFeedRequest(method, url);
}

function isListingSetupFeedRequest(method: string, url: URL): boolean {
  return method === "POST" && url.pathname === "/v3/feeds"
    && ["MP_ITEM", "MP_ITEM_MATCH"].includes(url.searchParams.get("feedType") ?? "");
}

function isListingMaintenanceRequest(method: string, url: URL): boolean {
  return method === "POST" && url.pathname === "/v3/feeds" && url.searchParams.get("feedType") === "MP_MAINTENANCE";
}

function responseMetadata(response: Response, correlationId: string, now: Date): WalmartResponseMetadata {
  const retryAfter = response.headers.get("retry-after");
  const retrySeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const retryDate = retryAfter && retrySeconds === null ? Date.parse(retryAfter) : NaN;
  const delay = retrySeconds !== null ? retrySeconds * 1_000 : retryDate - now.getTime();
  const tokens = response.headers.get("x-current-token-count");
  const replenishment = response.headers.get("x-next-replenishment-time");
  const replenishmentMs = replenishment ? Date.parse(replenishment) : NaN;
  return {
    correlationId, status: response.status,
    retryAfterMs: Number.isSafeInteger(delay) && delay >= 0 ? delay : null,
    remainingTokens: tokens !== null && /^\d+$/.test(tokens) && Number.isSafeInteger(Number(tokens)) ? Number(tokens) : null,
    nextReplenishmentAt: Number.isFinite(replenishmentMs) ? new Date(replenishmentMs).toISOString() : null,
  };
}

async function readBytes(response: Response): Promise<Buffer> {
  if (!response.body) throw new WalmartApiError("WALMART_EMPTY_RESPONSE", "Walmart returned an empty response", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WalmartApiError("WALMART_RESPONSE_TOO_LARGE", "Walmart response exceeded the size limit", false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
