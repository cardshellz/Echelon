import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import Decimal from "decimal.js";
import type { ListingIssue } from "@shared/types/channel-listing-publication";
import { WalmartApiError } from "./walmart-client";
import type {
  WalmartItemSchemaFeedType,
  WalmartListingIdentifier,
} from "./walmart-listing-api";

export const PROTECTED_ORDERABLE_FIELDS = new Set([
  "sku",
  "price",
  "productIdentifiers",
  "specProductType",
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
export const MAINTENANCE_PROTECTED_ORDERABLE_FIELDS = new Set([
  ...PROTECTED_ORDERABLE_FIELDS,
  "externalProductIdentifier",
  "businessPrice",
  "country_of_origin_substantial_transformation",
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
  const properties = jsonObject(schema.properties);
  return jsonObject(Object.hasOwn(properties, name) ? properties[name] : undefined);
}

export function itemSections(
  schema: JsonObject,
  feedType: WalmartItemSchemaFeedType,
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

/** Walmart's new-item MP_ITEM example includes Orderable.specProductType, but its
 * 5.0.20260803-17_50_56-api spec endpoint and published schema omit that property
 * while disallowing additional properties (verified 2026-10-05). Admit only this
 * documented selector, bound to the selected Visible branch; retain every other
 * provider constraint. Do not modify the provider document or the editor schema.
 * https://developer.walmart.com/us-marketplace/docs/create-a-new-item-full-item-setup
 */
export function listingSubmissionSchema(
  schema: JsonObject,
  feedType: WalmartItemSchemaFeedType,
  productType: string,
): JsonObject {
  if (feedType === "MP_ITEM_MATCH") return schema;
  if (feedType === "MP_MAINTENANCE") {
    // The live maintenance feed rejects specProductType (verified 2026-10-06).
    // Validate the selected Visible branch exists, then use Walmart's schema
    // unchanged. The new-item exception below must not relax update validation.
    itemSections(schema, feedType, productType);
    return schema;
  }
  const rootProperties = jsonObject(schema.properties);
  const items = jsonObject(rootProperties.MPItem);
  const item = jsonObject(items.items);
  const properties = jsonObject(item.properties);
  // Require the provider to recognize this exact product type before extending
  // the orderable section. A UI label alone cannot authorize a new schema branch.
  const { orderable } = itemSections(schema, feedType, productType);
  const orderableProperties = jsonObject(orderable.properties);
  const required = orderable.required === undefined ? [] : orderable.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw new WalmartApiError("WALMART_LISTING_SCHEMA_INVALID", "Walmart returned invalid required listing fields", false);
  }
  const selector = orderableProperties.specProductType === undefined
    ? { type: "string" }
    : jsonObject(orderableProperties.specProductType);
  return {
    ...schema,
    properties: {
      ...rootProperties,
      MPItem: {
        ...items,
        items: {
          ...item,
          properties: {
            ...properties,
            Orderable: {
              ...orderable,
              properties: {
                ...orderableProperties,
                specProductType: { allOf: [selector, { const: productType }] },
              },
              required: [...new Set([...required, "specProductType"])],
            },
          },
        },
      },
    },
  };
}

const EDITOR_SCHEMA_LIMITS = { depth: 32, nodes: 30_000 } as const;
const UNSAFE_SCHEMA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Inline bounded local definitions into the editor document without changing
 * the provider requirements used by listingSubmissionSchema. */
function localEditorSchema(
  value: unknown,
  root: JsonObject,
  budget: { nodes: number },
  references = new Set<string>(),
  depth = 0,
): unknown {
  if (
    ++budget.nodes > EDITOR_SCHEMA_LIMITS.nodes ||
    depth > EDITOR_SCHEMA_LIMITS.depth
  )
    throw new WalmartApiError(
      "WALMART_LISTING_SCHEMA_INVALID",
      "Walmart listing requirements exceed supported form limits",
      false,
    );
  if (Array.isArray(value))
    return value.map((child) =>
      localEditorSchema(child, root, budget, references, depth + 1),
    );
  if (value === null || typeof value !== "object") return value;
  const source = jsonObject(value);
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(source)) {
    if (UNSAFE_SCHEMA_KEYS.has(key))
      throw new WalmartApiError(
        "WALMART_LISTING_SCHEMA_INVALID",
        "Walmart listing requirements contain an unsupported field",
        false,
      );
    // Definitions are copied only at the reference site, never as a second
    // unrestricted copy of the entire feed schema in the editable document.
    if (["$ref", "$defs", "definitions", "$id", "$schema"].includes(key))
      continue;
    result[key] = localEditorSchema(child, root, budget, references, depth + 1);
  }
  if (source.$ref === undefined) return result;
  const ref = source.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/") || references.has(ref))
    throw new WalmartApiError(
      "WALMART_LISTING_SCHEMA_INVALID",
      "Walmart listing requirements contain an unsupported reference",
      false,
    );
  let target: unknown = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      UNSAFE_SCHEMA_KEYS.has(key) ||
      !target ||
      typeof target !== "object" ||
      !Object.prototype.hasOwnProperty.call(target, key)
    )
      throw new WalmartApiError(
        "WALMART_LISTING_SCHEMA_INVALID",
        "Walmart listing requirements contain an unresolved reference",
        false,
      );
    target = (target as JsonObject)[key];
  }
  const resolved = localEditorSchema(
    target,
    root,
    budget,
    new Set(references).add(ref),
    depth + 1,
  );
  return Object.keys(result).length ? { allOf: [resolved, result] } : resolved;
}

