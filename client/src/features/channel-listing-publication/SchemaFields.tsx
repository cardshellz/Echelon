import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { labelForKey } from "./model";

type Schema = Record<string, unknown>;
const MAX_DEPTH = 8;
const MAX_FIELDS = 250;
const MAX_ARRAY_ITEMS = 100;
export const objectValue = (value: unknown): Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : {};

/** Only local schema references are resolved; schemas never initiate network requests. */
export function resolveFieldSchema(
  value: unknown,
  root: Schema,
  depth = 0,
): Schema {
  if (depth > MAX_DEPTH) return {};
  let schema = objectValue(value);
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    let target: unknown = root;
    for (const segment of schema.$ref.slice(2).split("/")) {
      target =
        objectValue(target)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    schema = { ...resolveFieldSchema(target, root, depth + 1), ...schema };
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part) =>
      resolveFieldSchema(part, root, depth + 1),
    );
    schema = {
      ...Object.assign({}, ...parts),
      ...schema,
      properties: Object.assign(
        {},
        ...parts.map((part) => objectValue(part.properties)),
        objectValue(schema.properties),
      ),
      required: [
        ...new Set([
          ...parts.flatMap((part) =>
            Array.isArray(part.required) ? part.required : [],
          ),
          ...(Array.isArray(schema.required) ? schema.required : []),
        ]),
      ],
    };
  }
  return schema;
}

interface Props {
  schema: Schema;
  value: Schema;
  onChange(value: Schema): void;
  disabled?: boolean;
}

