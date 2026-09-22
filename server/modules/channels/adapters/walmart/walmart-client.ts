import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChannelProviderError } from "../../channel-provider.error";

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
  ) {
    super(code, message, retryable, status);
    this.name = "WalmartApiError";
  }
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

  async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    // Never follow a provider cursor or redirect to a different origin with credentials.
    if (!path.startsWith("/v3/") || path.includes("\\") || path.includes("#") || /[\r\n]/.test(path)) {
      throw new WalmartApiError("WALMART_INVALID_PATH", "Invalid Walmart API request path", false);
    }
    const origin = API_ORIGINS[this.credentials.environment];
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/v3/")) {
      throw new WalmartApiError("WALMART_INVALID_PATH", "Invalid Walmart API request path", false);
    }
    const token = await this.accessToken();
    try {
      return await this.send(url.href, method, {
        "WM_SEC.ACCESS_TOKEN": token,
        "WM_GLOBAL_VERSION": "3.1",
        "Content-Type": "application/json",
      }, body === undefined ? undefined : JSON.stringify(body));
    } catch (error) {
      if (!(error instanceof WalmartApiError) || error.status !== 401) throw error;
      // A 401 rejects the request before execution. Ambiguous failures are never
      // retried here: the operation owner must reconcile provider state first.
      if (this.token?.value === token) this.token = null;
      const renewed = await this.accessToken();
      return this.send(url.href, method, {
        "WM_SEC.ACCESS_TOKEN": renewed,
        "WM_GLOBAL_VERSION": "3.1",
        "Content-Type": "application/json",
      }, body === undefined ? undefined : JSON.stringify(body));
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
    const parsed = tokenSchema.safeParse(result);
    if (!parsed.success) throw new WalmartApiError("WALMART_INVALID_TOKEN_RESPONSE", "Walmart returned an invalid token response", false);
    this.token = {
      value: parsed.data.access_token,
      expiresAt: requestedAt + parsed.data.expires_in * 1_000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return this.token.value;
  }

  private async send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<unknown> {
    const correlationId = z.string().uuid().parse(this.dependencies.correlationId());
    try {
      const response = await this.dependencies.fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "WM_SVC.NAME": "Walmart Marketplace",
          "WM_MARKET": this.credentials.market,
          ...(this.credentials.environment === "sandbox" && this.credentials.market === "us" ? { "WM_SANDBOX": "v2" } : {}),
          "WM_QOS.CORRELATION_ID": correlationId,
          ...headers,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Provider bodies can echo authorization or customer data. Never surface them.
        throw new WalmartApiError(
          `WALMART_HTTP_${response.status}`,
          `Walmart request failed (HTTP ${response.status}, request ${correlationId})`,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status,
        );
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof WalmartApiError) throw error;
      throw new WalmartApiError("WALMART_NETWORK_ERROR", `Walmart request did not complete (request ${correlationId})`, true);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WalmartApiError("WALMART_INVALID_JSON", "Walmart returned invalid JSON", true);
  }
}
