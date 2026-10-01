import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { labelForKey } from "./model";

export type FieldSchema = Record<string, unknown>;
export const SCHEMA_FIELD_LIMITS = {
  depth: 10,
  fields: 1_000,
  arrayItems: 100,
  schemaNodes: 30_000,
} as const;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const REVIEW_WARNING =
  "Some requirements need the final listing review. Use advanced attributes for fields this form cannot display.";
const owns = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
export const objectValue = (value: unknown): FieldSchema => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as FieldSchema)
    : {};
};
const entries = (value: unknown) =>
  Object.entries(objectValue(value)).filter(([key]) => !RESERVED.has(key));
const requiredNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (name): name is string =>
          typeof name === "string" && !RESERVED.has(name),
      )
    : [];
const hasValue = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim().length > 0) &&
  (typeof value !== "number" || Number.isFinite(value));

export interface SchemaFieldNode {
  path: string[];
  label: string;
  description: string | null;
  type: string;
  schema: FieldSchema;
  value: unknown;
  present: boolean;
  required: boolean;
  requiredWhenProvided: boolean;
  missing: boolean;
  children: SchemaFieldNode[];
}
export interface SchemaFieldModel {
  root: SchemaFieldNode;
  missing: Array<{ path: string[]; label: string }>;
  requiredCount: number;
  warnings: string[];
}
interface ResolutionContext {
  root: FieldSchema;
  warnings: Set<string>;
  budget: number;
}

function localReference(ref: string, root: FieldSchema): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let target: unknown = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (RESERVED.has(key) || !owns(objectValue(target), key)) return undefined;
    target = objectValue(target)[key];
  }
  return target;
}

function mergeSchemas(left: FieldSchema, right: FieldSchema): FieldSchema {
  const properties = Object.fromEntries(entries(left.properties));
  for (const [key, schema] of entries(right.properties)) {
    properties[key] = owns(properties, key)
      ? { allOf: [properties[key], schema] }
      : schema;
  }
  const merged = { ...left, ...right };
  if (Object.keys(properties).length) merged.properties = properties;
  if (left.required || right.required)
    merged.required = [
      ...new Set([
        ...requiredNames(left.required),
        ...requiredNames(right.required),
      ]),
    ];
  return merged;
}

// Evaluate conditions with the same validator family as the server, without
// attempting to duplicate JSON Schema validity rules in the form. Unknown
// constructs stay a final-review concern, never an assumed satisfied condition.
const conditionValidators = new WeakMap<
  FieldSchema,
  WeakMap<object, ValidateFunction | null>
>();
const CONDITION_KEYS = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "const",
  "enum",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "contains",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "additionalProperties",
]);
function supportedCondition(
  value: unknown,
  root: FieldSchema,
  visited = new Set<unknown>(),
  depth = 0,
  budget = { count: 0 },
): boolean {
  if (++budget.count > 3_000) return false;
  if (typeof value === "boolean") return true;
  if (
    depth > 24 ||
    visited.has(value) ||
    Object.keys(objectValue(value)).length === 0
  )
    return false;
  const schema = objectValue(value);
  const next = new Set(visited).add(value);
  for (const [key, child] of Object.entries(schema)) {
    if (!CONDITION_KEYS.has(key)) return false;
    if (
      key === "$ref" &&
      (typeof child !== "string" ||
        !supportedCondition(
          localReference(child, root),
          root,
          next,
          depth + 1,
          budget,
        ))
    )
      return false;
    if (
      key === "properties" &&
      (Object.keys(objectValue(child)).some((name) => RESERVED.has(name)) ||
        entries(child).some(
          ([, node]) =>
            !supportedCondition(node, root, next, depth + 1, budget),
        ))
    )
      return false;
    if (
      ["allOf", "anyOf", "oneOf"].includes(key) &&
      (!Array.isArray(child) ||
        child.length > 100 ||
        child.some(
          (node) => !supportedCondition(node, root, next, depth + 1, budget),
        ))
    )
      return false;
    if (
      ["not", "contains", "items", "additionalProperties"].includes(key) &&
      !supportedCondition(child, root, next, depth + 1, budget)
    )
      return false;
  }
  return true;
}
function inlineCondition(
  value: unknown,
  root: FieldSchema,
  budget: { count: number },
  depth = 0,
): unknown {
  if (++budget.count > 3_000 || depth > 24)
    throw new Error("Condition exceeds form limits");
  if (Array.isArray(value))
    return value.map((child) =>
      inlineCondition(child, root, budget, depth + 1),
    );
  if (value === null || typeof value !== "object") return value;
  const source = objectValue(value);
  const result = Object.fromEntries(
    entries(source)
      .filter(([key]) => key !== "$ref")
      .map(([key, child]) => [
        key,
        inlineCondition(child, root, budget, depth + 1),
      ]),
  );
  if (typeof source.$ref === "string") {
    return {
      allOf: [
        inlineCondition(
          localReference(source.$ref, root),
          root,
          budget,
          depth + 1,
        ),
        result,
      ],
    };
  }
  return result;
}
function conditionMatches(
  predicate: unknown,
  value: unknown,
  context: ResolutionContext,
): boolean | null {
  if (typeof predicate === "boolean") return predicate;
  if (!supportedCondition(predicate, context.root)) return null;
  const object = objectValue(predicate);
  let cache = conditionValidators.get(context.root);
  if (!cache) {
    cache = new WeakMap();
    conditionValidators.set(context.root, cache);
  }
  if (!cache.has(object)) {
    try {
      const ajv = new Ajv({
        strict: false,
        allErrors: false,
        validateFormats: true,
      });
      addFormats(ajv);
      cache.set(
        object,
        ajv.compile(
          inlineCondition(object, context.root, { count: 0 }) as object,
        ),
      );
    } catch {
      cache.set(object, null);
    }
  }
  const validate = cache.get(object);
  return validate ? Boolean(validate(value)) : null;
}

