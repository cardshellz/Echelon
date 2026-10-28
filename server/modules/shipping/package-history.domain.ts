import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  PACKAGE_HISTORY_LIMIT,
  packageHistoryDocumentSchema,
  packageHistoryScopeSchema,
  packageHistoryNativeSchema,
  type PackageHistoryDocument,
} from "@shared/shipping/package-history";
export {
  packageHistoryScopeSchema,
  packageHistoryNativeSchema,
} from "@shared/shipping/package-history";
import { normalizeShipStationPackageDimensions } from "./shipstation-package-dimensions.domain";
import {
  shippingPackageDimensionsSchema,
  type ShippingPackageDimensions,
} from "@shared/shipping/package-dimensions";

const id = z.number().int().positive().safe();
export type PackageHistoryScope = z.infer<typeof packageHistoryScopeSchema>;
export type PackageHistoryNative = z.infer<typeof packageHistoryNativeSchema>;
interface ShopifyPackageObservation {
  order: { id: string; name: string; customerId?: string | null };
  lines: readonly {
    id: string;
    sku: string | null;
    quantity: number;
    requiresShipping: boolean;
  }[];
  fulfillments: readonly {
    id: string;
    status: string;
    updatedAt: string;
    tracking: readonly { number: string | null }[];
    lines: readonly { lineItemId: string; quantity: number }[];
  }[];
}
export function packageHistoryNativeFromShopify(
  snapshot: ShopifyPackageObservation,
): PackageHistoryNative {
  const identity = (resource: string, value: string): string => {
    const match = new RegExp(
      `^(?:gid://shopify/${resource}/)?([1-9][0-9]*)$`,
    ).exec(value);
    if (!match)
      throw new PackageHistoryError("PACKAGE_HISTORY_IDENTITY_INVALID");
    return match[1];
  };
  return packageHistoryNativeSchema.parse({
    orderId: identity("Order", snapshot.order.id),
    reference: snapshot.order.name,
    customerId:
      snapshot.order.customerId == null
        ? null
        : identity("Customer", snapshot.order.customerId),
    lines: snapshot.lines.map((line) => ({
      id: identity("LineItem", line.id),
      quantity: line.quantity,
      sku: line.sku,
      requiresShipping: line.requiresShipping,
    })),
    fulfillments: snapshot.fulfillments.map((f) => ({
      id: identity("Fulfillment", f.id),
      status: f.status,
      updatedAt: f.updatedAt,
      tracking: f.tracking
        .map((item) => item.number)
        .filter((number): number is string => number !== null),
      lines: f.lines.map((item) => ({
        lineItemId: identity("LineItem", item.lineItemId),
        quantity: item.quantity,
      })),
    })),
  });
}
export const packageHistoryShipmentSchema = z
  .object({
    shipmentId: id,
    orderNumber: z.string().min(1).max(50),
    trackingNumber: z.string().trim().min(1).max(200),
    isReturnLabel: z.boolean(),
    voided: z.boolean(),
    voidDate: z.string().nullish(),
    dimensions: z.unknown().optional(),
    shipmentItems: z
      .array(
        z
          .object({
            lineItemKey: z.string().min(1).max(200),
            quantity: z.number().int().positive().safe(),
            sku: z.string().max(100).nullable().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(PACKAGE_HISTORY_LIMIT),
  })
  .passthrough();
export type PackageHistoryShipment = z.infer<
  typeof packageHistoryShipmentSchema
>;
export interface RetainedPackageHistoryShipment {
  shipment: PackageHistoryShipment;
  observationHash: string;
  recordedDimensions?: ShippingPackageDimensions;
}
export class PackageHistoryError extends Error {
  constructor(
    readonly code: string,
    readonly classification: "review" | "transient" = "review",
  ) {
    super(code);
    this.name = "PackageHistoryError";
  }
}
export function packageHistoryHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function normalizedNative(raw: PackageHistoryNative): PackageHistoryNative {
  const native = packageHistoryNativeSchema.parse(raw);
  return {
    ...native,
    lines: [...native.lines].sort((a, b) => a.id.localeCompare(b.id)),
    fulfillments: native.fulfillments
      .map((f) => ({
        ...f,
        tracking: [...f.tracking].sort(),
        lines: [...f.lines].sort((a, b) =>
          a.lineItemId.localeCompare(b.lineItemId),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function packageHistoryNativeRevision(
  raw: PackageHistoryNative,
): string {
  const native = normalizedNative(raw);
  // Delivery timestamps belong to eligibility. Keep them in the audit record,
  // but they do not change the identity or contents of an original package.
  return packageHistoryHash({
    ...native,
    fulfillments: native.fulfillments.map(
      ({ updatedAt: _time, ...facts }) => facts,
    ),
  });
}
function reference(value: string): string {
  return value.replace(/^#/, "");
}
function fail(code: string): never {
  throw new PackageHistoryError(code);
}
function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

/** A historical package is proven by source IDs and the WHOLE native fulfillment,
 * never by a SKU match. This function cannot create operational shipment work. */
export function buildPackageHistory(
  rawScope: PackageHistoryScope,
  rawNative: PackageHistoryNative,
  observations: readonly RetainedPackageHistoryShipment[],
): PackageHistoryDocument {
  const scope = packageHistoryScopeSchema.parse(rawScope),
    native = normalizedNative(rawNative);
  if (
    scope.externalOrderId !== native.orderId ||
    reference(scope.orderReference) !== reference(native.reference) ||
    (scope.externalCustomerId !== null &&
      scope.externalCustomerId !== native.customerId)
  )
    fail("PACKAGE_HISTORY_ORDER_MISMATCH");
  unique(
    scope.lines.map((line) => line.externalLineId),
    "PACKAGE_HISTORY_LINE_AMBIGUOUS",
  );
  unique(
    native.lines.map((line) => line.id),
    "PACKAGE_HISTORY_LINE_AMBIGUOUS",
  );
  unique(
    native.fulfillments.map((f) => f.id),
    "PACKAGE_HISTORY_FULFILLMENT_AMBIGUOUS",
  );
  if (scope.lines.length !== native.lines.length)
    fail("PACKAGE_HISTORY_LINES_CHANGED");
  const aliases = new Map<string, PackageHistoryScope["lines"][number]>();
  for (const line of scope.lines) {
    const source = native.lines.find((item) => item.id === line.externalLineId);
    if (
      !source ||
      source.quantity !== line.quantity ||
      source.requiresShipping !== line.requiresShipping
    )
      fail("PACKAGE_HISTORY_LINES_CHANGED");
    for (const alias of [
      line.externalLineId,
      `gid://shopify/LineItem/${line.externalLineId}`,
      ...line.aliases,
    ]) {
      if (
        aliases.has(alias) &&
        aliases.get(alias)!.omsOrderLineId !== line.omsOrderLineId
      )
        fail("PACKAGE_HISTORY_ALIAS_AMBIGUOUS");
      aliases.set(alias, line);
    }
  }
  const packages: PackageHistoryDocument["packages"] = [],
    used = new Set<number>(),
    totals = new Map<string, number>();
  unique(
    observations.map((item) => String(item.shipment.shipmentId)),
    "PACKAGE_HISTORY_LABEL_AMBIGUOUS",
  );
  for (const fulfillment of native.fulfillments) {
    if (fulfillment.status !== "SUCCESS") continue;
    const expected = new Map<string, number>();
    for (const item of fulfillment.lines) {
      const line = scope.lines.find(
        (line) => line.externalLineId === item.lineItemId,
      );
      if (!line) fail("PACKAGE_HISTORY_FOREIGN_LINE");
      if (!line.requiresShipping || item.quantity === 0) continue;
      expected.set(
        item.lineItemId,
        (expected.get(item.lineItemId) ?? 0) + item.quantity,
      );
    }
    if (!expected.size) continue; // Memberships have no physical package.
    unique(fulfillment.tracking, "PACKAGE_HISTORY_TRACKING_AMBIGUOUS");
    if (!fulfillment.tracking.length) fail("PACKAGE_HISTORY_TRACKING_MISSING");
    const allocated = new Map<string, number>();
    for (const tracking of fulfillment.tracking) {
      const matches = observations.filter(
        (item) =>
          item.shipment.trackingNumber === tracking &&
          !item.shipment.isReturnLabel &&
          !item.shipment.voided &&
          !item.shipment.voidDate,
      );
      if (matches.length === 0)
        throw new PackageHistoryError(
          "PACKAGE_HISTORY_LABEL_MISSING",
          "transient",
        );
      if (matches.length !== 1) fail("PACKAGE_HISTORY_LABEL_AMBIGUOUS");
      const retained = matches[0],
        shipment = packageHistoryShipmentSchema.parse(retained.shipment);
      if (
        reference(shipment.orderNumber) !== reference(scope.orderReference) ||
        used.has(shipment.shipmentId)
      )
        fail("PACKAGE_HISTORY_PACKAGE_AMBIGUOUS");
      used.add(shipment.shipmentId);
      const lineCounts = new Map<
        number,
        { externalLineId: string; quantity: number }
      >();
      unique(
        shipment.shipmentItems.map((item) => item.lineItemKey),
        "PACKAGE_HISTORY_ITEM_AMBIGUOUS",
      );
      for (const item of shipment.shipmentItems) {
        const line = aliases.get(item.lineItemKey);
        if (
          !line ||
          !line.requiresShipping ||
          !expected.has(line.externalLineId) ||
          (item.sku != null && line.sku !== null && item.sku !== line.sku)
        )
          fail("PACKAGE_HISTORY_FOREIGN_LINE");
        const previous = lineCounts.get(line.omsOrderLineId)?.quantity ?? 0;
        const quantity = previous + item.quantity;
        if (!Number.isSafeInteger(quantity))
          fail("PACKAGE_HISTORY_QUANTITY_INVALID");
        lineCounts.set(line.omsOrderLineId, {
          externalLineId: line.externalLineId,
          quantity,
        });
        allocated.set(
          line.externalLineId,
          (allocated.get(line.externalLineId) ?? 0) + item.quantity,
        );
      }
      const observedMeasurement = normalizeShipStationPackageDimensions(
        shipment.dimensions,
      );
      const recordedDimensions =
        retained.recordedDimensions === undefined
          ? undefined
          : shippingPackageDimensionsSchema.parse(retained.recordedDimensions);
      const measurement =
        observedMeasurement ??
        (recordedDimensions
          ? {
              version: 1 as const,
              status: "verified" as const,
              dimensions: recordedDimensions,
            }
          : null);
      packages.push({
        provider: "shipstation",
        providerShipmentId: String(shipment.shipmentId),
        fulfillmentId: fulfillment.id,
        trackingNumber: tracking,
        providerObservationHash: retained.observationHash,
        providerLineItems: shipment.shipmentItems.map((item) => ({
          lineItemKey: item.lineItemKey,
          quantity: item.quantity,
        })),
        dimensions:
          measurement?.status === "verified" ? measurement.dimensions : null,
        measurementStatus:
          measurement === null ? "missing" : measurement.status,
        measurementSource:
          observedMeasurement !== null
            ? "provider"
            : recordedDimensions
              ? "retained"
              : "missing",
        lines: [...lineCounts]
          .map(([omsOrderLineId, value]) => ({ omsOrderLineId, ...value }))
          .sort((a, b) => a.omsOrderLineId - b.omsOrderLineId),
      });
    }
    if (
      expected.size !== allocated.size ||
      [...expected].some(([line, quantity]) => allocated.get(line) !== quantity)
    )
      fail("PACKAGE_HISTORY_QUANTITY_MISMATCH");
    for (const [line, quantity] of allocated)
      totals.set(line, (totals.get(line) ?? 0) + quantity);
  }
  if (
    [...totals].some(
      ([line, quantity]) =>
        !Number.isSafeInteger(quantity) ||
        quantity >
          scope.lines.find((item) => item.externalLineId === line)!.quantity,
    )
  )
    fail("PACKAGE_HISTORY_QUANTITY_EXCEEDED");
  return packageHistoryDocumentSchema.parse({
    version: 1,
    omsOrderId: scope.omsOrderId,
    channelId: scope.channelId,
    externalOrderId: scope.externalOrderId,
    sourceRevision: packageHistoryHash(scope),
    nativeRevision: packageHistoryNativeRevision(native),
    sourceEvidence: scope,
    nativeEvidence: native,
    packages: packages.sort((a, b) =>
      a.providerShipmentId.localeCompare(b.providerShipmentId),
    ),
  });
}

/** Recheck durable allocation proofs at every read boundary. A copied revision
 * hash alone must never turn modified package lines into trusted evidence. */
export function verifyPackageHistoryDocument(
  raw: unknown,
): PackageHistoryDocument {
  const document = packageHistoryDocumentSchema.parse(raw);
  if (
    document.omsOrderId !== document.sourceEvidence.omsOrderId ||
    document.channelId !== document.sourceEvidence.channelId ||
    document.externalOrderId !== document.sourceEvidence.externalOrderId ||
    document.sourceRevision !== packageHistoryHash(document.sourceEvidence) ||
    document.nativeRevision !==
      packageHistoryNativeRevision(document.nativeEvidence)
  )
    fail("PACKAGE_HISTORY_DOCUMENT_INVALID");
  const reconstructed = buildPackageHistory(
    document.sourceEvidence,
    document.nativeEvidence,
    document.packages.map((box) => ({
      observationHash: box.providerObservationHash,
      shipment: {
        shipmentId: Number(box.providerShipmentId),
        orderNumber: document.sourceEvidence.orderReference,
        trackingNumber: box.trackingNumber,
        isReturnLabel: false,
        voided: false,
        voidDate: null,
        shipmentItems: box.providerLineItems,
      },
    })),
  );
  const allocation = (value: PackageHistoryDocument) =>
    value.packages.map(
      ({
        dimensions: _size,
        measurementStatus: _status,
        measurementSource: _source,
        ...facts
      }) => facts,
    );
  if (
    packageHistoryHash(allocation(document)) !==
    packageHistoryHash(allocation(reconstructed))
  )
    fail("PACKAGE_HISTORY_DOCUMENT_INVALID");
  return document;
}
