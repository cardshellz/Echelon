import {
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
  SHIPSTATION_TRACKING_API_BASE_URL,
} from "./shipstation-tracking-api-config";
import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "./shipstation-tracking-http";

export const SHIPSTATION_TRACKING_BASE_URL = SHIPSTATION_TRACKING_API_BASE_URL;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 250;
const MAX_ERROR_RESPONSE_BYTES = 64_000;

export interface StartCarrierTrackingInput {
  carrierCode: string;
  trackingNumber: string;
}

export interface StartCarrierTrackingResult {
  httpStatus: 204;
}

export interface ShipStationTrackingSubscriptionsClient {
  isConfigured(): boolean;
  startTracking(input: StartCarrierTrackingInput): Promise<StartCarrierTrackingResult>;
}

export type ShipStationTrackingSubscriptionErrorCode =
  | "CONFIGURATION"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "UNEXPECTED_RESPONSE";

export class ShipStationTrackingSubscriptionError extends Error {
  constructor(
    readonly code: ShipStationTrackingSubscriptionErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipStationTrackingSubscriptionError";
  }
}

export interface ShipStationTrackingSubscriptionsClientConfig {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  minimumRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}

export function createShipStationTrackingSubscriptionsClient(
  config: ShipStationTrackingSubscriptionsClientConfig = {},
): ShipStationTrackingSubscriptionsClient {
  const apiKey = resolveShipStationTrackingApiKey(config.apiKey);
  let baseUrl: string;
  try {
    baseUrl = normalizeShipStationTrackingApiBaseUrl(config.baseUrl);
  } catch (error) {
    throw new ShipStationTrackingSubscriptionError(
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
    throw new ShipStationTrackingSubscriptionError(
      "CONFIGURATION",
      "ShipStation tracking request timeout must be an integer from 1000 through 60000 milliseconds",
      { requestTimeoutMs },
    );
  }
  if (!Number.isSafeInteger(minimumRequestIntervalMs)
      || minimumRequestIntervalMs < 0
      || minimumRequestIntervalMs > 60_000) {
    throw new ShipStationTrackingSubscriptionError(
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

    async startTracking(input): Promise<StartCarrierTrackingResult> {
      const carrierCode = input.carrierCode.trim();
      const trackingNumber = input.trackingNumber.trim();
      if (!apiKey) {
        throw new ShipStationTrackingSubscriptionError(
          "CONFIGURATION",
          "SHIPSTATION_TRACKING_API_KEY is required to subscribe provider labels to carrier tracking",
        );
      }
      if (!carrierCode || carrierCode.length > 100) {
        throw new ShipStationTrackingSubscriptionError(
          "CONFIGURATION",
          "carrierCode must contain 1 through 100 characters",
        );
      }
      if (!trackingNumber || trackingNumber.length > 200) {
        throw new ShipStationTrackingSubscriptionError(
          "CONFIGURATION",
          "trackingNumber must contain 1 through 200 characters",
        );
      }

      const query = new URLSearchParams({
        carrier_code: carrierCode,
        tracking_number: trackingNumber,
      });
      const path = `/tracking/start?${query.toString()}`;
      await reserveRequestStart();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response;
      let responseText = "";
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "API-Key": apiKey },
          signal: controller.signal,
        });
        if (response.status !== 204) {
          responseText = await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES);
        }
      } catch (error) {
        if (error instanceof ShipStationTrackingResponseReadError) {
          throw new ShipStationTrackingSubscriptionError(
            "UNEXPECTED_RESPONSE",
            error.message,
            {
              responseBytes: error.responseBytes,
              maxResponseBytes: error.maxResponseBytes,
              carrierCode,
              trackingSuffix: trackingNumber.slice(-6),
            },
          );
        }
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ShipStationTrackingSubscriptionError(
          timedOut ? "TIMEOUT" : "NETWORK",
          timedOut
            ? `ShipStation tracking subscription timed out after ${requestTimeoutMs}ms`
            : `ShipStation tracking subscription failed: ${error instanceof Error ? error.message : String(error)}`,
          { carrierCode, trackingSuffix: trackingNumber.slice(-6) },
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.status !== 204) {
        throw new ShipStationTrackingSubscriptionError(
          response.ok ? "UNEXPECTED_RESPONSE" : "HTTP",
          `ShipStation tracking subscription returned HTTP ${response.status}`,
          {
            status: response.status,
            responseBody: responseText.slice(0, 500),
            carrierCode,
            trackingSuffix: trackingNumber.slice(-6),
          },
        );
      }

      return { httpStatus: 204 };
    },
  };
}

export function isRetryableTrackingSubscriptionError(error: unknown): boolean {
  if (!(error instanceof ShipStationTrackingSubscriptionError)) return false;
  if (error.code === "TIMEOUT" || error.code === "NETWORK") return true;
  if (error.code !== "HTTP") return false;
  const status = Number(error.context.status);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function trackingSubscriptionErrorEvidence(error: unknown): {
  code: string;
  message: string;
  httpStatus: number | null;
  details: Record<string, unknown>;
} {
  if (error instanceof ShipStationTrackingSubscriptionError) {
    const status = Number(error.context.status);
    return {
      code: `SHIPSTATION_TRACKING_${error.code}`,
      message: error.message,
      httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
      details: error.context,
    };
  }
  return {
    code: "SHIPSTATION_TRACKING_UNCLASSIFIED",
    message: error instanceof Error ? error.message : String(error),
    httpStatus: null,
    details: {},
  };
}
