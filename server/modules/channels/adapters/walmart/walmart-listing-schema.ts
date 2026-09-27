import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import Decimal from "decimal.js";
import type { ListingIssue } from "@shared/types/channel-listing-publication";
import { WalmartApiError } from "./walmart-client";
import type {
  WalmartListingFeedType,
  WalmartListingIdentifier,
} from "./walmart-listing-api";

export const PROTECTED_ORDERABLE_FIELDS = new Set([
  "sku",
  "price",
  "productIdentifiers",
  "inventory",
  "automate_pricing",
  "SkuUpdate",
  "ProductIdUpdate",
  "IsPreorder",
  "releaseDate",
  "startDate",
  "endDate",
  "msrp",
]);
export const CANONICAL_VISIBLE_FIELDS = new Set([
  "productName",
  "brand",
  "shortDescription",
  "mainImageUrl",
  "productSecondaryImageURL",
]);
type JsonObject = Record<string, unknown>;
export function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartApiError(
      "WALMART_LISTING_SCHEMA_INVALID",
      "Walmart listing requirements have an unsupported structure",
      false,
    );
  }
  return value as JsonObject;
}

function fieldSchema(schema: JsonObject, name: string): JsonObject {
  return jsonObject(jsonObject(schema.properties)[name]);
}

export function itemSections(
  schema: JsonObject,
  feedType: WalmartListingFeedType,
  productType: string,
): { orderable: JsonObject; visible: JsonObject | null } {
  const item = jsonObject(fieldSchema(schema, "MPItem").items);
  if (feedType === "MP_ITEM_MATCH")
    return { orderable: fieldSchema(item, "Item"), visible: null };
  return {
    orderable: fieldSchema(item, "Orderable"),
    visible: fieldSchema(fieldSchema(item, "Visible"), productType),
  };
}

function writableSection(
  schema: JsonObject,
  hidden: ReadonlySet<string>,
  title: string,
): JsonObject {
  const properties = Object.fromEntries(
    Object.entries(jsonObject(schema.properties)).filter(
      ([key]) => !hidden.has(key),
    ),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (key) => typeof key === "string" && !hidden.has(key),
      )
    : [];
  // Conditional requirements remain enforced by the original full feed schema.
  // The editor gets only writable fields, never an inventory/identity/price form.
  return {
    type: "object",
    title,
    properties,
    required,
    additionalProperties: false,
  };
}

export function editorSchema(
  schema: JsonObject,
  feedType: WalmartListingFeedType,
  productType: string,
): JsonObject {
  const sections = itemSections(schema, feedType, productType);
  const hidden = new Set([
    ...PROTECTED_ORDERABLE_FIELDS,
    ...(feedType === "MP_ITEM_MATCH" ? CANONICAL_VISIBLE_FIELDS : []),
  ]);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      Orderable: writableSection(
        sections.orderable,
        hidden,
        "Shipping and offer details",
      ),
      ...(sections.visible
        ? {
            Visible: writableSection(
              sections.visible,
              CANONICAL_VISIBLE_FIELDS,
              "Product attributes",
            ),
          }
        : {}),
    },
    required: sections.visible ? ["Orderable", "Visible"] : ["Orderable"],
  };
}

export function compileListingSchema(schema: JsonObject): ValidateFunction {
  try {
    // Walmart uses draft-07 plus documentation annotations. Do not coerce data,
    // remove unknown properties, load remote refs, or apply provider defaults.
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: true,
      multipleOfPrecision: 8,
    });
    addFormats(ajv);
    return ajv.compile(schema);
  } catch {
    throw new WalmartApiError(
      "WALMART_LISTING_SCHEMA_INVALID",
      "Walmart listing requirements could not be validated",
      false,
    );
  }
}

export function schemaIssues(
  errors: ErrorObject[] | null | undefined,
): ListingIssue[] {
  return (errors ?? []).slice(0, 50).map((error) => {
    const missing =
      typeof error.params.missingProperty === "string"
        ? error.params.missingProperty
        : null;
    const field = `${error.instancePath}${missing ? `/${missing}` : ""}`;
    return {
      code: "WALMART_LISTING_ATTRIBUTE_INVALID",
      field,
      message: `${missing ?? (error.instancePath.split("/").pop() || "Listing")}: ${error.message ?? "invalid value"}`,
    };
  });
}

export function validProductIdentifier(
  identifier: WalmartListingIdentifier,
): boolean {
  const value = identifier.value;
  if (identifier.type === "ISBN" && /^\d{9}[\dX]$/.test(value)) {
    const sum = [...value].reduce(
      (total, digit, index) =>
        total + (digit === "X" ? 10 : Number(digit)) * (10 - index),
      0,
    );
    return sum % 11 === 0;
  }
  const length = { GTIN: 14, UPC: 12, EAN: 13, ISBN: 13 }[identifier.type];
  if (!new RegExp(`^\\d{${length}}$`).test(value) || /^0+$/.test(value))
    return false;
  let sum = 0;
  for (
    let index = value.length - 2, position = 0;
    index >= 0;
    index--, position++
  ) {
    sum += Number(value[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
}

export function sameProductIdentifier(
  left: WalmartListingIdentifier,
  right: WalmartListingIdentifier,
): boolean {
  if (!validProductIdentifier(left) || !validProductIdentifier(right))
    return false;
  if (left.type === "ISBN" || right.type === "ISBN")
    return left.type === right.type && left.value === right.value;
  return left.value.padStart(14, "0") === right.value.padStart(14, "0");
}

/** Monetary arithmetic stays decimal; a JSON number exists only at the API boundary. */
export function priceForWalmart(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents <= 0)
    throw new WalmartApiError(
      "WALMART_PRICE_INVALID",
      "A positive price in whole cents is required",
      false,
    );
  const amount = new Decimal(cents).div(100);
  const jsonNumber = amount.toNumber();
  if (!new Decimal(String(jsonNumber)).mul(100).eq(cents)) {
    throw new WalmartApiError(
      "WALMART_PRICE_INVALID",
      "The price cannot be represented exactly by Walmart's JSON contract",
      false,
    );
  }
  return jsonNumber;
}

export function priceFromWalmart(amount: string | number): number {
  try {
    const cents = new Decimal(String(amount)).mul(100);
    if (
      !cents.isFinite() ||
      !cents.isInteger() ||
      cents.isNegative() ||
      cents.gt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Invalid amount");
    return cents.toNumber();
  } catch {
    throw new WalmartApiError(
      "WALMART_PRICE_RESPONSE_INVALID",
      "Walmart returned an invalid USD price",
      false,
    );
  }
}
