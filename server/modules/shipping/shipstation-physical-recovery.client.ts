import { z } from "zod";
import {
  normalizeShipStationTrackingApiBaseUrl,
  resolveShipStationTrackingApiKey,
} from "./shipstation-tracking-api-config";
import {
  readBoundedResponseText,
  ShipStationTrackingResponseReadError,
} from "./shipstation-tracking-http";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 500;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 10;

const seIdSchema = z.string().trim().min(4).max(25).regex(/^se-[a-z0-9-]+$/);
const nullableText = z.string().trim().max(500).nullable().optional();
const shipmentItemSchema = z.object({
  external_order_item_id: nullableText,
  line_item_key: nullableText,
  lineItemKey: nullableText,
}).passthrough();
const shipmentSchema = z.object({
  shipment_id: seIdSchema,
  shipment_number: nullableText,
  external_shipment_id: nullableText,
  items: z.array(shipmentItemSchema).max(2_000).default([]),
}).passthrough();
const shipmentPageSchema = z.object({
  shipments: z.array(shipmentSchema).max(PAGE_SIZE),
  page: z.number().int().positive().optional(),
  pages: z.number().int().nonnegative().optional(),
}).passthrough();
const labelSchema = z.object({
  label_id: seIdSchema,
  status: z.enum(["processing", "completed", "error", "voided"]),
  shipment_id: seIdSchema,
  tracking_number: z.string().trim().min(1).max(200),
  is_return_label: z.boolean().optional().default(false),
  ship_date: nullableText,
  carrier_code: nullableText,
  service_code: nullableText,
}).passthrough();
const labelPageSchema = z.object({
  labels: z.array(labelSchema).max(PAGE_SIZE),
  page: z.number().int().positive().optional(),
  pages: z.number().int().nonnegative().optional(),
}).passthrough();

export interface ShipStationCompletedPhysicalPackage {
  providerShipmentId: string;
  providerLabelId: string;
  legacyShipStationShipmentId: number;
  trackingNumber: string;
  shipDate: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  wmsShipmentItemIds: number[];
}

export interface ShipStationPhysicalRecoveryClient {
  isConfigured(): boolean;
  listCompletedPackagesForOrder(orderNumber: string): Promise<ShipStationCompletedPhysicalPackage[]>;
}

export type ShipStationPhysicalRecoveryErrorCode =
  | "CONFIGURATION"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "INVALID_RESPONSE";

export class ShipStationPhysicalRecoveryError extends Error {
  constructor(
    readonly code: ShipStationPhysicalRecoveryErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipStationPhysicalRecoveryError";
  }
}

export interface ShipStationPhysicalRecoveryClientConfig {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  minimumRequestIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}

