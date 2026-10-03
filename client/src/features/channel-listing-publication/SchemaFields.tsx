import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, Plus, Trash2, X } from "lucide-react";
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

interface SharedGuidance {
  id: string;
  descriptions: ReadonlySet<string>;
}

function FieldGuidance({
  id,
  label,
  descriptions,
}: {
  id: string;
  label: string;
  descriptions: readonly string[];
}) {
  if (!descriptions.length) return null;
  return (
    <details
      aria-label={`${label} guidance`}
      className="group rounded-md open:border open:border-primary/20 open:bg-primary/5"
    >
      <summary className="w-fit cursor-pointer py-1 text-xs font-medium text-primary group-open:px-3 group-open:py-2">
        <span className="ml-1 inline-flex items-center gap-2 align-middle">
          <Info aria-hidden="true" className="h-4 w-4" />
          Field guidance
        </span>
      </summary>
      <div id={id} className="space-y-3 border-t border-primary/10 px-3 py-3">
        {descriptions.map((description, index) => (
          <p
            key={index}
            className="whitespace-pre-wrap break-words text-sm leading-relaxed"
          >
            {description}
          </p>
        ))}
      </div>
    </details>
  );
}

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
            <summary className="cursor-pointer rounded-md border bg-muted/30 px-3 py-2 text-sm font-semibold">
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
    presentation?: {
      label?: string;
      sharedGuidance?: SharedGuidance;
      hasRowAction?: boolean;
    },
  ): React.ReactNode {
    const key = pathKey(node.path);
    const id = prefix + "-" + encodeURIComponent(key);
    const fieldLabel = presentation?.label ?? node.label;
    const label = (
      <span
        className={
          presentation?.hasRowAction
            ? "inline-flex min-h-9 max-w-full items-center pr-10"
            : undefined
        }
      >
        {fieldLabel}
        {node.required ? (
          <span className="ml-1 text-destructive" aria-label="required">
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-muted-foreground">
            {node.requiredWhenProvided ? "(required if used)" : "(optional)"}
          </span>
        )}
      </span>
    );
    const usesSharedGuidance = Boolean(
      node.description &&
        presentation?.sharedGuidance?.descriptions.has(node.description),
    );
    const describedBy = usesSharedGuidance
      ? presentation?.sharedGuidance?.id
      : node.description
        ? id + "-help"
        : undefined;
    const description = node.description && !usesSharedGuidance && (
      <FieldGuidance
        id={id + "-help"}
        label={fieldLabel}
        descriptions={[node.description]}
      />
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
          className="min-w-0 space-y-4 rounded-lg border bg-background p-3 sm:p-4"
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
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => update(node.path, undefined)}
            >
              <Trash2 aria-hidden="true" />
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
      // Item descriptions are provider guidance for the list, not new guidance
      // for every repeated row. Keep distinct conditional descriptions intact.
      const guidance = [
        ...new Set(
          [
            node.description,
            typeof childSchema.description === "string"
              ? childSchema.description
              : null,
          ].filter((text): text is string => Boolean(text)),
        ),
      ];
      const sharedGuidance: SharedGuidance = {
        id: id + "-help",
        descriptions: new Set(guidance),
      };
      return (
        <fieldset
          key={key}
          ref={ref}
          tabIndex={-1}
          className="min-w-0 space-y-3 rounded-lg border bg-background p-3 sm:p-4"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-semibold">{label}</legend>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {values.length} {values.length === 1 ? "item" : "items"}
            </span>
            <span>
              {typeof node.schema.minItems === "number" &&
              node.schema.minItems > 0
                ? `At least ${node.schema.minItems} when provided · `
                : ""}
              Up to {maximum}
            </span>
          </div>
          <FieldGuidance
            id={sharedGuidance.id}
            label={fieldLabel}
            descriptions={guidance}
          />
          {node.children.map((child, index) => (
            <div
              key={pathKey(child.path)}
              className="relative rounded-md border bg-muted/10 p-3"
            >
              {renderField(child, true, {
                label: `${node.label} ${index + 1}`,
                sharedGuidance,
                hasRowAction: true,
              })}
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="absolute right-2 top-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Remove ${node.label} ${index + 1}`}
                onClick={() => {
                  if (
                    update(
                      node.path,
                      values.filter((_, itemIndex) => itemIndex !== index),
                    )
                  ) {
                    const remainingIndex = Math.min(index, values.length - 2);
                    setFocusPath(
                      pathKey(
                        remainingIndex < 0
                          ? node.path
                          : [...node.path, String(remainingIndex)],
                      ),
                    );
                  }
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <Button
              type="button"
              size="sm"
              disabled={
                disabled ||
                values.length >= maximum ||
                Array.isArray(node.schema.items)
              }
              onClick={() => {
                if (
                  update(node.path, [
                    ...values,
                    childSchema.type === "object" || childSchema.properties
                      ? {}
                      : "",
                  ])
                ) {
                  setFocusPath(pathKey([...node.path, String(values.length)]));
                }
              }}
            >
              <Plus aria-hidden="true" />
              Add {node.label}
            </Button>
            {node.present && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => update(node.path, undefined)}
              >
                <Trash2 aria-hidden="true" />
                Clear all {node.label}
              </Button>
            )}
          </div>
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
      "aria-describedby": describedBy,
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
            className="min-h-24 resize-y leading-relaxed"
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
        className={`rounded-lg border p-3 ${mode === "item" && model.missing.length ? "border-destructive/25 bg-destructive/5" : "border-primary/20 bg-primary/5"}`}
      >
        <p className="flex items-start gap-2 text-sm font-medium">
          {mode === "patch" ? (
            <Info
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            />
          ) : model.missing.length ? (
            <AlertCircle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
            />
          ) : (
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            />
          )}
          <span>
            {mode === "patch"
              ? "Only fields you change here are applied. Required labels describe listing requirements; Review checks each item."
              : model.missing.length
                ? model.missing.length + " required fields need attention"
                : "Required fields shown here are filled. Review checks the complete listing."}
          </span>
        </p>
        {mode === "item" && model.missing.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {model.missing.map((item) => (
              <li key={pathKey(item.path)}>
                <button
                  type="button"
                  className="rounded-md border border-destructive/20 bg-background px-2 py-1 text-left text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