function resolve(
  raw: unknown,
  current: unknown,
  context: ResolutionContext,
  depth = 0,
  refs = new Set<string>(),
): FieldSchema {
  if (++context.budget > SCHEMA_FIELD_LIMITS.schemaNodes || depth > 24) {
    context.warnings.add(REVIEW_WARNING);
    return {};
  }
  const source = objectValue(raw);
  let schema = { ...source };
  // Applicators are consumed exactly once. Keeping a sibling's `if` while
  // merging allOf would incorrectly evaluate the last branch twice.
  delete schema.allOf;
  delete schema.if;
  delete schema.then;
  delete schema.else;
  if (Object.keys(schema).some((key) => RESERVED.has(key)))
    context.warnings.add(REVIEW_WARNING);
  if (typeof schema.$ref === "string") {
    const target = localReference(schema.$ref, context.root);
    if (target === undefined || refs.has(schema.$ref))
      context.warnings.add(REVIEW_WARNING);
    else
      schema = mergeSchemas(
        resolve(
          target,
          current,
          context,
          depth + 1,
          new Set(refs).add(schema.$ref),
        ),
        schema,
      );
  }
  if (Array.isArray(source.allOf)) {
    if (source.allOf.length > 100) context.warnings.add(REVIEW_WARNING);
    for (const part of source.allOf.slice(0, 100))
      schema = mergeSchemas(
        schema,
        resolve(part, current, context, depth + 1, refs),
      );
  }
  if (source.if !== undefined) {
    // The editor renders absent object sections as empty objects. Passing
    // undefined would make JSON Schema's object-only predicates vacuously true.
    const matched = conditionMatches(
      source.if,
      current === undefined ? {} : current,
      context,
    );
    if (matched === null) context.warnings.add(REVIEW_WARNING);
    else {
      const branch = matched ? source.then : source.else;
      if (branch !== undefined)
        schema = mergeSchemas(
          schema,
          resolve(branch, current, context, depth + 1, refs),
        );
    }
  }
  if (
    schema.oneOf ||
    schema.anyOf ||
    schema.dependencies ||
    schema.dependentRequired ||
    schema["x-editor-review-required"]
  )
    context.warnings.add(REVIEW_WARNING);
  return schema;
}

/** Compatibility export for callers that only need a resolved local field. */
export function resolveFieldSchema(
  raw: unknown,
  root: FieldSchema,
  depth = 0,
): FieldSchema {
  return resolve(
    raw,
    undefined,
    { root, warnings: new Set(), budget: 0 },
    depth,
  );
}

