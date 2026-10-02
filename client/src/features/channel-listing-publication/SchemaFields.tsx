import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  buildSchemaFieldModel,
  fieldValueAtPath,
  resolveFieldSchema,
  SCHEMA_FIELD_LIMITS,
  schemaFieldMatches,
  updateSchemaFieldValue,
  type FieldSchema,
  type SchemaFieldNode,
} from "./schema-field-model";
export { objectValue, resolveFieldSchema } from "./schema-field-model";

interface Props {
  schema: FieldSchema;
  value: FieldSchema;
  onChange(value: FieldSchema): void;
  /** Explicit edits only; undefined means clear. Arrays are atomic. */
  onFieldChange?(
    path: readonly string[],
    value: unknown,
    editedPath?: readonly string[],
  ): boolean | void;
  /** Optional workbench numeric input; updates still use this form's atomic paths. */
  renderNumericField?(
    node: SchemaFieldNode,
    onChange: (value: number | undefined) => boolean,
    accessibility: { id: string; describedBy?: string },
  ): React.ReactNode;
  mode?: "item" | "patch";
  disabled?: boolean;
}

const pathKey = (path: readonly string[]) => JSON.stringify(path);
const isPrimary = (field: SchemaFieldNode): boolean =>
  field.required || field.present || field.children.some(isPrimary);

