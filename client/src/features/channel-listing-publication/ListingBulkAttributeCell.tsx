import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  parseBulkAttributeCellInput,
  type BulkAttributeColumn,
} from "./bulk-attribute-columns";

interface Props {
  column: BulkAttributeColumn;
  value: unknown;
  sku: string;
  onChange(value: unknown): boolean | void;
  onValidityChange?(error: string | null): void;
  disabled?: boolean;
  required?: boolean;
  inputId?: string;
  describedBy?: string;
  /** The table owns these buffers so filtering and paging cannot discard edits. */
  buffer?: { raw: string; error: string | null; staleControl?: boolean };
  onBufferChange?(buffer: { raw: string; error: string | null }): void;
}

const REJECTED_EDIT_MESSAGE =
  "This change could not be applied. Discard this edit or correct it.";

/** A syntactically valid value is not accepted until its draft owner agrees. */
export function applyBulkAttributeCellInput(
  column: BulkAttributeColumn,
  raw: string,
  onChange: (value: unknown) => boolean | void,
): { value: unknown; error: string | null } {
  const result = parseBulkAttributeCellInput(column, raw);
  if (result.error) return result;
  try {
    return onChange(result.value) === false
      ? { value: undefined, error: REJECTED_EDIT_MESSAGE }
      : result;
  } catch {
    return { value: undefined, error: REJECTED_EDIT_MESSAGE };
  }
}

export function displayBulkAttributeValue(
  column: BulkAttributeColumn,
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(column.schema.enum)) {
    const index = column.schema.enum.findIndex((choice) => choice === value);
    return index < 0 ? "current-invalid" : "choice:" + index;
  }
  return ["string", "number", "boolean"].includes(typeof value)
    ? String(value)
    : "";
}

/** One scalar draft edit. Invalid intermediate text is retained, never emitted,
 * and reported to the table so its Apply action cannot submit a stale value. */
export function ListingBulkAttributeCell({
  column,
  value,
  sku,
  onChange,
  onValidityChange,
  disabled,
  required,
  inputId,
  describedBy,
  buffer,
  onBufferChange,
}: Props) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const [localRaw, setRaw] = useState(() =>
    displayBulkAttributeValue(column, value),
  );
  const [localError, setError] = useState<string | null>(null);
  const raw =
    (buffer?.staleControl && Array.isArray(column.schema.enum)
      ? "current-invalid"
      : buffer?.raw) ??
    (onBufferChange ? displayBulkAttributeValue(column, value) : localRaw);
  const error = buffer?.error ?? (onBufferChange ? null : localError);
  const validity = useRef(onValidityChange);
  const emitted = useRef<{ value: unknown } | null>(null);
  validity.current = onValidityChange;
  const displayed = displayBulkAttributeValue(column, value);
  useEffect(() => {
    if (onBufferChange) return;
    // A parent echo of this cell's own valid edit must not normalize away its
    // raw decimal text/cursor. Real external changes still replace the buffer.
    if (emitted.current && Object.is(value, emitted.current.value)) {
      emitted.current = null;
      return;
    }
    setRaw(displayed);
    setError(null);
    validity.current?.(null);
  }, [displayed, column.key, value, onBufferChange]);
  const ariaLabel = column.pathLabel + " for " + sku;
  function edit(next: string) {
    if (disabled) return;
    setRaw(next);
    const result = applyBulkAttributeCellInput(column, next, onChange);
    setError(result.error);
    onBufferChange?.({ raw: next, error: result.error });
    validity.current?.(result.error);
    if (!result.error) {
      emitted.current = { value: result.value };
    } else emitted.current = null;
  }
  const common = {
    id,
    disabled,
    "aria-label": ariaLabel,
    "aria-required": required || undefined,
    "aria-invalid": Boolean(error) || undefined,
    "aria-describedby":
      [describedBy, error ? id + "-error" : undefined]
        .filter(Boolean)
        .join(" ") || undefined,
  };
  return (
    <div className="min-w-0 space-y-1">
      {Array.isArray(column.schema.enum) ? (
        <select
          {...common}
          className="h-8 w-full rounded-md border bg-background px-2 py-1 text-xs font-normal"
          value={raw}
          onChange={(event) => edit(event.target.value)}
        >
          <option value="">Not set</option>
          {raw === "current-invalid" && (
            <option value="current-invalid" disabled>
              {buffer?.staleControl
                ? "Options changed (choose again)"
                : `Current: ${String(value)} (choose a valid option)`}
            </option>
          )}
          {column.schema.enum.map((choice, index) => (
            <option key={index} value={"choice:" + index}>
              {String(choice)}
            </option>
          ))}
        </select>
      ) : column.type === "boolean" ? (
        <select
          {...common}
          className="h-8 w-full rounded-md border bg-background px-2 py-1 text-xs font-normal"
          value={raw}
          onChange={(event) => edit(event.target.value)}
        >
          <option value="">Not set</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <Input
          {...common}
          className="h-8 px-2 text-xs font-normal"
          inputMode={column.type === "string" ? undefined : "decimal"}
          value={raw}
          maxLength={
            column.type === "string" &&
            typeof column.schema.maxLength === "number"
              ? column.schema.maxLength
              : undefined
          }
          onChange={(event) => edit(event.target.value)}
        />
      )}
      {error && (
        <p
          id={id + "-error"}
          role="alert"
          className="max-w-52 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
