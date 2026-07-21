import { normalizeTrackingNumber } from "./carrier-tracking.domain";
import {
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
  SHIPSTATION_TRACKING_API_BASE_URL,
} from "./shipstation-tracking-api-config";
import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "./shipstation-tracking-http";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 250;
const MAX_RESPONSE_BYTES = 1_000_000;

export interface ShipStationTrackingHydrationRequest {
  resourceUrl: string;
  carrierCode: string;
  trackingNumber: string;
  normalizedTrackingNumber: string;
}

export interface ShipStationTrackingSnapshotResult {
  httpStatus: 200;
  payload: Record<string, unknown>;
}

export interface ShipStationTrackingEventsClient {
  isConfigured(): boolean;
  getTrackingSnapshot(
    input: ShipStationTrackingHydrationRequest,
  ): Promise<ShipStationTrackingSnapshotResult>;
}

export type ShipStationTrackingEventsErrorCode =
  | "CONFIGURATION"
  | "INVALID_RESOURCE_URL"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "INVALID_RESPONSE";

export class ShipStationTrackingEventsError extends Error {
  constructor(
    readonly code: ShipStationTrackingEventsErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipStationTrackingEventsError";
  }
}

export interface ShipStationTrackingEventsClientConfig {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  minimumRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}

export function parseShipStationTrackingResourceUrl(
  rawResourceUrl: string,
  configuredBaseUrl: string = SHIPSTATION_TRACKING_API_BASE_URL,
): ShipStationTrackingHydrationRequest {
  const resourceUrlText = rawResourceUrl.trim();
  if (!resourceUrlText || resourceUrlText.length > 2_048) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL must contain 1 through 2048 characters",
    );
  }

  let resourceUrl: URL;
  let baseUrl: URL;
  try {
    resourceUrl = new URL(resourceUrlText);
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL is not a valid absolute URL",
    );
  }

  if (baseUrl.protocol !== "https:") {
    throw new ShipStationTrackingEventsError(
      "CONFIGURATION",
      "ShipStation tracking API base URL must use HTTPS",
    );
  }
  const expectedPath = `${baseUrl.pathname.replace(/\/+$/, "")}/tracking`;
  if (resourceUrl.protocol !== "https:"
      || resourceUrl.origin !== baseUrl.origin
      || resourceUrl.pathname.replace(/\/+$/, "") !== expectedPath
      || resourceUrl.username
      || resourceUrl.password
      || resourceUrl.hash) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL is outside the configured tracking endpoint",
      {
        resourceOrigin: resourceUrl.origin,
        resourcePath: resourceUrl.pathname,
        expectedOrigin: baseUrl.origin,
        expectedPath,
      },
    );
  }

  const carrierCodes = resourceUrl.searchParams.getAll("carrier_code");
  const trackingNumbers = resourceUrl.searchParams.getAll("tracking_number");
  if (carrierCodes.length !== 1 || trackingNumbers.length !== 1) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL must contain exactly one carrier_code and tracking_number",
      {
        carrierCodeCount: carrierCodes.length,
        trackingNumberCount: trackingNumbers.length,
      },
    );
  }

  const carrierCode = carrierCodes[0].trim().toLowerCase();
  const trackingNumber = trackingNumbers[0].trim();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(carrierCode) || carrierCode.length > 100) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL contains an invalid carrier_code",
      { carrierCode },
    );
  }
  if (!trackingNumber || trackingNumber.length > 200) {
    throw new ShipStationTrackingEventsError(
      "INVALID_RESOURCE_URL",
      "ShipStation tracking resource URL contains an invalid tracking_number",
    );
  }

  return {
    resourceUrl: resourceUrlText,
    carrierCode,
    trackingNumber,
    normalizedTrackingNumber: normalizeTrackingNumber(trackingNumber),
  };
}

