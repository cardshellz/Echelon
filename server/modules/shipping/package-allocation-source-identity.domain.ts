import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX_TEXT = "9223372036854775807";
const positivePostgresInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nullablePositivePostgresInteger = positivePostgresInteger.nullable();
const positiveBigintText = z.string()
  .max(19)
  .regex(/^[1-9][0-9]*$/)
  .refine(
    (value) => value.length < POSTGRES_BIGINT_MAX_TEXT.length
      || (value.length === POSTGRES_BIGINT_MAX_TEXT.length && value <= POSTGRES_BIGINT_MAX_TEXT),
    "exceeds PostgreSQL bigint",
  )
  .nullable();
const nullableSku = z.string().max(100).nullable();

export const packageAllocationSourceFactsSchema = z.object({
  sourceWmsShipmentItemId: positivePostgresInteger,
  shipmentRequestItemId: positiveBigintText,
  sourceQuantity: positivePostgresInteger,
  shipmentItemPurpose: z.enum([
    "customer_fulfillment",
    "replacement",
    "concession",
    "omission_correction",
    "unclassified",
  ]),
  orderItemId: nullablePositivePostgresInteger,
  replacementForOrderItemId: nullablePositivePostgresInteger,
  correctionForShipmentItemId: nullablePositivePostgresInteger,
  productVariantId: nullablePositivePostgresInteger,
  orderItemSku: nullableSku,
  replacementOrderItemSku: nullableSku,
  productVariantSku: nullableSku,
}).strict();

export type PackageAllocationSourceFacts = z.infer<typeof packageAllocationSourceFactsSchema>;

export interface PackageAllocationSourceRegistrationV1 {
  readonly contractVersion: 1;
  readonly sourceWmsShipmentItemId: number;
  readonly shipmentRequestItemId: string | null;
  readonly sourceQuantity: number;
  readonly shipmentItemPurpose: PackageAllocationSourceFacts["shipmentItemPurpose"];
  readonly orderItemId: number | null;
  readonly replacementForOrderItemId: number | null;
  readonly correctionForShipmentItemId: number | null;
  readonly productVariantId: number | null;
  readonly sku: string;
  readonly sourceFingerprint: string;
}

export type PackageAllocationSourceIdentityErrorCode =
  | "INVALID_SOURCE_FACTS"
  | "SOURCE_LINEAGE_INVALID"
  | "SOURCE_SKU_UNPROVEN";

export class PackageAllocationSourceIdentityError extends Error {
  readonly code: PackageAllocationSourceIdentityErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PackageAllocationSourceIdentityErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PackageAllocationSourceIdentityError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function nonblankSku(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function assertLineage(
  facts: PackageAllocationSourceFacts,
  valid: boolean,
): void {
  if (valid) return;
  throw new PackageAllocationSourceIdentityError(
    "SOURCE_LINEAGE_INVALID",
    "The WMS shipment item lineage does not match its declared purpose",
    {
      sourceWmsShipmentItemId: facts.sourceWmsShipmentItemId,
      shipmentItemPurpose: facts.shipmentItemPurpose,
    },
  );
}

function resolveSku(facts: PackageAllocationSourceFacts): string {
  let candidate: string | null = null;
  switch (facts.shipmentItemPurpose) {
    case "customer_fulfillment":
      assertLineage(
        facts,
        facts.orderItemId !== null
          && facts.replacementForOrderItemId === null
          && facts.correctionForShipmentItemId === null,
      );
      candidate = nonblankSku(facts.orderItemSku);
      break;
    case "replacement":
      assertLineage(
        facts,
        facts.orderItemId === null
          && facts.replacementForOrderItemId !== null
          && facts.correctionForShipmentItemId === null
          && facts.shipmentRequestItemId === null,
      );
      candidate = nonblankSku(facts.replacementOrderItemSku);
      break;
    case "concession":
      assertLineage(
        facts,
        facts.orderItemId === null
          && facts.replacementForOrderItemId === null
          && facts.correctionForShipmentItemId === null
          && facts.productVariantId !== null
          && facts.shipmentRequestItemId === null,
      );
      candidate = nonblankSku(facts.productVariantSku);
      break;
    case "omission_correction":
      assertLineage(
        facts,
        facts.orderItemId === null
          && facts.replacementForOrderItemId === null
          && facts.correctionForShipmentItemId !== null
          && facts.productVariantId !== null
          && facts.shipmentRequestItemId === null,
      );
      candidate = nonblankSku(facts.productVariantSku);
      break;
    case "unclassified":
      assertLineage(
        facts,
        facts.orderItemId === null
          && facts.replacementForOrderItemId === null
          && facts.correctionForShipmentItemId === null
          && facts.shipmentRequestItemId === null,
      );
      candidate = nonblankSku(facts.productVariantSku);
      break;
  }

  if (candidate === null) {
    throw new PackageAllocationSourceIdentityError(
      "SOURCE_SKU_UNPROVEN",
      "The WMS shipment item has no authoritative nonblank SKU",
      {
        sourceWmsShipmentItemId: facts.sourceWmsShipmentItemId,
        shipmentItemPurpose: facts.shipmentItemPurpose,
      },
    );
  }
  return candidate;
}

export function derivePackageAllocationSourceRegistration(
  rawFacts: PackageAllocationSourceFacts,
): PackageAllocationSourceRegistrationV1 {
  const parsed = packageAllocationSourceFactsSchema.safeParse(rawFacts);
  if (!parsed.success) {
    throw new PackageAllocationSourceIdentityError(
      "INVALID_SOURCE_FACTS",
      "The WMS shipment item source facts are invalid",
      { issues: parsed.error.issues },
    );
  }
  const facts = parsed.data;
  if (facts.shipmentRequestItemId !== null
      && facts.shipmentItemPurpose !== "customer_fulfillment") {
    throw new PackageAllocationSourceIdentityError(
      "SOURCE_LINEAGE_INVALID",
      "Only customer-fulfillment source lines may bind a shipment request item",
      {
        sourceWmsShipmentItemId: facts.sourceWmsShipmentItemId,
        shipmentItemPurpose: facts.shipmentItemPurpose,
      },
    );
  }
  const sku = resolveSku(facts);
  const identity = {
    contractVersion: 1 as const,
    sourceWmsShipmentItemId: facts.sourceWmsShipmentItemId,
    shipmentRequestItemId: facts.shipmentRequestItemId,
    sourceQuantity: facts.sourceQuantity,
    shipmentItemPurpose: facts.shipmentItemPurpose,
    orderItemId: facts.orderItemId,
    replacementForOrderItemId: facts.replacementForOrderItemId,
    correctionForShipmentItemId: facts.correctionForShipmentItemId,
    productVariantId: facts.productVariantId,
    sku,
  };
  return Object.freeze({
    ...identity,
    sourceFingerprint: createHash("sha256").update(canonicalJson(identity)).digest("hex"),
  });
}
