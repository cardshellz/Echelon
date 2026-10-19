import React from "react";
export interface ReceiveUnitOption {
  id: number;
  name: string | null;
  sku?: string | null;
  unitsPerVariant: number;
}

/** Shared presentation only. Each workflow retains its versioned command
 * and decides whether a selection edits a draft or converts a saved receipt. */
export function ReceiveUnitSelect({ id, label, value, options, disabled, piecesOption = false, emptyLabel, onChange }: {
  id?: string;
  label: string;
  value: number | null;
  options: readonly ReceiveUnitOption[];
  disabled?: boolean;
  piecesOption?: boolean;
  emptyLabel?: string;
  onChange: (variantId: number | null) => void;
}) {
  return <select id={id} aria-label={label} className="h-10 w-full rounded border bg-background px-2 text-sm"
    value={value ?? ""} disabled={disabled} onChange={(event) => {
      if (event.target.value === "") { if (piecesOption) onChange(null); return; }
      const selected = options.find((option) => String(option.id) === event.target.value);
      if (selected) onChange(selected.id);
    }}>
    <option value="" disabled={!piecesOption && !!emptyLabel}>{emptyLabel ?? (piecesOption ? "Base pieces (no configured piece unit)" : "Select a receive variant")}</option>
    {options.map((variant) => <option key={variant.id} value={variant.id}>
      {variant.name ?? variant.sku ?? `Variant ${variant.id}`} ({variant.unitsPerVariant} pieces)
    </option>)}
  </select>;
}