export function createShipStationTrackingEventsClient(
  config: ShipStationTrackingEventsClientConfig = {},
): ShipStationTrackingEventsClient {
  const apiKey = resolveShipStationTrackingApiKey(config.apiKey);
  let baseUrlText: string;
  try {
    baseUrlText = normalizeShipStationTrackingApiBaseUrl(config.baseUrl);
  } catch (error) {
    throw new ShipStationTrackingEventsError(
      "CONFIGURATION",
      error instanceof Error ? error.message : "ShipStation tracking API base URL is invalid",
    );
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const minimumRequestIntervalMs = config.minimumRequestIntervalMs
    ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleepImpl = config.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const nowMs = config.nowMs ?? Date.now;

  if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1_000
      || requestTimeoutMs > 60_000) {
    throw new ShipStationTrackingEventsError(
      "CONFIGURATION",
      "ShipStation tracking request timeout must be an integer from 1000 through 60000 milliseconds",
      { requestTimeoutMs },
    );
  }
  if (!Number.isSafeInteger(minimumRequestIntervalMs)
      || minimumRequestIntervalMs < 0
      || minimumRequestIntervalMs > 60_000) {
    throw new ShipStationTrackingEventsError(
      "CONFIGURATION",
      "ShipStation tracking minimum request interval must be an integer from 0 through 60000 milliseconds",
      { minimumRequestIntervalMs },
    );
  }

  let nextRequestStartAtMs = 0;
  let requestStartSequence = Promise.resolve();
  const reserveRequestStart = (): Promise<void> => {
    const reservation = requestStartSequence.then(async () => {
      const waitMs = Math.max(0, nextRequestStartAtMs - nowMs());
      if (waitMs > 0) await sleepImpl(waitMs);
      nextRequestStartAtMs = nowMs() + minimumRequestIntervalMs;
    });
    requestStartSequence = reservation.catch(() => undefined);
    return reservation;
  };

  return {
    isConfigured: () => apiKey.length > 0,

    async getTrackingSnapshot(input): Promise<ShipStationTrackingSnapshotResult> {
      if (!apiKey) {
        throw new ShipStationTrackingEventsError(
          "CONFIGURATION",
          "SHIPSTATION_TRACKING_API_KEY is required to hydrate carrier tracking events",
        );
      }
      const validated = parseShipStationTrackingResourceUrl(input.resourceUrl, baseUrlText);
      if (validated.carrierCode !== input.carrierCode
          || validated.normalizedTrackingNumber !== input.normalizedTrackingNumber) {
        throw new ShipStationTrackingEventsError(
          "INVALID_RESOURCE_URL",
          "Stored carrier tracking hydration identity does not match its resource URL",
          {
            carrierCodeMatches: validated.carrierCode === input.carrierCode,
            trackingNumberMatches:
              validated.normalizedTrackingNumber === input.normalizedTrackingNumber,
          },
        );
      }

      const query = new URLSearchParams({
        carrier_code: validated.carrierCode,
        tracking_number: validated.trackingNumber,
      });
      const requestUrl = `${baseUrlText}/tracking?${query.toString()}`;
      await reserveRequestStart();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response;
      let responseText: string;
      let responseStatus: number | null = null;
      try {
        response = await fetchImpl(requestUrl, {
          method: "GET",
          headers: { "API-Key": apiKey },
          signal: controller.signal,
        });
        responseStatus = response.status;
        responseText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof ShipStationTrackingResponseReadError) {
          throw new ShipStationTrackingEventsError(
            "INVALID_RESPONSE",
            error.message,
            {
              responseBytes: error.responseBytes,
              maxResponseBytes: error.maxResponseBytes,
              carrierCode: input.carrierCode,
              trackingSuffix: input.normalizedTrackingNumber.slice(-6),
            },
          );
        }
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ShipStationTrackingEventsError(
          timedOut ? "TIMEOUT" : "NETWORK",
          timedOut
            ? `ShipStation tracking hydration timed out after ${requestTimeoutMs}ms`
            : `ShipStation tracking hydration failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            status: responseStatus,
            carrierCode: input.carrierCode,
            trackingSuffix: input.normalizedTrackingNumber.slice(-6),
          },
        );
      } finally {
        clearTimeout(timer);
      }
      if (response.status !== 200) {
        throw new ShipStationTrackingEventsError(
          "HTTP",
          `ShipStation tracking hydration returned HTTP ${response.status}`,
          {
            status: response.status,
            responseBody: responseText.slice(0, 500),
            carrierCode: input.carrierCode,
            trackingSuffix: input.normalizedTrackingNumber.slice(-6),
          },
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new ShipStationTrackingEventsError(
          "INVALID_RESPONSE",
          "ShipStation tracking hydration returned invalid JSON",
          { status: response.status, responseBody: responseText.slice(0, 500) },
        );
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ShipStationTrackingEventsError(
          "INVALID_RESPONSE",
          "ShipStation tracking hydration returned a non-object payload",
          { status: response.status },
        );
      }
      return { httpStatus: 200, payload: payload as Record<string, unknown> };
    },
  };
}

export function isRetryableTrackingEventsError(error: unknown): boolean {
  if (!(error instanceof ShipStationTrackingEventsError)) return false;
  if (error.code === "TIMEOUT" || error.code === "NETWORK") return true;
  if (error.code !== "HTTP") return false;
  const status = Number(error.context.status);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function trackingEventsErrorEvidence(error: unknown): {
  code: string;
  message: string;
  httpStatus: number | null;
  details: Record<string, unknown>;
} {
  if (error instanceof ShipStationTrackingEventsError) {
    const status = Number(error.context.status);
    return {
      code: `SHIPSTATION_TRACKING_HYDRATION_${error.code}`,
      message: error.message,
      httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
      details: error.context,
    };
  }
  return {
    code: "SHIPSTATION_TRACKING_HYDRATION_UNCLASSIFIED",
    message: error instanceof Error ? error.message : String(error),
    httpStatus: null,
    details: {},
  };
}
