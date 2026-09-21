import { z } from "zod";
import { SHIPSTATION_V1_TIME_ZONE, shipStationV1Instant } from "@shared/utils/shipstation-date";
import type { ShipStationApiRequester } from "./shipstation-api-request";
import type { ShipStationLabelRefreshSource } from "./shipstation-replacement-label-refresh.service";
import { LabelReconciliationError, ORDER_LABEL_PAGE_SIZE, VOID_PAGE_SIZE,
  type LabelScanSource, type ShipStationLabelPage } from "./shipstation-label-reconciliation.service";

const positiveId = z.number().int().positive().safe();
const optionalText = z.string().max(200).nullish();
const shipmentSchema = z.object({
  shipmentId: positiveId, orderId: positiveId.nullish(), orderKey: optionalText, orderNumber: optionalText,
  trackingNumber: z.string().trim().min(1).max(200), carrierCode: optionalText, serviceCode: optionalText,
  shipDate: optionalText, createDate: optionalText, voidDate: optionalText,
  voided: z.boolean().optional(), isReturnLabel: z.boolean().optional(),
  shipmentItems: z.unknown().optional(),
}).passthrough();
const pageSchema = z.object({ shipments: z.array(shipmentSchema).max(100), page: positiveId,
  pages: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe() });

const pacific = new Intl.DateTimeFormat("en-GB", { timeZone: SHIPSTATION_V1_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** V1 query dates use the same Pacific clock as its responses, not the host TZ. */
export function shipStationQueryDate(date: Date): string {
  z.date().parse(date);
  const parts = Object.fromEntries(pacific.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function createShipStationLabelReconciliationClient(request: ShipStationApiRequester, isConfigured: () => boolean): LabelScanSource & ShipStationLabelRefreshSource {
  async function read(params: URLSearchParams, expectedPage: number, pageSize: number, orderId?: number): Promise<ShipStationLabelPage> {
    params.set("includeShipmentItems", "true");
    params.set("page", String(expectedPage)); params.set("pageSize", String(pageSize));
    params.set("sortBy", "CreateDate"); params.set("sortDir", "ASC");
    const result = pageSchema.safeParse(await request<unknown>("GET", `/shipments?${params}`, undefined,
      { retries: 0, timeoutMs: 10_000 }));
    if (!result.success) throw new LabelReconciliationError("SHIPSTATION_LABEL_PAGE_INVALID");
    const page = result.data;
    // Some V1 single-page responses report pages=0. Accept that only when the
    // complete total fits this first page; never silently truncate a collection.
    const pages = page.pages === 0 && page.total === page.shipments.length && expectedPage === 1 ? 1 : page.pages;
    const expectedLength = Math.min(pageSize, Math.max(0, page.total - (expectedPage - 1) * pageSize));
    if (page.page !== expectedPage || pages !== Math.max(1, Math.ceil(page.total / pageSize))
      || expectedPage > pages || page.shipments.length !== expectedLength
      || new Set(page.shipments.map(label => label.shipmentId)).size !== page.shipments.length
      || (orderId !== undefined && page.shipments.some(label => label.orderId !== orderId))) {
      throw new LabelReconciliationError("SHIPSTATION_LABEL_PAGE_INCOMPLETE");
    }
    return { ...page, pages };
  }
  return {
    isConfigured,
    async listVoids(window) {
      z.number().int().positive().safe().parse(window.page);
      if (window.start >= window.end) throw new LabelReconciliationError("SHIPSTATION_LABEL_WINDOW_INVALID");
      const result = await read(new URLSearchParams({ voidDateStart: shipStationQueryDate(window.start),
        voidDateEnd: shipStationQueryDate(window.end) }), window.page, VOID_PAGE_SIZE);
      for (const label of result.shipments) {
        const voidedAt = shipStationV1Instant(label.voidDate, "voidDate");
        if (!voidedAt || label.voided === false) throw new LabelReconciliationError("SHIPSTATION_VOID_EVIDENCE_MISSING");
        if (voidedAt.getTime() < Math.floor(window.start.getTime() / 1000) * 1000
          || voidedAt.getTime() >= Math.floor(window.end.getTime() / 1000) * 1000 + 1000) {
          throw new LabelReconciliationError("SHIPSTATION_VOID_OUTSIDE_WINDOW");
        }
      }
      return result;
    },
    async listOrderLabels(orderId, page) {
      positiveId.parse(orderId); positiveId.parse(page);
      return read(new URLSearchParams({ orderId: String(orderId) }), page, ORDER_LABEL_PAGE_SIZE, orderId);
    },
    async listTrackingLabels(trackingNumber, page) {
      z.string().trim().min(1).max(200).parse(trackingNumber); positiveId.parse(page);
      return read(new URLSearchParams({ trackingNumber }), page, ORDER_LABEL_PAGE_SIZE);
    },
  };
}