export function buildSchemaFieldModel(
  schema: FieldSchema,
  value: FieldSchema,
): SchemaFieldModel {
  const context: ResolutionContext = {
    root: schema,
    warnings: new Set(),
    budget: 0,
  };
  const missing: SchemaFieldModel["missing"] = [];
  let fields = 0,
    requiredCount = 0;
  function visit(
    raw: unknown,
    current: unknown,
    path: string[],
    key: string,
    required: boolean,
    localRequired: boolean,
    active: boolean,
    parents: string[],
  ): SchemaFieldNode {
    const fieldSchema = resolve(raw, current, context);
    const fallbackLabel = labelForKey(key);
    const label =
      typeof fieldSchema.title === "string"
        ? fieldSchema.title
        : fallbackLabel.charAt(0).toUpperCase() + fallbackLabel.slice(1);
    const type =
      typeof fieldSchema.type === "string"
        ? fieldSchema.type
        : fieldSchema.properties
          ? "object"
          : "string";
    const present =
      current !== undefined || fieldSchema["x-editor-section"] === true;
    const node: SchemaFieldNode = {
      path,
      label,
      type,
      schema: fieldSchema,
      value: current,
      present,
      required,
      requiredWhenProvided: localRequired && !active,
      missing: false,
      children: [],
      description:
        typeof fieldSchema.description === "string"
          ? fieldSchema.description
          : null,
    };
    if (
      ++fields > SCHEMA_FIELD_LIMITS.fields ||
      path.length > SCHEMA_FIELD_LIMITS.depth
    ) {
      context.warnings.add(REVIEW_WARNING);
      return node;
    }
    const missingBefore = missing.length;
    if (type === "object" || fieldSchema.properties) {
      const requiredKeys = new Set(requiredNames(fieldSchema.required));
      const properties = entries(fieldSchema.properties);
      if (
        Object.keys(objectValue(fieldSchema.properties)).length !==
        properties.length
      )
        context.warnings.add(REVIEW_WARNING);
      const objectActive = active && (path.length === 0 || required || present);
      for (const [childKey, child] of properties) {
        if (fields >= SCHEMA_FIELD_LIMITS.fields) {
          context.warnings.add(REVIEW_WARNING);
          break;
        }
        node.children.push(
          visit(
            child,
            owns(objectValue(current), childKey)
              ? objectValue(current)[childKey]
              : undefined,
            [...path, childKey],
            childKey,
            objectActive && requiredKeys.has(childKey),
            requiredKeys.has(childKey),
            objectActive,
            path.length ? [...parents, label] : parents,
          ),
        );
      }
      if (
        [...requiredKeys].some(
          (name) => !properties.some(([key]) => key === name),
        )
      )
        context.warnings.add(REVIEW_WARNING);
      node.missing =
        required &&
        !present &&
        missing.length === missingBefore &&
        path.length > 0;
    } else if (type === "array") {
      const values = Array.isArray(current) ? current : [];
      const minimum =
        typeof fieldSchema.minItems === "number"
          ? Math.max(0, fieldSchema.minItems)
          : 0;
      node.missing =
        active &&
        ((required && !present) || (present && values.length < minimum));
      if (
        values.length > SCHEMA_FIELD_LIMITS.arrayItems ||
        Array.isArray(fieldSchema.items)
      )
        context.warnings.add(REVIEW_WARNING);
      if (!Array.isArray(fieldSchema.items))
        values
          .slice(0, SCHEMA_FIELD_LIMITS.arrayItems)
          .forEach((item, index) => {
            if (fields < SCHEMA_FIELD_LIMITS.fields)
              node.children.push(
                visit(
                  fieldSchema.items,
                  item,
                  [...path, String(index)],
                  `${label} ${index + 1}`,
                  active,
                  true,
                  active,
                  [...parents, label],
                ),
              );
          });
    } else node.missing = required && !hasValue(current);
    if (required && type !== "object") requiredCount++;
    if (node.missing)
      missing.push({ path: [...path], label: [...parents, label].join(" › ") });
    return node;
  }
  const root = visit(
    schema,
    value,
    [],
    "Listing attributes",
    true,
    true,
    true,
    [],
  );
  return { root, missing, requiredCount, warnings: [...context.warnings] };
}

export function fieldValueAtPath(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const key of path) {
    if (RESERVED.has(key)) return undefined;
    current = Array.isArray(current)
      ? current[Number(key)]
      : owns(objectValue(current), key)
        ? objectValue(current)[key]
        : undefined;
  }
  return current;
}
/** Immutable updates; explicit undefined removes only the selected safe path. */
export function updateSchemaFieldValue(
  value: FieldSchema,
  path: readonly string[],
  next: unknown,
): FieldSchema {
  if (
    !path.length ||
    path.length > SCHEMA_FIELD_LIMITS.depth ||
    path.some((key) => RESERVED.has(key))
  )
    throw new Error("Invalid attribute path");
  function update(current: unknown, offset: number): unknown {
    const key = path[offset];
    const terminal = offset === path.length - 1;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key) || Number(key) >= current.length)
        throw new Error("Invalid attribute array index");
      // JSON arrays cannot represent an unset member; a cleared scalar stays an
      // explicitly empty entry until the user removes that row.
      return current.map((item, index) =>
        index === Number(key)
          ? terminal
            ? (next ?? "")
            : update(item, offset + 1)
          : item,
      );
    }
    const result = Object.fromEntries(entries(current));
    if (terminal && next === undefined) delete result[key];
    else result[key] = terminal ? next : update(result[key], offset + 1);
    return result;
  }
  return objectValue(update(value, 0));
}

export function schemaFieldMatches(
  field: SchemaFieldNode,
  query: string,
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [field.label, field.path.join(" "), field.description ?? ""]
    .join(" ")
    .toLowerCase();
  return (
    words.every((word) => text.includes(word)) ||
    field.children.some((child) => schemaFieldMatches(child, query))
  );
}
