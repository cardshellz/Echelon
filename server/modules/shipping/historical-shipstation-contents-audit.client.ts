import { z } from "zod";

import {
  normalizeShipStationShipmentContentsEvidence,
  type ShipStationShipmentContentsEvidenceStatus,
} from "./carrier-tracking.domain";
import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "./shipstation-tracking-http";

const DEFAULT_BASE_URL = "https://ssapi.shipstation.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 500;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const shipmentSchema = z.object({
  shipmentId: z.number().int().positive().safe(),
  shipmentItems: z.unknown().optional(),
}).passthrough();

const responseSchema = z.object({
  shipments: z.array(shipmentSchema).max(10).default([]),
}).passthrough();

export interface HistoricalShipStationContentsEvidenceSummary {
  readonly status: ShipStationShipmentContentsEvidenceStatus;
  readonly providerItemCount: number;
  readonly recognizedProviderItemCount: number;
  readonly canonicalLineCount: number;
  readonly malformedItemCount: number;
  readonly unrecognizedItemCount: number;
  readonly duplicateLineItemCount: number;
}

export type HistoricalShipStationContentsLookupResult =
  | Readonly<{ readonly kind: "not_found" }>
  | Readonly<{
      readonly kind: "found";
      readonly evidence: HistoricalShipStationContentsEvidenceSummary;
    }>;

export interface HistoricalShipStationContentsClient {
  loadShipmentContents(providerShipmentId: number): Promise<HistoricalShipStationContentsLookupResult>;
}

export type HistoricalShipStationContentsClientErrorCode =
  | "CONFIGURATION"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "INVALID_RESPONSE";

export class HistoricalShipStationContentsClientError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsClientErrorCode,
    message: string,
    readonly context: Readonly<Record<string, number>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsClientError";
  }
}

