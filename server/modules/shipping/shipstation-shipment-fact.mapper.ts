import { z } from "zod";
import {
  parseShipmentFact, ShipmentFactError, type ShipmentFact, type ShipmentFactSource, type ShipmentVoidFact,
} from "./shipment-fact.domain";

export const SHIPSTATION_ENGINE = "shipstation";

/**
 * The fields of a ShipStation V1 `/shipments` record that a shipment fact
 * needs. Everything else in the payload (addresses, customer email, label
 * data, cost) is deliberately not read here.
 */
const shipStationShipmentSchema = z.object({
  shipmentId: z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/)]),
  shipDate: z.string().min(10),
  trackingNumber: z.string().nullish(),
  carrierCode: z.string().nullish(),
  serviceCode: z.string().nullish(),
  isReturnLabel: z.boolean().nullish(),
  voided: z.boolean().nullish(),
  voidDate: z.string().nullish(),
  shipmentItems: z.array(z.object({
    lineItemKey: z.union([z.string(), z.number()]).nullish(),
    sku: z.string().nullish(),
    quantity: z.number().int(),
  }).passthrough()).nullish(),
}).passthrough();

export type ShipStationShipmentFact =
  /** A label for a parcel coming back; return shipments are not outbound facts. */
  | { kind: "return_label"; engineShipmentId: string }
  | { kind: "outbound"; fact: ShipmentFact; void: ShipmentVoidFact | null };

const text = (value: string | number | null | undefined): string | null => {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
};

/** ShipStation dates begin with the calendar date; its time part carries no
 * zone, so only the date is taken rather than guessing an offset. */
const calendarDate = (value: string): string => value.slice(0, 10);

/**
 * Translate one ShipStation shipment into a shipment fact. Pure: resolving the
 * purchased order line is the caller's job, through `resolveOrderLine`, so this
 * module never reads another system's tables.
 *
 * Items ShipStation reports with a non-positive quantity are dropped: they say
 * nothing shipped. Every remaining item is recorded as `fulfillment`; ShipStation
 * does not report replacements or concessions as such.
 */
export function mapShipStationShipment(
  raw: unknown,
  source: ShipmentFactSource,
  resolveOrderLine: (channelLineRef: string) => number | null,
): ShipStationShipmentFact {
  const parsed = shipStationShipmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ShipmentFactError("SHIPMENT_FACT_INVALID", "ShipStation shipment is not valid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const shipment = parsed.data;
  const engineShipmentId = String(shipment.shipmentId);
  if (shipment.isReturnLabel === true) return { kind: "return_label", engineShipmentId };

  const items = (shipment.shipmentItems ?? [])
    .map((item, index) => ({ item, lineNumber: index + 1 }))
    .filter(({ item }) => item.quantity > 0)
    .map(({ item, lineNumber }) => {
      const channelLineRef = text(item.lineItemKey);
      return {
        lineNumber,
        channelLineRef,
        omsOrderLineId: channelLineRef === null ? null : resolveOrderLine(channelLineRef),
        sku: text(item.sku),
        quantity: item.quantity,
        purpose: "fulfillment" as const,
      };
    });

  const fact = parseShipmentFact({
    engine: SHIPSTATION_ENGINE,
    engineShipmentId,
    shipDate: calendarDate(shipment.shipDate),
    carrier: text(shipment.carrierCode),
    serviceCode: text(shipment.serviceCode),
    trackingNumber: text(shipment.trackingNumber),
    source,
    items,
  });
  const voidDate = text(shipment.voidDate);
  return {
    kind: "outbound",
    fact,
    void: shipment.voided === true
      ? { engine: SHIPSTATION_ENGINE, engineShipmentId, voidDate: voidDate === null ? null : calendarDate(voidDate) }
      : null,
  };
}
