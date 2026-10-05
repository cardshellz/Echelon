import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import {
  POLICY_FIELDS,
  type PolicyFieldKey,
  type PolicyForm,
  type PolicyFormError,
  type SavedFieldSources,
} from "../model";
import { InlineError, SourceTag } from "./primitives";

type ScopeType = "channel" | "product" | "variant";

const ADVANCED_FIELDS: readonly PolicyFieldKey[] = [
  "holdbackSellableUnits", "maxPublish", "minPublishSellableUnits", "allocationSemantics",
];

/**
 * Editing a field creates its explicit value. Inherited values remain display
 * values until edited; restoring a default writes null through the form mode.
 */
export function PolicyFields({ form, onChange, scopeType, inherited, inheritedForm, errors, disabled, idPrefix, unitNoun }: {
  form: PolicyForm;
  onChange(patch: Partial<PolicyForm>): void;
  scopeType: ScopeType;
  inherited: SavedFieldSources | null;
  inheritedForm?: PolicyForm;
  errors: readonly PolicyFormError[];
  disabled?: boolean;
  idPrefix: string;
  /** Exact sellable unit for quantity fields, e.g. "units (1 unit = 5 pieces)". */
  unitNoun: string;
}) {
  const displayed = displayPolicyForm(form, scopeType === "channel" ? undefined : inheritedForm);
  const errorFor = (field: PolicyFieldKey) => errors.find((error) => error.field === field)?.message ?? null;
  const needsAdvanced = needsAdvancedFields(displayed);
  const [advancedOpen, setAdvancedOpen] = useState(needsAdvanced);
  const advancedError = errors.filter((error) => error.field !== "form" && ADVANCED_FIELDS.includes(error.field))
    .map((error) => `${error.field}:${error.message}`).join("|");

  useEffect(() => {
    if (advancedError) setAdvancedOpen(true);
  }, [advancedError]);

  useEffect(() => {
    if (needsAdvanced) setAdvancedOpen(true);
  }, [needsAdvanced]);

  const fieldProps = (field: PolicyFieldKey, usesDefault: boolean, onReset: () => void) => ({
    field, usesDefault, onReset, scopeType, disabled, idPrefix,
    source: inherited?.[field] ?? null,
    error: errorFor(field),
  });
  const controlProps = (field: PolicyFieldKey) => ({
    id: `${idPrefix}-${field}`,
    "aria-labelledby": `${idPrefix}-${field}-label`,
    "aria-describedby": [
      `${idPrefix}-${field}-help`,
      scopeType === "channel" ? null : `${idPrefix}-${field}-source`,
      errorFor(field) ? `${idPrefix}-${field}-error` : null,
    ].filter(Boolean).join(" "),
    "aria-invalid": errorFor(field) ? true : undefined,
  });

  return (
    <div className="space-y-6">
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <FieldRow {...fieldProps("eligible", form.eligible === "inherit", () => onChange({ eligible: "inherit" }))}>
          <RadioGroup
            {...controlProps("eligible")}
            value={displayed.eligible === "inherit" ? "" : displayed.eligible}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "yes" || value === "no") onChange({ eligible: value });
            }}
          >
            <RadioChoice id={`${idPrefix}-eligible-yes`} value="yes" selected={displayed.eligible === "yes"} disabled={disabled}
              onSelectCurrent={form.eligible === "inherit" ? () => onChange({ eligible: "yes" }) : undefined}>
              Available to sell
            </RadioChoice>
            <RadioChoice id={`${idPrefix}-eligible-no`} value="no" selected={displayed.eligible === "no"} disabled={disabled}
              onSelectCurrent={form.eligible === "inherit" ? () => onChange({ eligible: "no" }) : undefined}>
              Show as out of stock
            </RadioChoice>
          </RadioGroup>
        </FieldRow>

        <FieldRow {...fieldProps("shareBps", form.shareMode === "inherit", () => onChange({ shareMode: "inherit", sharePercent: "" }))}>
          <UnitInput
            {...controlProps("shareBps")}
            value={displayed.sharePercent}
            suffix="%"
            inputMode="decimal"
            placeholder="Enter percentage"
            disabled={disabled}
            onChange={(value) => onChange({ shareMode: "set", sharePercent: value })}
          />
        </FieldRow>
      </div>

      <details
        className="group min-w-0 rounded-lg border"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-lg px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-medium">Advanced stock rules</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">{advancedSummary(displayed)}</span>
          </span>
        </summary>
        <div className="space-y-6 border-t p-4">
          <div className="grid min-w-0 gap-6 md:grid-cols-2">
            <FieldRow {...fieldProps("holdbackSellableUnits", form.holdbackMode === "inherit", () => onChange({ holdbackMode: "inherit", holdbackUnits: "" }))}>
              <UnitInput
                {...controlProps("holdbackSellableUnits")}
                value={displayed.holdbackUnits}
                suffix={unitNoun}
                placeholder="Enter units"
                disabled={disabled}
                onChange={(value) => onChange({ holdbackMode: "set", holdbackUnits: value })}
              />
            </FieldRow>

            <FieldRow {...fieldProps("maxPublish", form.maxMode === "inherit", () => onChange({ maxMode: "inherit", maxUnits: "" }))}>
              <RadioGroup
                {...controlProps("maxPublish")}
                id={`${idPrefix}-maxPublish-options`}
                value={displayed.maxMode === "inherit" ? "" : displayed.maxMode}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === "unlimited") onChange({ maxMode: "unlimited" });
                  if (value === "units") onChange({ maxMode: "units", maxUnits: displayed.maxUnits });
                }}
                className="grid gap-2 sm:grid-cols-2"
              >
                <RadioChoice id={`${idPrefix}-max-unlimited`} value="unlimited" selected={displayed.maxMode === "unlimited"} disabled={disabled}
                  onSelectCurrent={form.maxMode === "inherit" ? () => onChange({ maxMode: "unlimited" }) : undefined}>
                  No maximum
                </RadioChoice>
                <RadioChoice id={`${idPrefix}-max-units`} value="units" selected={displayed.maxMode === "units"} disabled={disabled}
                  onSelectCurrent={form.maxMode === "inherit" ? () => onChange({ maxMode: "units", maxUnits: displayed.maxUnits }) : undefined}>
                  Limit quantity
                </RadioChoice>
              </RadioGroup>
              {displayed.maxMode === "units" && (
                <UnitInput
                  {...controlProps("maxPublish")}
                  value={displayed.maxUnits}
                  suffix={unitNoun}
                  placeholder="Enter maximum"
                  disabled={disabled}
                  onChange={(value) => onChange({ maxMode: "units", maxUnits: value })}
                />
              )}
            </FieldRow>

            <FieldRow {...fieldProps("minPublishSellableUnits", form.minMode === "inherit", () => onChange({ minMode: "inherit", minUnits: "" }))}>
              <UnitInput
                {...controlProps("minPublishSellableUnits")}
                value={displayed.minUnits}
                suffix={unitNoun}
                placeholder="Enter units"
                disabled={disabled}
                onChange={(value) => onChange({ minMode: "set", minUnits: value })}
              />
            </FieldRow>
          </div>

          <div className="border-t pt-6">
            <FieldRow {...fieldProps("allocationSemantics", form.semantics === "inherit", () => onChange({ semantics: "inherit" }))}>
              <RadioGroup
                {...controlProps("allocationSemantics")}
                value={displayed.semantics === "inherit" ? "" : displayed.semantics}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === "exposure" || value === "partitioned") onChange({ semantics: value });
                }}
                className="grid gap-3 md:grid-cols-2"
              >
                <RadioChoice
                  id={`${idPrefix}-sharing-exposure`}
                  value="exposure"
                  selected={displayed.semantics === "exposure"}
                  disabled={disabled}
                  onSelectCurrent={form.semantics === "inherit" ? () => onChange({ semantics: "exposure" }) : undefined}
                  description="Channels can offer the same available inventory. Orders use that shared stock."
                >
                  Share available stock
                </RadioChoice>
                <RadioChoice
                  id={`${idPrefix}-sharing-partitioned`}
                  value="partitioned"
                  selected={displayed.semantics === "partitioned"}
                  disabled={disabled}
                  onSelectCurrent={form.semantics === "inherit" ? () => onChange({ semantics: "partitioned" }) : undefined}
                  description="For channels using this option, percentages for overlapping stock must total 100% or less. This does not reserve physical stock."
                >
                  Limit combined channel percentages
                </RadioChoice>
              </RadioGroup>
            </FieldRow>
          </div>
        </div>
      </details>
    </div>
  );
}

