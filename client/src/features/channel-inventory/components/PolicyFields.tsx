import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import {
  POLICY_FIELDS,
  SEMANTICS_LABELS,
  type PolicyFieldKey,
  type PolicyForm,
  type PolicyFormError,
  type SavedFieldSources,
} from "../model";
import { InlineError, SourceTag } from "./primitives";

type ScopeType = "channel" | "product" | "variant";

/**
 * The six selling controls, edited the same way at every scope. Each field
 * chooses between inheriting the broader rule and setting an explicit value;
 * "Inherit" is a distinct choice from an explicit zero or "No limit".
 */
export function PolicyFields({ form, onChange, scopeType, inherited, errors, disabled, idPrefix, unitNoun }: {
  form: PolicyForm;
  onChange(patch: Partial<PolicyForm>): void;
  scopeType: ScopeType;
  inherited: SavedFieldSources | null;
  errors: readonly PolicyFormError[];
  disabled?: boolean;
  idPrefix: string;
  /** Exact sellable unit for quantity fields, e.g. "units (1 unit = 5 pieces)". */
  unitNoun: string;
}) {
  const errorFor = (field: PolicyFieldKey) => errors.find((error) => error.field === field)?.message ?? null;
  const inheritLabel = scopeType === "channel" ? "Not set" : "Inherit";

  return (
    <div className="divide-y">
      <FieldRow
        field="eligible"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.eligible === "inherit" ? "inherit" : "set"}
        modeOptions={[[ "inherit", inheritLabel ], ["set", "Set"]]}
        onMode={(mode) => onChange({ eligible: mode === "inherit" ? "inherit" : "yes" })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("eligible")}
      >
        {form.eligible !== "inherit" && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={form.eligible}
            disabled={disabled}
            aria-label="Sell on this channel"
            onValueChange={(value) => { if (value === "yes" || value === "no") onChange({ eligible: value }); }}
          >
            <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
            <ToggleGroupItem value="no">No, show zero</ToggleGroupItem>
          </ToggleGroup>
        )}
      </FieldRow>

      <FieldRow
        field="shareBps"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.shareMode}
        modeOptions={[["inherit", inheritLabel], ["set", "Set"]]}
        onMode={(mode) => onChange({ shareMode: mode === "inherit" ? "inherit" : "set" })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("shareBps")}
      >
        {form.shareMode === "set" && (
          <UnitInput
            id={`${idPrefix}-share`}
            label="Offer percentage"
            value={form.sharePercent}
            suffix="%"
            placeholder="0–100"
            disabled={disabled}
            invalid={errorFor("shareBps") !== null}
            onChange={(value) => onChange({ sharePercent: value })}
          />
        )}
      </FieldRow>

      <FieldRow
        field="holdbackSellableUnits"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.holdbackMode}
        modeOptions={[["inherit", inheritLabel], ["set", "Set"]]}
        onMode={(mode) => onChange({ holdbackMode: mode === "inherit" ? "inherit" : "set" })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("holdbackSellableUnits")}
      >
        {form.holdbackMode === "set" && (
          <UnitInput
            id={`${idPrefix}-holdback`}
            label="Keep back"
            value={form.holdbackUnits}
            suffix={unitNoun}
            placeholder="0"
            disabled={disabled}
            invalid={errorFor("holdbackSellableUnits") !== null}
            onChange={(value) => onChange({ holdbackUnits: value })}
          />
        )}
      </FieldRow>

      <FieldRow
        field="maxPublish"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.maxMode}
        modeOptions={[["inherit", inheritLabel], ["unlimited", "No limit"], ["units", "Up to"]]}
        onMode={(mode) => onChange({ maxMode: mode as PolicyForm["maxMode"] })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("maxPublish")}
      >
        {form.maxMode === "units" && (
          <UnitInput
            id={`${idPrefix}-max`}
            label="Maximum to show"
            value={form.maxUnits}
            suffix={unitNoun}
            placeholder="e.g. 60"
            disabled={disabled}
            invalid={errorFor("maxPublish") !== null}
            onChange={(value) => onChange({ maxUnits: value })}
          />
        )}
      </FieldRow>

      <FieldRow
        field="minPublishSellableUnits"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.minMode}
        modeOptions={[["inherit", inheritLabel], ["set", "Set"]]}
        onMode={(mode) => onChange({ minMode: mode === "inherit" ? "inherit" : "set" })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("minPublishSellableUnits")}
      >
        {form.minMode === "set" && (
          <UnitInput
            id={`${idPrefix}-min`}
            label="Show zero below"
            value={form.minUnits}
            suffix={unitNoun}
            placeholder="0"
            disabled={disabled}
            invalid={errorFor("minPublishSellableUnits") !== null}
            onChange={(value) => onChange({ minUnits: value })}
          />
        )}
      </FieldRow>

      <FieldRow
        field="allocationSemantics"
        scopeType={scopeType}
        inherited={inherited}
        mode={form.semantics === "inherit" ? "inherit" : "set"}
        modeOptions={[["inherit", inheritLabel], ["set", "Set"]]}
        onMode={(mode) => onChange({ semantics: mode === "inherit" ? "inherit" : "exposure" })}
        disabled={disabled}
        idPrefix={idPrefix}
        error={errorFor("allocationSemantics")}
      >
        {form.semantics !== "inherit" && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={form.semantics}
            disabled={disabled}
            aria-label="Stock sharing"
            onValueChange={(value) => { if (value === "exposure" || value === "partitioned") onChange({ semantics: value }); }}
          >
            <ToggleGroupItem value="exposure">{SEMANTICS_LABELS.exposure}</ToggleGroupItem>
            <ToggleGroupItem value="partitioned">{SEMANTICS_LABELS.partitioned}</ToggleGroupItem>
          </ToggleGroup>
        )}
      </FieldRow>
    </div>
  );
}

