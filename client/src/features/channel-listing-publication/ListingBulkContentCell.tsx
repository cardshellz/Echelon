import { useId } from "react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { projectBulkField, projectBulkIdentifier } from "./bulk-field-state";
import {
  parseBulkGridField,
  bulkDescriptionPreview,
  type BulkGridBuffer,
  type BulkGridField,
} from "./bulk-grid-state";
import { errorMessage } from "./model";

interface Props {
  item: ListingDraftItem;
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  field: BulkGridField;
  label: string;
  sku: string;
  buffer?: BulkGridBuffer;
  disabled: boolean;
  expanded?: boolean;
  onBufferChange(buffer: BulkGridBuffer): void;
  onDiscardBuffer(): void;
  onChange(value: unknown): boolean;
  onExpand?(): void;
}

export function ListingBulkContentCell({
  item,
  metadata,
  field,
  label,
  sku,
  buffer,
  disabled,
  expanded,
  onBufferChange,
  onDiscardBuffer,
  onChange,
  onExpand,
}: Props) {
  const id = useId();
  const identifier =
    field === "identifier"
      ? projectBulkIdentifier(item, metadata.get(item.variantId))
      : null;
  const projection =
    field !== "identifier" ? projectBulkField([item], metadata, field) : null;
  const raw =
    buffer?.raw ?? identifier?.value?.value ?? projection?.value ?? "";
  const source = identifier?.source ?? projection?.source;
  const identifierType =
    buffer?.identifierType ?? identifier?.value?.type ?? "GTIN";
  const unavailable =
    source === "unavailable" || projection?.status === "unavailable";
  function edit(next: string, type = identifierType) {
    if (disabled) return;
    let error: string | null = null;
    try {
      if (!onChange(parseBulkGridField(field, next, type)))
        error = "This change could not be applied.";
    } catch (cause) {
      error = errorMessage(cause);
    }
    onBufferChange({
      raw: next,
      error,
      ...(field === "identifier" ? { identifierType: type } : {}),
    });
  }
  const common = {
    id,
    disabled,
    value: raw,
    "aria-label": `${label} for ${sku}`,
    "aria-invalid": Boolean(buffer?.error) || undefined,
    "aria-describedby": buffer?.error ? id + "-error" : undefined,
    placeholder: unavailable
      ? "Catalog unavailable"
      : field === "priceOverrideCents"
        ? "Use pricing rules"
        : "Not set",
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => edit(event.target.value),
    onBlur: () => {
      if (buffer && !buffer.error && !buffer.raw.trim()) onDiscardBuffer();
    },
  };
  return (
    <div className="min-w-0 space-y-1">
      {field === "identifier" ? (
        <div className="flex gap-1">
          <select
            className="h-8 w-20 shrink-0 rounded-md border bg-background px-1 text-xs"
            aria-label={`Identifier type for ${sku}`}
            disabled={disabled}
            value={identifierType}
            onChange={(event) =>
              edit(raw, event.target.value as typeof identifierType)
            }
          >
            {["GTIN", "UPC", "EAN", "ISBN"].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Input {...common} className="h-8 min-w-0 px-2 text-xs" />
        </div>
      ) : field === "description" && !expanded ? (
        <div className="min-w-0 space-y-1">
          <Textarea
            aria-label={`Description preview for ${sku}`}
            value={bulkDescriptionPreview(raw)}
            readOnly
            rows={3}
            className="h-20 min-h-20 w-full min-w-0 resize-none whitespace-pre-wrap break-words px-2 py-1 text-xs [overflow-wrap:anywhere]"
            placeholder={unavailable ? "Catalog unavailable" : "Not set"}
          />
          <button
            type="button"
            className="text-xs text-primary underline"
            aria-label={`Edit description for ${sku}`}
            onClick={onExpand}
          >
            Edit description
          </button>
        </div>
      ) : field === "images" && !expanded ? (
        <button
          type="button"
          className="h-8 w-full truncate rounded-md border bg-background px-2 text-left text-xs hover:bg-muted"
          aria-label={`Edit ${label.toLowerCase()} for ${sku}`}
          onClick={onExpand}
        >
          {field === "images" && raw
            ? `${raw.split("\n").filter(Boolean).length} images`
            : raw || (unavailable ? "Catalog unavailable" : "Not set")}
        </button>
      ) : expanded && (field === "description" || field === "images") ? (
        <Textarea {...common} className="min-h-44 text-sm" />
      ) : (
        <Input
          {...common}
          className="h-8 px-2 text-xs"
          inputMode={field === "priceOverrideCents" ? "decimal" : undefined}
        />
      )}
      <p className="text-[10px] leading-3 text-muted-foreground">
        {source === "custom"
          ? "Custom"
          : source === "pricing"
            ? "Using pricing rules"
            : unavailable
              ? "Catalog unavailable"
              : "Using catalog"}
      </p>
      {buffer?.error && (
        <p
          id={id + "-error"}
          role="alert"
          className="max-w-64 text-xs text-destructive"
        >
          {buffer.error}
        </p>
      )}
      {expanded && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (onChange(null)) onDiscardBuffer();
          }}
        >
          {field === "priceOverrideCents" ? "Use pricing rules" : "Use catalog"}
        </Button>
      )}
    </div>
  );
}
