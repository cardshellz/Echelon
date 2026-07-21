import { z } from "zod";

import {
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
} from "./shipstation-tracking-api-config";
import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "./shipstation-tracking-http";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const shipStationTrackingWebhookSchema = z.object({
  webhook_id: z.string().min(1),
  url: z.string().min(1),
  event: z.string().min(1),
  name: z.string().nullable().optional(),
  headers: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).optional(),
  store_id: z.number().int().nullable().optional(),
}).passthrough();

export type ShipStationTrackingWebhook = z.infer<typeof shipStationTrackingWebhookSchema>;

export interface ShipStationTrackingWebhooksClient {
  listWebhooks(): Promise<ShipStationTrackingWebhook[]>;
  createWebhook(input: {
    name: string;
    event: "track";
    url: string;
    headers: Array<{ key: string; value: string }>;
  }): Promise<ShipStationTrackingWebhook>;
}

export class ShipStationTrackingWebhooksClientError extends Error {
  constructor(
    readonly code: "CONFIGURATION" | "TIMEOUT" | "NETWORK" | "HTTP" | "INVALID_RESPONSE",
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipStationTrackingWebhooksClientError";
  }
}

export interface ShipStationTrackingWebhooksClientConfig {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createShipStationTrackingWebhooksClient(
  config: ShipStationTrackingWebhooksClientConfig = {},
): ShipStationTrackingWebhooksClient {
  const apiKey = resolveShipStationTrackingApiKey(config.apiKey);
  let baseUrl: string;
  try {
    baseUrl = normalizeShipStationTrackingApiBaseUrl(config.baseUrl);
  } catch (error) {
    throw new ShipStationTrackingWebhooksClientError(
      "CONFIGURATION",
      error instanceof Error ? error.message : "ShipStation tracking API base URL is invalid",
    );
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new ShipStationTrackingWebhooksClientError(
      "CONFIGURATION",
      "SHIPSTATION_V2_API_KEY is required to inspect or configure tracking webhooks",
    );
  }
  if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1_000
      || requestTimeoutMs > 60_000) {
    throw new ShipStationTrackingWebhooksClientError(
      "CONFIGURATION",
      "ShipStation tracking webhook request timeout must be an integer from 1000 through 60000 milliseconds",
      { requestTimeoutMs },
    );
  }

  async function request(method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const path = "/environment/webhooks";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    let responseText: string;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "API-Key": apiKey,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ShipStationTrackingResponseReadError) {
        throw new ShipStationTrackingWebhooksClientError(
          "INVALID_RESPONSE",
          error.message,
          {
            method,
            path,
            responseBytes: error.responseBytes,
            maxResponseBytes: error.maxResponseBytes,
          },
        );
      }
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ShipStationTrackingWebhooksClientError(
        timedOut ? "TIMEOUT" : "NETWORK",
        timedOut
          ? `ShipStation tracking webhook ${method} ${path} timed out after ${requestTimeoutMs}ms`
          : `ShipStation tracking webhook ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        { method, path },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ShipStationTrackingWebhooksClientError(
        "HTTP",
        `ShipStation tracking webhook ${method} ${path} returned HTTP ${response.status}`,
        {
          method,
          path,
          status: response.status,
          responseBody: responseText.slice(0, 500),
        },
      );
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      throw new ShipStationTrackingWebhooksClientError(
        "INVALID_RESPONSE",
        `ShipStation tracking webhook ${method} ${path} returned invalid JSON`,
        { method, path, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  return {
    async listWebhooks(): Promise<ShipStationTrackingWebhook[]> {
      const parsed = z.array(shipStationTrackingWebhookSchema).safeParse(await request("GET"));
      if (!parsed.success) {
        throw new ShipStationTrackingWebhooksClientError(
          "INVALID_RESPONSE",
          "ShipStation list-webhooks response did not match the documented array contract",
          { issues: parsed.error.issues },
        );
      }
      return parsed.data;
    },

    async createWebhook(input): Promise<ShipStationTrackingWebhook> {
      const parsed = shipStationTrackingWebhookSchema.safeParse(await request("POST", input));
      if (!parsed.success) {
        throw new ShipStationTrackingWebhooksClientError(
          "INVALID_RESPONSE",
          "ShipStation create-webhook response did not match the documented contract",
          { issues: parsed.error.issues },
        );
      }
      return parsed.data;
    },
  };
}