export function SchemaFields({
  schema,
  value,
  onChange,
  onFieldChange,
  disabled,
  mode = "item",
  renderNumericField,
}: Props) {
  const prefix = useId();
  const model = useMemo(
    () => buildSchemaFieldModel(schema, value),
    [schema, value],
  );
  const [query, setQuery] = useState("");
  const [expandedOptional, setExpandedOptional] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!focusPath) return;
    const element = elements.current.get(focusPath);
    if (element) {
      element.scrollIntoView({ block: "nearest" });
      const control = element.querySelector<HTMLElement>(
        "input, select, textarea, button",
      );
      (control ?? element).focus();
    }
    setFocusPath(null);
  }, [focusPath, query, expandedOptional]);

  function update(path: readonly string[], next: unknown) {
    if (disabled) return false;
    const updated = updateSchemaFieldValue(value, path, next);
    onChange(updated);
    let atomicPath = [...path];
    for (let index = 1; index < path.length; index++) {
      if (Array.isArray(fieldValueAtPath(value, path.slice(0, index)))) {
        atomicPath = path.slice(0, index);
        break;
      }
    }
    return (
      onFieldChange?.(
        atomicPath,
        fieldValueAtPath(updated, atomicPath),
        path,
      ) !== false
    );
  }

  function jump(path: readonly string[]) {
    setQuery("");
    setExpandedOptional((previous) => {
      const next = new Set(previous);
      for (let length = 0; length <= path.length; length++)
        next.add(pathKey(path.slice(0, length)));
      return next;
    });
    setFocusPath(pathKey(path));
  }

  function renderChildren(
    node: SchemaFieldNode,
    showAll = false,
  ): React.ReactNode {
    const children = node.children.filter(
      (child) => showAll || schemaFieldMatches(child, query),
    );
    const primary = children.filter(isPrimary);
    const optional = children.filter((child) => !isPrimary(child));
    const key = pathKey(node.path);
    const open = Boolean(query.trim()) || expandedOptional.has(key);
    return (
      <>
        {primary.map((child) => renderField(child, showAll))}
        {optional.length > 0 && (
          <details
            open={open}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              if (query.trim()) return;
              setExpandedOptional((previous) => {
                if (previous.has(key) === isOpen) return previous;
                const next = new Set(previous);
                if (isOpen) next.add(key);
                else next.delete(key);
                return next;
              });
            }}
          >
            <summary className="cursor-pointer rounded-md bg-muted/50 px-3 py-2 text-sm font-medium">
              Optional fields ({optional.length})
            </summary>
            {open && (
              <div className="mt-3 space-y-4">
                {optional.map((child) => renderField(child, showAll))}
              </div>
            )}
          </details>
        )}
      </>
    );
  }

  function renderField(
    node: SchemaFieldNode,
    showAll = false,
  ): React.ReactNode {
    const key = pathKey(node.path);
    const id = prefix + "-" + encodeURIComponent(key);
    const label = (
      <>
        {node.label}
        {node.required ? (
          <span className="ml-1 text-destructive" aria-label="required">
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-muted-foreground">
            {node.requiredWhenProvided ? "(required if used)" : "(optional)"}
          </span>
        )}
      </>
    );
    const description = node.description && (
      <p id={id + "-help"} className="text-xs text-muted-foreground">
        {node.description}
      </p>
    );
    const ref = (element: HTMLElement | null) => {
      if (element) elements.current.set(key, element);
      else elements.current.delete(key);
    };
    if (node.type === "object" || node.schema.properties) {
      const matchesTitle =
        Boolean(query.trim()) &&
        query
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .every((word) => node.label.toLowerCase().includes(word));
      return (
        <fieldset
          key={key}
          ref={ref}
          tabIndex={-1}
          className="min-w-0 space-y-4 rounded-md border p-4"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-semibold">{label}</legend>
          {description}
          {renderChildren(node, showAll || matchesTitle)}
          {!node.children.length && (
            <p className="text-sm text-muted-foreground">
              Use advanced attributes for this field.
            </p>
          )}
          {!node.required && node.present && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => update(node.path, undefined)}
            >
              Clear {node.label}
            </Button>
          )}
        </fieldset>
      );
    }
    if (node.type === "array") {
      const values = Array.isArray(node.value) ? node.value : [];
      const maximum = Math.min(
        typeof node.schema.maxItems === "number"
          ? node.schema.maxItems
          : SCHEMA_FIELD_LIMITS.arrayItems,
        SCHEMA_FIELD_LIMITS.arrayItems,
      );
      const childSchema = resolveFieldSchema(node.schema.items, schema);
      return (
        <fieldset
          key={key}
          ref={ref}
          tabIndex={-1}
          className="min-w-0 space-y-3 rounded-md border p-3"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-medium">{label}</legend>
          {description}
          {typeof node.schema.minItems === "number" &&
            node.schema.minItems > 0 && (
              <p className="text-xs text-muted-foreground">
                At least {node.schema.minItems} item(s) when provided.
              </p>
            )}
          {node.children.map((child, index) => (
            <div key={pathKey(child.path)} className="space-y-2 border-b pb-3">
              {renderField(child, true)}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update(
                    node.path,
                    values.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                Remove {node.label} {index + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              disabled ||
              values.length >= maximum ||
              Array.isArray(node.schema.items)
            }
            onClick={() =>
              update(node.path, [
                ...values,
                childSchema.type === "object" || childSchema.properties
                  ? {}
                  : "",
              ])
            }
          >
            Add {node.label}
          </Button>
          {node.present && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => update(node.path, undefined)}
            >
              Clear {node.label}
            </Button>
          )}
        </fieldset>
      );
    }
    const choices = Array.isArray(node.schema.enum)
      ? node.schema.enum.filter((choice) =>
          ["string", "number", "boolean"].includes(typeof choice),
        )
      : null;
    const common = {
      id,
      disabled,
      "aria-invalid": (mode === "item" && node.missing) || undefined,
      "aria-describedby": description ? id + "-help" : undefined,
    };
    const controlClass =
      "min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm";
    return (
      <div key={key} ref={ref} tabIndex={-1} className="min-w-0 space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        {choices ? (
          <select
            {...common}
            className={controlClass}
            value={node.value === undefined ? "" : String(node.value)}
            onChange={(event) =>
              update(
                node.path,
                event.target.value === ""
                  ? undefined
                  : choices.find(
                      (choice) => String(choice) === event.target.value,
                    ),
              )
            }
          >
            <option value="">Choose {node.label}</option>
            {choices.map((choice) => (
              <option
                key={typeof choice + ":" + String(choice)}
                value={String(choice)}
              >
                {String(choice)}
              </option>
            ))}
          </select>
        ) : node.type === "boolean" ? (
          <select
            {...common}
            className={controlClass}
            value={typeof node.value === "boolean" ? String(node.value) : ""}
            onChange={(event) =>
              update(
                node.path,
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
        ) : node.type === "number" || node.type === "integer" ? (
          renderNumericField ? (
            renderNumericField(node, (next) => update(node.path, next), {
              id,
              describedBy: common["aria-describedby"],
            })
          ) : (
            <Input
              {...common}
              type="number"
              step={node.type === "integer" ? 1 : "any"}
              value={typeof node.value === "number" ? node.value : ""}
              onChange={(event) => {
                if (event.target.value === "") update(node.path, undefined);
                else if (Number.isFinite(Number(event.target.value)))
                  update(node.path, Number(event.target.value));
              }}
            />
          )
        ) : typeof node.schema.maxLength === "number" &&
          node.schema.maxLength > 300 ? (
          <Textarea
            {...common}
            value={typeof node.value === "string" ? node.value : ""}
            maxLength={node.schema.maxLength}
            onChange={(event) =>
              update(node.path, event.target.value || undefined)
            }
          />
        ) : (
          <Input
            {...common}
            value={typeof node.value === "string" ? node.value : ""}
            maxLength={
              typeof node.schema.maxLength === "number"
                ? node.schema.maxLength
                : 30_000
            }
            onChange={(event) =>
              update(node.path, event.target.value || undefined)
            }
          />
        )}
        {description}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section
        aria-label="Required fields summary"
        className="rounded-md border bg-muted/30 p-3"
      >
        <p className="text-sm font-medium">
          {mode === "patch"
            ? "Only fields you change here are applied. Required labels describe listing requirements; Review checks each item."
            : model.missing.length
              ? model.missing.length + " required fields need attention"
              : "Required fields shown here are filled. Review checks the complete listing."}
        </p>
        {mode === "item" && model.missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {model.missing.map((item) => (
              <li key={pathKey(item.path)}>
                <button
                  type="button"
                  className="text-left text-sm text-primary underline underline-offset-2"
                  aria-label={"Go to " + item.label}
                  onClick={() => jump(item.path)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {model.warnings.map((warning) => (
          <p
            key={warning}
            className="mt-2 text-sm text-amber-800 dark:text-amber-300"
          >
            {warning}
          </p>
        ))}
      </section>
      <div className="space-y-1.5">
        <Label htmlFor={prefix + "-search"}>Find a field</Label>
        <Input
          id={prefix + "-search"}
          aria-label="Search listing fields"
          placeholder="Search required and optional fields"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {model.root.children.length
        ? renderChildren(model.root)
        : renderField(model.root)}
      {query.trim() &&
        !model.root.children.some((child) =>
          schemaFieldMatches(child, query),
        ) && (
          <p className="text-sm text-muted-foreground">
            No fields match this search.
          </p>
        )}
    </div>
  );
}
