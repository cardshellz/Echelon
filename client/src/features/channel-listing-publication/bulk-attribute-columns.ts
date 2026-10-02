import { bulkEditPatchSchema } from "./bulk-edit-model";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { MAX_DRAFT_ITEMS } from "./model";
import {
  buildSchemaFieldModel,
  type FieldSchema,
  type SchemaFieldNode,
  type SchemaFieldModel,
} from "./schema-field-model";

export const BULK_ATTRIBUTE_COLUMN_LIMITS = {
  initial: 10,
  total: 250,
} as const;
export type BulkAttributeScalarType =
  | "string"
  | "number"
  | "integer"
  | "boolean";
export interface BulkAttributeColumn {
  key: string;
  path: string[];
  label: string;
  pathLabel: string;
  group: string;
  type: BulkAttributeScalarType;
  schema: FieldSchema;
  required: boolean;
  requiredForSome: boolean;
  appliesToAll: boolean;
}
export interface BulkAttributeColumns {
  columns: BulkAttributeColumn[];
  defaultColumnKeys: string[];
  requiredKeysByRow: string[][];
  applicableKeysByRow: string[][];
  hasRowDetails: boolean;
  warnings: string[];
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const AMBIGUOUS_KEYS = [
  "oneOf",
  "anyOf",
  "not",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
];
const CONTROL_KEYS = [
  "type",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "multipleOf",
  "format",
  "pattern",
];
const DETAIL_WARNING = "Some attributes need the full item details form.";
const rowModels = new WeakMap<
  FieldSchema,
  WeakMap<FieldSchema, SchemaFieldModel>
>();
const EMPTY_ATTRIBUTES: FieldSchema = Object.freeze({});
function rowModel(schema: FieldSchema, value: FieldSchema): SchemaFieldModel {
  let cache = rowModels.get(schema);
  if (!cache) {
    cache = new WeakMap();
    rowModels.set(schema, cache);
  }
  let model = cache.get(value);
  if (!model) {
    model = buildSchemaFieldModel(schema, value);
    cache.set(value, model);
  }
  return model;
}

function scalarType(node: SchemaFieldNode): BulkAttributeScalarType | null {
  if (
    typeof node.schema.type !== "string" ||
    !SCALAR_TYPES.has(node.schema.type)
  )
    return null;
  if (
    Array.isArray(node.schema.enum) &&
    (!node.schema.enum.length ||
      node.schema.enum.some(
        (value) =>
          typeof value !==
          (node.schema.type === "integer" ? "number" : node.schema.type),
      ))
  )
    return null;
  return node.schema.type as BulkAttributeScalarType;
}

function controlSignature(node: SchemaFieldNode): string {
  return canonicalDraftValue(
    Object.fromEntries(
      CONTROL_KEYS.filter((key) => node.schema[key] !== undefined).map(
        (key) => [key, node.schema[key]],
      ),
    ),
  );
}

/**
 * Columns are provider-derived scalar leaves. Each row resolves its own
 * conditional requirements; arrays and conflicting controls remain whole in
 * item details rather than being flattened into lossy spreadsheet cells.
 */
export function buildBulkAttributeColumns(
  schema: FieldSchema,
  values: readonly FieldSchema[],
): BulkAttributeColumns {
  if (values.length > MAX_DRAFT_ITEMS)
    throw new Error("Too many draft rows for bulk editing.");
  const candidates = new Map<
    string,
    {
      column: BulkAttributeColumn;
      signature: string;
      present: Set<number>;
      required: Set<number>;
    }
  >();
  const excluded = new Set<string>();
  const warnings = new Set<string>();
  const requiredKeysByRow: string[][] = [];
  const applicableKeysByRow: string[][] = [];
  const writablePaths = new Map<string, boolean>();
  let hasRowDetails = false;
  // With no rows, discover columns without pretending there are selected items.
  const rows = values.length ? values : [EMPTY_ATTRIBUTES];
  rows.forEach((value, rowIndex) => {
    const model = rowModel(schema, value);
    model.warnings.forEach((warning) => warnings.add(warning));
    const requiredKeys: string[] = [];
    const applicableKeys: string[] = [];
    function visit(
      node: SchemaFieldNode,
      ancestors: string[],
      ambiguous: boolean,
    ): void {
      const key = JSON.stringify(node.path);
      const blocked =
        ambiguous ||
        AMBIGUOUS_KEYS.some((keyword) => node.schema[keyword] !== undefined);
      if (node.type === "array" || blocked) {
        hasRowDetails = true;
        excluded.add(key);
        return;
      }
      if (node.type === "object" || node.schema.properties) {
        if (!node.children.length && node.path.length) hasRowDetails = true;
        node.children.forEach((child) =>
          visit(
            child,
            node.path.length ? [...ancestors, node.label] : ancestors,
            blocked,
          ),
        );
        return;
      }
      const type = scalarType(node);
      if (!writablePaths.has(key))
        writablePaths.set(
          key,
          bulkEditPatchSchema.safeParse({
            attributeChanges: [{ path: node.path, action: "remove" }],
          }).success,
        );
      const writable = writablePaths.get(key);
      if (!type || !writable) {
        hasRowDetails = true;
        excluded.add(key);
        return;
      }
      if (node.required) requiredKeys.push(key);
      applicableKeys.push(key);
      const signature = controlSignature(node);
      const previous = candidates.get(key);
      if (previous) {
        if (previous.signature !== signature) excluded.add(key);
        previous.present.add(rowIndex);
        if (node.required) previous.required.add(rowIndex);
      } else if (candidates.size < BULK_ATTRIBUTE_COLUMN_LIMITS.total) {
        candidates.set(key, {
          column: {
            key,
            path: [...node.path],
            label: node.label,
            pathLabel: [...ancestors, node.label].join(" › "),
            group: ancestors.join(" › "),
            type,
            schema: node.schema,
            required: false,
            requiredForSome: false,
            appliesToAll: false,
          },
          signature,
          present: new Set([rowIndex]),
          required: new Set(node.required ? [rowIndex] : []),
        });
      } else hasRowDetails = true;
    }
    visit(model.root, [], false);
    requiredKeysByRow.push(requiredKeys);
    applicableKeysByRow.push(applicableKeys);
  });
  const columns = [...candidates.values()]
    .filter((candidate) => {
      const safe = !excluded.has(candidate.column.key);
      if (!safe) hasRowDetails = true;
      return safe;
    })
    .map(({ column, required, present }) => ({
      ...column,
      required: required.size > 0,
      requiredForSome: required.size > 0 && required.size < rows.length,
      appliesToAll: present.size === rows.length,
    }));
  const defaults = [...columns]
    .sort((left, right) => Number(right.required) - Number(left.required))
    .slice(0, BULK_ATTRIBUTE_COLUMN_LIMITS.initial)
    .map((column) => column.key);
  if (hasRowDetails) warnings.add(DETAIL_WARNING);
  return {
    columns,
    defaultColumnKeys: defaults,
    requiredKeysByRow: values.length ? requiredKeysByRow : [],
    applicableKeysByRow: values.length ? applicableKeysByRow : [],
    hasRowDetails,
    warnings: [...warnings],
  };
}

export interface BulkAttributeInputResult {
  value: unknown;
  error: string | null;
}
/** Validates an explicit cell edit only. Required completeness stays in Review. */
export function parseBulkAttributeCellInput(
  column: BulkAttributeColumn,
  raw: string,
): BulkAttributeInputResult {
  if (raw === "") return { value: undefined, error: null };
  if (Array.isArray(column.schema.enum)) {
    const match = /^choice:(\d+)$/.exec(raw);
    const index = match ? Number(match[1]) : -1;
    return index >= 0 && index < column.schema.enum.length
      ? { value: column.schema.enum[index], error: null }
      : { value: undefined, error: "Choose one of the available values." };
  }
  if (column.type === "boolean")
    return raw === "true" || raw === "false"
      ? { value: raw === "true", error: null }
      : { value: undefined, error: "Choose Yes or No." };
  if (column.type === "string") {
    if (
      typeof column.schema.maxLength === "number" &&
      raw.length > column.schema.maxLength
    )
      return { value: undefined, error: "This value is too long." };
    if (
      typeof column.schema.minLength === "number" &&
      raw.length < column.schema.minLength
    )
      return { value: undefined, error: "This value is too short." };
    return { value: raw, error: null };
  }
  const number = Number(raw);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(number))
    return { value: undefined, error: "Enter a valid number." };
  if (column.type === "integer" && !Number.isSafeInteger(number))
    return {
      value: undefined,
      error: "Enter a whole number within the supported range.",
    };
  if (
    (typeof column.schema.minimum === "number" &&
      number < column.schema.minimum) ||
    (typeof column.schema.exclusiveMinimum === "number" &&
      number <= column.schema.exclusiveMinimum)
  )
    return {
      value: undefined,
      error: "This number is below the allowed range.",
    };
  if (
    (typeof column.schema.maximum === "number" &&
      number > column.schema.maximum) ||
    (typeof column.schema.exclusiveMaximum === "number" &&
      number >= column.schema.exclusiveMaximum)
  )
    return {
      value: undefined,
      error: "This number is above the allowed range.",
    };
  return { value: number, error: null };
}
