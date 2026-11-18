import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * A shipment fact: one package that a shipping engine reports as shipped, and
 * what the engine says was in it.
 *
 * Ownership: the shipping engine is the only source of these facts. A sales
 * channel reporting an order as "fulfilled" is that channel's own status and is
 * never a shipment. Facts are written once and never edited; a later void is a
 * separate fact that points at the shipment.
 */

/** Why an item was in the package. Only `fulfillment` counts toward the units
 * shipped for a purchased order line; the others are extra physical items. */
export const SHIPMENT_ITEM_PURPOSES = ["fulfillment", "replacement", "correction", "concession"] as const;
export type ShipmentItemPurpose = (typeof SHIPMENT_ITEM_PURPOSES)[number];

/** How the fact reached Echelon: reported as it happened, or read back from
 * the engine's own history. Both are the engine's record of the same event. */
export const SHIPMENT_FACT_SOURCES = ["engine_event", "history_import"] as const;
export type ShipmentFactSource = (typeof SHIPMENT_FACT_SOURCES)[number];

const MAX_ITEMS_PER_SHIPMENT = 500;
const calendarDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Expected YYYY-MM-DD");
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const shipmentFactItemSchema = z.object({
  /** Position of the item in the engine's report; stable for a given shipment. */
  lineNumber: z.number().int().min(1).max(MAX_ITEMS_PER_SHIPMENT),
  /** The sales channel's identifier for the purchased line, as the engine reported it. */
  channelLineRef: optionalText(200),
  /** The purchased order line this item belongs to, when it could be resolved. */
  omsOrderLineId: z.number().int().positive().safe().nullable(),
  sku: optionalText(200),
  quantity: z.number().int().min(1).max(1_000_000),
  purpose: z.enum(SHIPMENT_ITEM_PURPOSES),
}).strict();
export type ShipmentFactItem = z.infer<typeof shipmentFactItemSchema>;

export const shipmentFactSchema = z.object({
  /** Engine identifier, e.g. `shipstation`. Lowercase, never a sales channel. */
  engine: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  /** The engine's own identifier for this package. Unique within the engine. */
  engineShipmentId: z.string().trim().min(1).max(200),
  /** The calendar date the engine reports the package shipped. */
  shipDate: calendarDate,
  carrier: optionalText(100),
  serviceCode: optionalText(100),
  trackingNumber: optionalText(200),
  source: z.enum(SHIPMENT_FACT_SOURCES),
  items: z.array(shipmentFactItemSchema).max(MAX_ITEMS_PER_SHIPMENT),
}).strict().superRefine((fact, context) => {
  const seen = new Set<number>();
  for (const [index, item] of fact.items.entries()) {
    if (seen.has(item.lineNumber)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "lineNumber"], message: "Duplicate line number" });
    }
    seen.add(item.lineNumber);
  }
});
export type ShipmentFact = z.infer<typeof shipmentFactSchema>;

export const shipmentVoidFactSchema = z.object({
  engine: shipmentFactSchema.innerType().shape.engine,
  engineShipmentId: shipmentFactSchema.innerType().shape.engineShipmentId,
  /** The calendar date the engine reports the label was voided, when known. */
  voidDate: calendarDate.nullable(),
}).strict();
export type ShipmentVoidFact = z.infer<typeof shipmentVoidFactSchema>;

export type ShipmentFactErrorCode =
  | "SHIPMENT_FACT_INVALID"
  | "SHIPMENT_FACT_CONFLICT"
  | "SHIPMENT_FACT_NOT_FOUND";

/** Every code here is permanent: retrying the same input cannot succeed. */
export class ShipmentFactError extends Error {
  readonly classification = "permanent" as const;
  constructor(
    readonly code: ShipmentFactErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ShipmentFactError";
  }
}

export function parseShipmentFact(raw: unknown): ShipmentFact {
  const parsed = shipmentFactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ShipmentFactError("SHIPMENT_FACT_INVALID", "Shipment fact is not valid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

/**
 * Fingerprint of what the engine reported. Excludes `source` and the resolved
 * order line, so the same shipment arriving as a live event and again from a
 * history import is recognised as one fact, while a report that disagrees with
 * the saved one is detected rather than silently overwriting it.
 */
export function shipmentFactContentHash(fact: ShipmentFact): string {
  const reported = [
    fact.engine, fact.engineShipmentId, fact.shipDate, fact.carrier, fact.serviceCode, fact.trackingNumber,
    [...fact.items]
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .map((item) => [item.lineNumber, item.channelLineRef, item.sku, item.quantity, item.purpose]),
  ];
  return createHash("sha256").update(JSON.stringify(reported)).digest("hex");
}
