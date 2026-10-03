import { bulkEditPatchSchema } from "./bulk-edit-model";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { MAX_DRAFT_ITEMS } from "./model";
import {
  buildSchemaFieldModel,
  SCHEMA_FIELD_LIMITS,
  type FieldSchema,
  type SchemaFieldNode,
  type SchemaFieldModel,
} from "./schema-field-model";

export const BULK_ATTRIBUTE_COLUMN_LIMITS = {
  total: SCHEMA_FIELD_LIMITS.fields,
} as const;
export type BulkAttributeScalarType =
  "string" | "number" | "integer" | "boolean";
export interface BulkAttributeHelp {
  path: string[];
  label: string;
  description: string;
}
export interface BulkAttributeColumn {
  key: string;
  path: string[];
  label: string;
  pathLabel: string;
  group: string;
  /** Exact provider guidance, ordered from ancestor groups to this field. */
  help: BulkAttributeHelp[];
  type: BulkAttributeScalarType | "complex";
  kind: "scalar" | "complex";
  complexReason: "array" | "object" | "conditional" | "unsupported" | null;
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
  columnsByRow: ReadonlyMap<string, BulkAttributeColumn>[];
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
 * Scalar leaves use direct cells; arrays and ambiguous values remain visible
 * as complex cells opening the inline inspector. Each row keeps its own rules.
 */
export function buildBulkAttributeColumns(
  schema: FieldSchema,
  values: readonly FieldSchema[],
): BulkAttributeColumns {
  const result = buildBulkAttributeColumnsForRows(
    (values.length ? values : [EMPTY_ATTRIBUTES]).map((value) => ({
      schema,
      value,
    })),
  );
  return values.length
    ? result
    : {
        ...result,
        requiredKeysByRow: [],
        applicableKeysByRow: [],
        columnsByRow: [],
      };
}

/** Missing or different product types must not hide another row's requirements. */
export function buildBulkAttributeColumnsForRows(
  rows: readonly { schema?: FieldSchema; value: FieldSchema }[],
): BulkAttributeColumns {
  if (rows.length > MAX_DRAFT_ITEMS)
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
  const warnings = new Set<string>();
  const requiredKeysByRow: string[][] = [];
  const applicableKeysByRow: string[][] = [];
  const columnsByRow: Map<string, BulkAttributeColumn>[] = [];
  const writablePaths = new Map<string, boolean>();
  let hasRowDetails = false;
  rows.forEach(({ schema, value }, rowIndex) => {
    const requiredKeys: string[] = [];
    const applicableKeys: string[] = [];
    const rowColumns = new Map<string, BulkAttributeColumn>();
    requiredKeysByRow.push(requiredKeys);
    applicableKeysByRow.push(applicableKeys);
    columnsByRow.push(rowColumns);
    if (!schema) return;
    const model = rowModel(schema, value);
    model.warnings.forEach((warning) => warnings.add(warning));
    function visit(
      node: SchemaFieldNode,
      ancestors: SchemaFieldNode[],
      ambiguous: boolean,
    ): void {
      const key = JSON.stringify(node.path);
      const blocked =
        ambiguous ||
        AMBIGUOUS_KEYS.some((keyword) => node.schema[keyword] !== undefined);
      if (
        !blocked &&
        node.type !== "array" &&
        (node.type === "object" || node.schema.properties) &&
        node.children.length
      ) {
        node.children.forEach((child) =>
          visit(
            child,
            node.path.length ? [...ancestors, node] : ancestors,
            blocked,
          ),
        );
        return;
      }
      const scalar =
        blocked || node.type === "array" || node.type === "object"
          ? null
          : scalarType(node);
      const type = scalar ?? "complex";
      const complexReason = scalar
        ? null
        : blocked
          ? "conditional"
          : node.type === "array"
            ? "array"
            : node.type === "object"
              ? "object"
              : "unsupported";
      if (!writablePaths.has(key))
        writablePaths.set(
          key,
          bulkEditPatchSchema.safeParse({
            attributeChanges: [{ path: node.path, action: "remove" }],
          }).success,
        );
      const writable = writablePaths.get(key);
      if (!writable) {
        hasRowDetails = true;
        return;
      }
      if (!scalar) hasRowDetails = true;
      if (node.required) requiredKeys.push(key);
      applicableKeys.push(key);
      const signature = controlSignature(node);
      const column: BulkAttributeColumn = {
        key,
        path: [...node.path],
        label: node.label,
        pathLabel: [...ancestors, node].map((field) => field.label).join(" › "),
        group: ancestors.map((field) => field.label).join(" › "),
        help: [...ancestors, node].flatMap((field) =>
          field.description?.trim()
            ? [
                {
                  path: [...field.path],
                  label: field.label,
                  description: field.description,
                },
              ]
            : [],
        ),
        type,
        kind: scalar ? "scalar" : "complex",
        complexReason,
        schema: node.schema,
        required: node.required,
        requiredForSome: false,
        appliesToAll: true,
      };
      rowColumns.set(key, column);
      const previous = candidates.get(key);
      if (previous) {
        if (previous.signature !== signature || previous.column.type !== type) {
          previous.column.type = "complex";
          previous.column.kind = "complex";
          previous.column.complexReason = "conditional";
          hasRowDetails = true;
        }
        previous.present.add(rowIndex);
        if (node.required) previous.required.add(rowIndex);
      } else {
        candidates.set(key, {
          // The union may fall back to a complex control; row controls retain
          // their exact schema and must not share this mutable union object.
          column: { ...column },
          signature,
          present: new Set([rowIndex]),
          required: new Set(node.required ? [rowIndex] : []),
        });
      }
    }
    visit(model.root, [], false);
  });
  const discovered = [...candidates.values()]
    .map(({ column, required, present }) => ({
      ...column,
      required: required.size > 0,
      requiredForSome: required.size > 0 && required.size < rows.length,
      appliesToAll: present.size === rows.length,
    }))
    .sort((left, right) => Number(right.required) - Number(left.required));
  // Bound extreme multi-category unions only after prioritizing required fields.
  // The schema model also reports any per-schema traversal limit explicitly.
  const columns = discovered.slice(0, BULK_ATTRIBUTE_COLUMN_LIMITS.total);
  if (discovered.length > columns.length) {
    hasRowDetails = true;
    warnings.add(
      `Showing ${columns.length} of ${discovered.length} attribute columns. Narrow the selected product types to see every column; remaining fields are available in item details.`,
    );
  }
  const defaults = columns.map((column) => column.key);
  if (hasRowDetails) warnings.add(DETAIL_WARNING);
  return {
    columns,
    defaultColumnKeys: defaults,
    requiredKeysByRow,
    applicableKeysByRow,
    columnsByRow,
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
  if (column.type === "complex")
    return {
      value: undefined,
      error: "Edit this value in the item details panel.",
    };
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