function FieldRow({ field, scopeType, source, usesDefault, onReset, disabled, idPrefix, error, children }: {
  field: PolicyFieldKey;
  scopeType: ScopeType;
  source: SavedFieldSources[PolicyFieldKey] | null;
  usesDefault: boolean;
  onReset(): void;
  disabled?: boolean;
  idPrefix: string;
  error: string | null;
  children: ReactNode;
}) {
  const meta = POLICY_FIELDS.find((item) => item.key === field)!;
  return (
    <div className="min-w-0 space-y-3" data-policy-field={field}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <p id={`${idPrefix}-${field}-label`} className="text-sm font-medium">{meta.label}</p>
        {scopeType !== "channel" && !usesDefault && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-primary"
            disabled={disabled}
            aria-label={`Use default for ${meta.label}`}
            onClick={onReset}
          >
            Use default
          </Button>
        )}
      </div>
      <p id={`${idPrefix}-${field}-help`} className="text-xs leading-relaxed text-muted-foreground">{meta.help}</p>
      {children}
      {scopeType !== "channel" && (
        <p id={`${idPrefix}-${field}-source`} className="text-xs leading-relaxed text-muted-foreground">
          {!usesDefault ? `Custom setting for this ${scopeType === "variant" ? "SKU" : "product"}.`
            : !source || source.kind === "unset" ? "No default saved yet. Enter a value for this item."
            : <>Uses <span className="font-medium text-foreground">{source.display}</span> from the <SourceTag kind={source.kind} authority={source.authority} />.</>}
        </p>
      )}
      {error && <InlineError id={`${idPrefix}-${field}-error`}>{error}</InlineError>}
    </div>
  );
}