function FieldRow({ field, scopeType, inherited, mode, modeOptions, onMode, disabled, idPrefix, error, children }: {
  field: PolicyFieldKey;
  scopeType: ScopeType;
  inherited: SavedFieldSources | null;
  mode: string;
  modeOptions: ReadonlyArray<readonly [string, string]>;
  onMode(mode: string): void;
  disabled?: boolean;
  idPrefix: string;
  error: string | null;
  children: ReactNode;
}) {
  const meta = POLICY_FIELDS.find((item) => item.key === field)!;
  const source = inherited?.[field] ?? null;
  const errorId = `${idPrefix}-${field}-error`;
  return (
    <div className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-6">
      <div className="space-y-1">
        <p className="text-sm font-medium">{meta.label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{meta.help}</p>
      </div>
      <div className="space-y-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          disabled={disabled}
          aria-label={`${meta.label}: inherit or set`}
          onValueChange={(value) => { if (value) onMode(value); }}
        >
          {modeOptions.map(([value, label]) => (
            <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {mode === "inherit" && (
          <InheritedReadout scopeType={scopeType} source={source} />
        )}
        {mode !== "inherit" && <div aria-describedby={error ? errorId : undefined}>{children}</div>}
        {error && <InlineError id={errorId}>{error}</InlineError>}
      </div>
    </div>
  );
}

function InheritedReadout({ scopeType, source }: { scopeType: ScopeType; source: SavedFieldSources[PolicyFieldKey] | null }) {
  if (scopeType === "channel") {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-300">
        A channel default must set this before it can be activated. Until then, publishing stays blocked.
      </p>
    );
  }
  if (!source || source.kind === "unset") {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-300">
        Not set by any broader rule yet; publishing for this item stays blocked until one provides it.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Uses <span className="font-medium text-foreground">{source.display}</span> from the{" "}
      <SourceTag kind={source.kind} authority={source.authority} />
    </p>
  );
}

function UnitInput({ id, label, value, suffix, placeholder, disabled, invalid, onChange }: {
  id: string;
  label: string;
  value: string;
  suffix: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange(value: string): void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn("w-32 tabular-nums", invalid && "border-destructive")}
      />
      <span className="text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}