export function SchemaFields({ schema, value, onChange, disabled }: Props) {
  const prefix = useId();
  const [expandedOptional, setExpandedOptional] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const budget = { fields: 0 };

  function field(
    raw: unknown,
    current: unknown,
    update: (next: unknown) => void,
    path: string,
    title: string,
    required: boolean,
    depth: number,
  ): React.ReactNode {
    if (budget.fields >= MAX_FIELDS) return null;
    budget.fields++;
    if (depth > MAX_DEPTH)
      return (
        <p key={path} className="text-sm text-muted-foreground">
          Additional nested attributes are available in the advanced editor.
        </p>
      );
    const node = resolveFieldSchema(raw, schema);
    const label =
      typeof node.title === "string" ? node.title : labelForKey(title);
    const description =
      typeof node.description === "string" ? node.description : null;
    const id = `${prefix}-${path}`;
    const type =
      typeof node.type === "string"
        ? node.type
        : node.properties
          ? "object"
          : Array.isArray(node.enum)
            ? "string"
            : "string";
    const entries = Object.entries(objectValue(node.properties));
    if (type === "object" || entries.length) {
      const values = objectValue(current);
      const requiredKeys = new Set(
        Array.isArray(node.required)
          ? node.required.filter(
              (key): key is string => typeof key === "string",
            )
          : [],
      );
      const renderEntry = ([key, child]: [string, unknown]) =>
        field(
          child,
          values[key],
          (next) => {
            const updated = { ...values };
            if (next === undefined) delete updated[key];
            else updated[key] = next;
            update(Object.keys(updated).length ? updated : undefined);
          },
          `${path}-${key}`,
          key,
          requiredKeys.has(key),
          depth + 1,
        );
      const primary = entries.filter(
        ([key]) => requiredKeys.has(key) || values[key] !== undefined,
      );
      const optional = entries.filter(
        ([key]) => !requiredKeys.has(key) && values[key] === undefined,
      );
      return (
        <fieldset
          key={path}
          className="space-y-3 rounded-md border p-3"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-medium">
            {label}
            {required ? " *" : ""}
          </legend>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
          {primary.map(renderEntry)}
          {optional.length > 0 && (
            <details
              open={expandedOptional.has(path)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedOptional((previous) => {
                  if (previous.has(path) === open) return previous;
                  const next = new Set(previous);
                  if (open) next.add(path);
                  else next.delete(path);
                  return next;
                });
              }}
            >
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Optional attributes ({optional.length})
              </summary>
              {expandedOptional.has(path) && (
                <div className="mt-3 space-y-3">
                  {optional.map(renderEntry)}
                </div>
              )}
            </details>
          )}
          {!entries.length && (
            <p className="text-sm text-muted-foreground">
              This field has no editable schema. Use advanced attributes if
              needed.
            </p>
          )}
        </fieldset>
      );
    }
    if (type === "array") {
      const values = Array.isArray(current) ? current : [];
      const maximum = Math.min(
        typeof node.maxItems === "number" ? node.maxItems : MAX_ARRAY_ITEMS,
        MAX_ARRAY_ITEMS,
      );
      const childSchema = resolveFieldSchema(node.items, schema);
      return (
        <fieldset
          key={path}
          className="space-y-3 rounded-md border p-3"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-medium">
            {label}
            {required ? " *" : ""}
          </legend>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
          {values.map((entry, index) => (
            <div key={index} className="space-y-2 border-b pb-3">
              {field(
                childSchema,
                entry,
                (next) =>
                  update(
                    values.map((item, i) =>
                      i === index ? (next ?? "") : item,
                    ),
                  ),
                `${path}-${index}`,
                `${label} ${index + 1}`,
                true,
                depth + 1,
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update(values.filter((_, i) => i !== index))}
              >
                Remove {label} {index + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || values.length >= maximum}
            onClick={() =>
              update([
                ...values,
                childSchema.type === "object" || childSchema.properties
                  ? {}
                  : "",
              ])
            }
          >
            Add {label}
          </Button>
        </fieldset>
      );
    }
    const choices = Array.isArray(node.enum)
      ? node.enum.filter((choice) =>
          ["string", "number", "boolean"].includes(typeof choice),
        )
      : null;
    const controlClass =
      "min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm";
    return (
      <div key={path} className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {required ? " *" : ""}
        </Label>
        {choices ? (
          <select
            id={id}
            className={controlClass}
            value={current === undefined ? "" : String(current)}
            disabled={disabled}
            onChange={(event) =>
              update(
                event.target.value === ""
                  ? undefined
                  : choices.find(
                      (choice) => String(choice) === event.target.value,
                    ),
              )
            }
          >
            <option value="">Choose {label}</option>
            {choices.map((choice) => (
              <option key={String(choice)} value={String(choice)}>
                {String(choice)}
              </option>
            ))}
          </select>
        ) : type === "boolean" ? (
          <select
            id={id}
            className={controlClass}
            value={typeof current === "boolean" ? String(current) : ""}
            disabled={disabled}
            onChange={(event) =>
              update(
                event.target.value === ""
                  ? undefined
                  : event.target.value === "true",
              )
            }
          >
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : type === "number" || type === "integer" ? (
          <Input
            id={id}
            type="number"
            step={type === "integer" ? 1 : "any"}
            value={typeof current === "number" ? current : ""}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              if (!next) update(undefined);
              else if (Number.isFinite(Number(next))) update(Number(next));
            }}
          />
        ) : typeof node.maxLength === "number" && node.maxLength > 300 ? (
          <Textarea
            id={id}
            value={typeof current === "string" ? current : ""}
            maxLength={node.maxLength}
            disabled={disabled}
            onChange={(event) => update(event.target.value || undefined)}
          />
        ) : (
          <Input
            id={id}
            value={typeof current === "string" ? current : ""}
            disabled={disabled}
            maxLength={
              typeof node.maxLength === "number" ? node.maxLength : 30_000
            }
            onChange={(event) => update(event.target.value || undefined)}
          />
        )}
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
    );
  }
  const content = field(
    schema,
    value,
    (next) => onChange(objectValue(next)),
    "attributes",
    "Walmart attributes",
    true,
    0,
  );
  return (
    <div className="space-y-3">
      {content}
      {budget.fields >= MAX_FIELDS && (
        <p className="text-sm text-muted-foreground">
          This schema has more fields than the form can display. Use advanced
          attributes for additional fields.
        </p>
      )}
    </div>
  );
}
