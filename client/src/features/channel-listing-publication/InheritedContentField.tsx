import type { ChangeEvent } from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { inheritedContentState } from "./content-inheritance";

interface Props {
  id: string;
  label: string;
  resetLabel: string;
  value: string | null;
  catalogValue: string | undefined;
  disabled: boolean;
  rows?: number;
  maxLength?: number;
  help?: string;
  onChange(value: string | null): void;
}

export function InheritedContentField({
  id,
  label,
  resetLabel,
  value,
  catalogValue,
  disabled,
  rows,
  maxLength,
  help,
  onChange,
}: Props) {
  const source = inheritedContentState(value, catalogValue);
  const custom = source === "custom";
  const sourceLabel = custom
    ? "Custom"
    : source === "catalog_unavailable"
      ? "Catalog unavailable"
      : source === "catalog_empty"
        ? "Catalog empty"
        : "Using catalog";
  const showSourceNotice =
    source === "catalog_unavailable" ||
    source === "catalog_empty" ||
    (value !== null && !custom);
  const message =
    source === "catalog_unavailable"
      ? "Catalog details are unavailable. An inherited value cannot be shown."
      : source === "catalog_empty"
        ? "The catalog has no value for this field."
        : value !== null && !custom
          ? "This empty field will use the catalog value when you update the draft."
          : custom
            ? "This value overrides the catalog for this listing."
            : "This listing uses the current catalog value.";
  const inputProps = {
    id,
    maxLength,
    disabled,
    value: value ?? catalogValue ?? "",
    "aria-describedby": `${id}-source${help ? ` ${id}-help` : ""}`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!disabled) onChange(event.target.value);
    },
  };
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
          <Badge
            variant="outline"
            className={
              custom
                ? "border-primary/20 bg-primary/10 text-primary"
                : source === "catalog_unavailable"
                  ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                  : "bg-muted/50 text-muted-foreground"
            }
          >
            {sourceLabel}
          </Badge>
        </div>
        {value !== null && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <RotateCcw aria-hidden="true" />
            {resetLabel}
          </Button>
        )}
      </div>
      {rows ? (
        <Textarea {...inputProps} rows={rows} className="text-foreground" />
      ) : (
        <Input {...inputProps} className="text-foreground" />
      )}
      <p
        id={`${id}-source`}
        className={
          showSourceNotice ? "text-xs text-muted-foreground" : "sr-only"
        }
      >
        {message}
      </p>
      {help && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}