export interface HistoricalShipStationContentsClientConfig {
  readonly apiKey?: string;
  readonly apiSecret?: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly minimumRequestIntervalMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (milliseconds: number) => Promise<void>;
  readonly nowMs?: () => number;
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HistoricalShipStationContentsClientError(
      "CONFIGURATION",
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function exactCredential(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new HistoricalShipStationContentsClientError(
      "CONFIGURATION",
      `${field} is required without surrounding whitespace`,
    );
  }
  return value;
}

function normalizedBaseUrl(value: string | undefined): string {
  const parsed = new URL(value ?? DEFAULT_BASE_URL);
  if (
    parsed.protocol !== "https:"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname !== "/"
  ) {
    throw new HistoricalShipStationContentsClientError(
      "CONFIGURATION",
      "ShipStation audit baseUrl must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return parsed.origin;
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const rawHeader = response.headers.get("x-rate-limit-reset")
    ?? response.headers.get("retry-after");
  const seconds = rawHeader === null ? Number.NaN : Number(rawHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.ceil(seconds * 1_000));
  }
  return Math.min(60_000, baseDelayMs * (2 ** attempt));
}

export function createHistoricalShipStationContentsClient(
  config: HistoricalShipStationContentsClientConfig = {},
): HistoricalShipStationContentsClient {
  const apiKey = exactCredential(config.apiKey ?? process.env.SHIPSTATION_API_KEY, "SHIPSTATION_API_KEY");
  const apiSecret = exactCredential(
    config.apiSecret ?? process.env.SHIPSTATION_API_SECRET,
    "SHIPSTATION_API_SECRET",
  );
  const baseUrl = normalizedBaseUrl(config.baseUrl);
  const requestTimeoutMs = boundedInteger(
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
    1_000,
    60_000,
  );
  const minimumRequestIntervalMs = boundedInteger(
    config.minimumRequestIntervalMs ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS,
    "minimumRequestIntervalMs",
    0,
    60_000,
  );
  const maxRetries = boundedInteger(
    config.maxRetries ?? DEFAULT_MAX_RETRIES,
    "maxRetries",
    0,
    5,
  );
  const retryBaseDelayMs = boundedInteger(
    config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    "retryBaseDelayMs",
    0,
    60_000,
  );
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleepImpl = config.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const nowMs = config.nowMs ?? Date.now;
  const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

  let nextRequestStartAtMs = 0;
  let requestSequence = Promise.resolve();
  const reserveRequestStart = (): Promise<void> => {
    const reservation = requestSequence.then(async () => {
      const waitMs = Math.max(0, nextRequestStartAtMs - nowMs());
      if (waitMs > 0) await sleepImpl(waitMs);
      nextRequestStartAtMs = nowMs() + minimumRequestIntervalMs;
    });
    requestSequence = reservation.catch(() => undefined);
    return reservation;
  };

  return Object.freeze({
    async loadShipmentContents(providerShipmentId: number) {
      if (!Number.isSafeInteger(providerShipmentId) || providerShipmentId <= 0) {
        throw new HistoricalShipStationContentsClientError(
          "INVALID_INPUT",
          "providerShipmentId must be a positive safe integer",
        );
      }
      const path = `/shipments?${new URLSearchParams({
        shipmentId: String(providerShipmentId),
        includeShipmentItems: "true",
      }).toString()}`;
      const requestUrl = `${baseUrl}${path}`;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await reserveRequestStart();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response: Response;
        let responseText: string;
        try {
          response = await fetchImpl(requestUrl, {
            method: "GET",
            headers: {
              Authorization: authorization,
              Accept: "application/json",
            },
            signal: controller.signal,
          });
          responseText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
        } catch (error) {
          if (attempt < maxRetries) {
            await sleepImpl(Math.min(60_000, retryBaseDelayMs * (2 ** attempt)));
            continue;
          }
          if (error instanceof ShipStationTrackingResponseReadError) {
            throw new HistoricalShipStationContentsClientError(
              "INVALID_RESPONSE",
              "ShipStation historical contents response exceeded the accepted size",
              Object.freeze({ responseBytes: error.responseBytes }),
              { cause: error },
            );
          }
          const timedOut = error instanceof Error && error.name === "AbortError";
          throw new HistoricalShipStationContentsClientError(
            timedOut ? "TIMEOUT" : "NETWORK",
            timedOut
              ? "ShipStation historical contents request timed out"
              : "ShipStation historical contents request failed",
            Object.freeze({}),
            { cause: error },
          );
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const retryable = response.status === 408
            || response.status === 425
            || response.status === 429
            || response.status >= 500;
          if (retryable && attempt < maxRetries) {
            await sleepImpl(retryDelayMs(response, attempt, retryBaseDelayMs));
            continue;
          }
          throw new HistoricalShipStationContentsClientError(
            "HTTP",
            "ShipStation historical contents request returned an unsuccessful status",
            Object.freeze({ status: response.status }),
          );
        }

        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(responseText);
        } catch (error) {
          throw new HistoricalShipStationContentsClientError(
            "INVALID_RESPONSE",
            "ShipStation historical contents response was not valid JSON",
            Object.freeze({}),
            { cause: error },
          );
        }
        const parsed = responseSchema.safeParse(rawPayload);
        if (!parsed.success) {
          throw new HistoricalShipStationContentsClientError(
            "INVALID_RESPONSE",
            "ShipStation historical contents response failed validation",
          );
        }
        const matches = parsed.data.shipments.filter(
          (shipment) => shipment.shipmentId === providerShipmentId,
        );
        if (matches.length === 0) return Object.freeze({ kind: "not_found" as const });
        if (matches.length !== 1) {
          throw new HistoricalShipStationContentsClientError(
            "INVALID_RESPONSE",
            "ShipStation historical contents response contained duplicate shipment identity",
          );
        }
        const evidence = normalizeShipStationShipmentContentsEvidence(
          matches[0].shipmentItems,
        );
        return Object.freeze({
          kind: "found" as const,
          evidence: Object.freeze({
            status: evidence.status,
            providerItemCount: evidence.providerItemCount,
            recognizedProviderItemCount: evidence.recognizedProviderItemCount,
            canonicalLineCount: evidence.shipmentItems.length,
            malformedItemCount: evidence.malformedItemCount,
            unrecognizedItemCount: evidence.unrecognizedItemCount,
            duplicateLineItemCount: evidence.duplicateLineItemCount,
          }),
        });
      }

      throw new HistoricalShipStationContentsClientError(
        "NETWORK",
        "ShipStation historical contents request exhausted its retry budget",
      );
    },
  });
}