function RadioChoice({ id, value, selected, disabled, description, onSelectCurrent, children }: {
  id: string;
  value: string;
  selected: boolean;
  disabled?: boolean;
  description?: string;
  /** Choosing an inherited option explicitly can keep that value as an override. */
  onSelectCurrent?(): void;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors",
        selected ? "border-primary/50 bg-primary/5" : "border-border",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        className="mt-0.5 shrink-0"
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        onClick={selected ? onSelectCurrent : undefined}
      />
      <span className="min-w-0 space-y-1">
        <span id={`${id}-label`} className="block text-sm font-medium">{children}</span>
        {description && <span id={`${id}-description`} className="block text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

function UnitInput({ id, value, suffix, placeholder, disabled, inputMode = "numeric", onChange, ...accessibility }: {
  id: string;
  value: string;
  suffix: string;
  placeholder: string;
  disabled?: boolean;
  inputMode?: "numeric" | "decimal";
  onChange(value: string): void;
  "aria-labelledby": string;
  "aria-describedby": string;
  "aria-invalid"?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-2">
      <Input
        {...accessibility}
        id={id}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={cn("min-w-0 w-full tabular-nums", accessibility["aria-invalid"] && "border-destructive")}
      />
      <span className="min-w-0 text-xs leading-relaxed text-muted-foreground">{suffix}</span>
    </div>
  );
}

/** Keep inherited display values separate from the form that is persisted. */
function displayPolicyForm(form: PolicyForm, inherited?: PolicyForm): PolicyForm {
  if (!inherited) return form;
  return {
    eligible: form.eligible === "inherit" ? inherited.eligible : form.eligible,
    shareMode: form.shareMode === "inherit" ? inherited.shareMode : form.shareMode,
    sharePercent: form.shareMode === "inherit" ? inherited.sharePercent : form.sharePercent,
    holdbackMode: form.holdbackMode === "inherit" ? inherited.holdbackMode : form.holdbackMode,
    holdbackUnits: form.holdbackMode === "inherit" ? inherited.holdbackUnits : form.holdbackUnits,
    maxMode: form.maxMode === "inherit" ? inherited.maxMode : form.maxMode,
    maxUnits: form.maxMode === "inherit" ? inherited.maxUnits : form.maxUnits,
    minMode: form.minMode === "inherit" ? inherited.minMode : form.minMode,
    minUnits: form.minMode === "inherit" ? inherited.minUnits : form.minUnits,
    semantics: form.semantics === "inherit" ? inherited.semantics : form.semantics,
  };
}

function needsAdvancedFields(form: PolicyForm): boolean {
  return form.holdbackMode !== "set" || form.holdbackUnits.trim() !== "0"
    || form.maxMode !== "unlimited"
    || form.minMode !== "set" || form.minUnits.trim() !== "0"
    || form.semantics !== "exposure";
}

function advancedSummary(form: PolicyForm): string {
  const buffer = form.holdbackMode === "inherit" || !form.holdbackUnits.trim()
    ? "Buffer needs a value" : form.holdbackUnits.trim() === "0" ? "No stock buffer" : `Buffer: ${form.holdbackUnits} units`;
  const maximum = form.maxMode === "inherit" ? "Choose a maximum"
    : form.maxMode === "unlimited" ? "No maximum"
    : !form.maxUnits.trim() ? "Maximum needs a value" : `Maximum: ${form.maxUnits} units`;
  const cutoff = form.minMode === "inherit" || !form.minUnits.trim()
    ? "Cutoff needs a value" : form.minUnits.trim() === "0" ? "No cutoff" : `Cutoff: ${form.minUnits} units`;
  const sharing = form.semantics === "inherit" ? "Choose stock sharing"
    : form.semantics === "exposure" ? "Shared stock" : "Combined percentages limited";
  return [buffer, maximum, cutoff, sharing].join(" · ");
}