/** A conditional is retained whole, or omitted whole. Filtering only its
 * predicate could turn a hidden inventory/identity condition into true. */
function usesOnlyWritableFields(
  value: unknown,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof value === "boolean") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as JsonObject;
  if (
    node.properties &&
    Object.keys(jsonObject(node.properties)).some((key) => !allowed.has(key))
  )
    return false;
  if (
    node.required &&
    (!Array.isArray(node.required) ||
      node.required.some((key) => typeof key !== "string" || !allowed.has(key)))
  )
    return false;
  // These object-wide constructs cannot be projected onto a subset of fields.
  if (
    [
      "patternProperties",
      "additionalProperties",
      "propertyNames",
      "minProperties",
      "maxProperties",
      "dependencies",
      "dependentRequired",
      "dependentSchemas",
      "const",
      "enum",
    ].some((key) => key in node)
  )
    return false;
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (
      node[key] !== undefined &&
      (!Array.isArray(node[key]) ||
        !(node[key] as unknown[]).every((child) =>
          usesOnlyWritableFields(child, allowed),
        ))
    )
      return false;
  }
  return ["if", "then", "else", "not"].every(
    (key) =>
      node[key] === undefined || usesOnlyWritableFields(node[key], allowed),
  );
}

function conditionFieldNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const node = value as JsonObject;
  const names = node.properties ? Object.keys(jsonObject(node.properties)) : [];
  if (Array.isArray(node.required))
    names.push(
      ...node.required.filter(
        (name): name is string => typeof name === "string",
      ),
    );
  for (const key of ["if", "then", "else", "not"])
    names.push(...conditionFieldNames(node[key]));
  for (const key of ["allOf", "anyOf", "oneOf"])
    if (Array.isArray(node[key]))
      names.push(...(node[key] as unknown[]).flatMap(conditionFieldNames));
  return names;
}

function writableSection(
  schema: JsonObject,
  hidden: ReadonlySet<string>,
  title: string,
  root: JsonObject,
  budget: { nodes: number },
): JsonObject {
  const properties = Object.fromEntries(
    Object.entries(jsonObject(schema.properties))
      .filter(([key]) => !hidden.has(key) && !UNSAFE_SCHEMA_KEYS.has(key))
      .map(([key, value]) => [key, localEditorSchema(value, root, budget)]),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (key) => typeof key === "string" && !hidden.has(key),
      )
    : [];
  const result: JsonObject = {
    type: "object",
    title,
    // The provider assembles these wrappers from canonical content even when
    // the user has no writable attributes to supply for a section.
    "x-editor-section": true,
    properties,
    required,
    additionalProperties: false,
  };
  const allowed = new Set(Object.keys(properties));
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  const conditions =
    schema.if === undefined
      ? allOf
      : [
          ...allOf,
          {
            if: schema.if,
            ...(schema.then === undefined ? {} : { then: schema.then }),
            ...(schema.else === undefined ? {} : { else: schema.else }),
          },
        ];
  const resolvedConditions = conditions.map((condition) =>
    localEditorSchema(condition, root, budget),
  );
  const projected = resolvedConditions.filter((condition) =>
    usesOnlyWritableFields(condition, allowed),
  );
  if (projected.length) result.allOf = projected;
  if (
    [
      "anyOf",
      "oneOf",
      "dependencies",
      "dependentRequired",
      "dependentSchemas",
    ].some((key) => schema[key] !== undefined)
  )
    result["x-editor-review-required"] = true;
  if (
    resolvedConditions.some((condition) => {
      if (usesOnlyWritableFields(condition, allowed)) return false;
      const fields = conditionFieldNames(condition);
      return !fields.length || !fields.every((name) => hidden.has(name));
    })
  )
    result["x-editor-review-required"] = true;
  return result;
}

export function editorSchema(
  schema: JsonObject,
  feedType: WalmartItemSchemaFeedType,
  productType: string,
): JsonObject {
  const sections = itemSections(schema, feedType, productType);
  const hidden = new Set([
    ...PROTECTED_ORDERABLE_FIELDS,
    ...(feedType === "MP_MAINTENANCE" ? MAINTENANCE_PROTECTED_ORDERABLE_FIELDS : []),
    ...(feedType === "MP_ITEM_MATCH" ? CANONICAL_VISIBLE_FIELDS : []),
  ]);
  const budget = { nodes: 0 };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      Orderable: writableSection(
        sections.orderable,
        hidden,
        "Shipping and offer details",
        schema,
        budget,
      ),
      ...(sections.visible
        ? {
            Visible: writableSection(
              sections.visible,
              CANONICAL_VISIBLE_FIELDS,
              "Product attributes",
              schema,
              budget,
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