function parsePositiveSeNumericId(value: string): number | null {
  const match = /^se-([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseWmsShipmentItemIdentity(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^wms-item-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function shipmentItemIdentity(item: z.infer<typeof shipmentItemSchema>): number | null {
  return parseWmsShipmentItemIdentity(
    item.external_order_item_id ?? item.line_item_key ?? item.lineItemKey,
  );
}

function validateIntegerRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ShipStationPhysicalRecoveryError(
      "CONFIGURATION",
      `${label} must be an integer from ${minimum} through ${maximum}`,
      { [label]: value },
    );
  }
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const header = response.headers.get("retry-after");
  const headerSeconds = header == null ? Number.NaN : Number(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.min(60_000, Math.ceil(headerSeconds * 1_000));
  }
  return Math.min(60_000, baseDelayMs * (2 ** attempt));
}

export function createShipStationPhysicalRecoveryClient(
  config: ShipStationPhysicalRecoveryClientConfig = {},
): ShipStationPhysicalRecoveryClient {
  const apiKey = resolveShipStationTrackingApiKey(config.apiKey);
  const baseUrl = normalizeShipStationTrackingApiBaseUrl(config.baseUrl);
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const minimumRequestIntervalMs = config.minimumRequestIntervalMs
    ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleepImpl = config.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const nowMs = config.nowMs ?? Date.now;

  validateIntegerRange(requestTimeoutMs, "requestTimeoutMs", 1_000, 60_000);
  validateIntegerRange(minimumRequestIntervalMs, "minimumRequestIntervalMs", 0, 60_000);
  validateIntegerRange(maxRetries, "maxRetries", 0, 5);
  validateIntegerRange(retryBaseDelayMs, "retryBaseDelayMs", 0, 60_000);

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

  const requestJson = async (path: string): Promise<unknown> => {
    if (!apiKey) {
      throw new ShipStationPhysicalRecoveryError(
        "CONFIGURATION",
        "SHIPSTATION_V2_API_KEY is required for physical-shipment recovery",
      );
    }
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
          headers: { "API-Key": apiKey },
          signal: controller.signal,
        });
        responseText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (attempt < maxRetries) {
          await sleepImpl(Math.min(60_000, retryBaseDelayMs * (2 ** attempt)));
          continue;
        }
        if (error instanceof ShipStationTrackingResponseReadError) {
          throw new ShipStationPhysicalRecoveryError("INVALID_RESPONSE", error.message, {
            requestPath: path,
            responseBytes: error.responseBytes,
          });
        }
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ShipStationPhysicalRecoveryError(
          timedOut ? "TIMEOUT" : "NETWORK",
          timedOut
            ? `ShipStation physical recovery timed out after ${requestTimeoutMs}ms`
            : `ShipStation physical recovery request failed: ${error instanceof Error ? error.message : String(error)}`,
          { requestPath: path },
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
        throw new ShipStationPhysicalRecoveryError(
          "HTTP",
          `ShipStation physical recovery returned HTTP ${response.status}`,
          { requestPath: path, status: response.status, responseBody: responseText.slice(0, 500) },
        );
      }

      try {
        return JSON.parse(responseText);
      } catch {
        throw new ShipStationPhysicalRecoveryError(
          "INVALID_RESPONSE",
          "ShipStation physical recovery returned invalid JSON",
          { requestPath: path, responseBody: responseText.slice(0, 500) },
        );
      }
    }
    throw new ShipStationPhysicalRecoveryError(
      "NETWORK",
      "ShipStation physical recovery exhausted its retry budget",
      { requestPath: path },
    );
  };

  const listAllPages = async <T>(
    pathForPage: (page: number) => string,
    schema: z.ZodType<{ page?: number; pages?: number } & T>,
    rows: (page: T) => unknown[],
  ): Promise<unknown[]> => {
    const accumulated: unknown[] = [];
    for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_QUERY; pageNumber += 1) {
      const parsed = schema.safeParse(await requestJson(pathForPage(pageNumber)));
      if (!parsed.success) {
        throw new ShipStationPhysicalRecoveryError(
          "INVALID_RESPONSE",
          "ShipStation physical recovery response failed validation",
          { requestPath: pathForPage(pageNumber), issues: parsed.error.issues },
        );
      }
      const pageRows = rows(parsed.data as T);
      accumulated.push(...pageRows);
      const pages = parsed.data.pages ?? parsed.data.page ?? 1;
      if (pageRows.length < PAGE_SIZE || pageNumber >= pages) return accumulated;
    }
    throw new ShipStationPhysicalRecoveryError(
      "INVALID_RESPONSE",
      `ShipStation physical recovery exceeded ${MAX_PAGES_PER_QUERY} pages`,
    );
  };

  return {
    isConfigured: () => apiKey.length > 0,

    async listCompletedPackagesForOrder(orderNumber) {
      const normalizedOrderNumber = orderNumber.trim();
      if (!normalizedOrderNumber || normalizedOrderNumber.length > 50) {
        throw new ShipStationPhysicalRecoveryError(
          "INVALID_INPUT",
          "orderNumber must contain 1 through 50 characters",
        );
      }

      const shipmentRows = await listAllPages(
        (page) => `/shipments?${new URLSearchParams({
          shipment_number: normalizedOrderNumber,
          page: String(page),
          page_size: String(PAGE_SIZE),
        }).toString()}`,
        shipmentPageSchema,
        (payload) => (payload as z.infer<typeof shipmentPageSchema>).shipments,
      ) as Array<z.infer<typeof shipmentSchema>>;

      const packages = new Map<number, ShipStationCompletedPhysicalPackage>();
      for (const shipment of shipmentRows) {
        const wmsShipmentItemIds = [...new Set(
          shipment.items
            .map(shipmentItemIdentity)
            .filter((id): id is number => id !== null),
        )].sort((left, right) => left - right);
        if (wmsShipmentItemIds.length === 0) continue;

        const labelRows = await listAllPages(
          (page) => `/labels?${new URLSearchParams({
            shipment_id: shipment.shipment_id,
            label_status: "completed",
            page: String(page),
            page_size: String(PAGE_SIZE),
          }).toString()}`,
          labelPageSchema,
          (payload) => (payload as z.infer<typeof labelPageSchema>).labels,
        ) as Array<z.infer<typeof labelSchema>>;

        for (const label of labelRows) {
          if (label.status !== "completed" || label.is_return_label) continue;
          const legacyShipStationShipmentId = parsePositiveSeNumericId(label.label_id);
          if (legacyShipStationShipmentId === null) continue;
          packages.set(legacyShipStationShipmentId, {
            providerShipmentId: shipment.shipment_id,
            providerLabelId: label.label_id,
            legacyShipStationShipmentId,
            trackingNumber: label.tracking_number,
            shipDate: label.ship_date ?? null,
            carrierCode: label.carrier_code ?? null,
            serviceCode: label.service_code ?? null,
            wmsShipmentItemIds,
          });
        }
      }
      return [...packages.values()].sort(
        (left, right) => left.legacyShipStationShipmentId - right.legacyShipStationShipmentId,
      );
    },
  };
}
