import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ReceivingCountControlProps {
  lineId: number;
  value: string;
  hasDraft: boolean;
  showSave: boolean;
  confirmed: boolean;
  disabled: boolean;
  discardDisabled: boolean;
  compact: boolean;
  inline?: boolean;
  unitDescription?: string;
  saveTestId: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** Keep count entry and its confirmation state together in both layouts. */
export function ReceivingCountControl({
  lineId, value, hasDraft, showSave, confirmed, disabled, discardDisabled, compact,
  saveTestId, onChange, onSave, onDiscard, inline = false, unitDescription,
}: ReceivingCountControlProps) {
  const draftDescriptionId = `received-count-draft-${compact ? "desktop" : "mobile"}-${lineId}`;
  const unitDescriptionId = `received-count-unit-${compact ? "desktop" : "mobile"}-${lineId}`;

  return (
    <div className={inline ? "grid min-w-0 grid-cols-[minmax(4rem,1fr)_auto] items-start gap-2" : compact ? "w-36 space-y-2" : "mt-1 space-y-2"}>
      <Input
        type="number"
        inputMode="numeric"
        aria-label={`Received count for line ${lineId}`}
        aria-describedby={[unitDescription ? unitDescriptionId : null, hasDraft ? draftDescriptionId : null].filter(Boolean).join(" ") || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.repeat || disabled) return;
          event.preventDefault();
          onSave();
        }}
        disabled={disabled}
        className={inline ? "h-11 min-w-0 w-full text-base" : "h-10 w-full"}
        min={0}
        autoComplete="off"
      />
      {unitDescription && <span id={unitDescriptionId} className="sr-only">{unitDescription}</span>}
      {showSave && (
        <Button
          size="sm"
          className="h-auto min-h-[44px] w-full whitespace-normal border-green-700 bg-green-700 text-sm font-semibold text-white hover:bg-green-800 focus-visible:ring-green-600"
          onClick={onSave}
          disabled={disabled}
          aria-label={`Confirm received count for line ${lineId}`}
          data-testid={saveTestId}
        >
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
          Confirm count
        </Button>
      )}
      {confirmed && !hasDraft && (
        <div
          role="status"
          aria-label={`Received count confirmed for line ${lineId}`}
          className="flex min-h-11 items-center justify-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-2 text-xs font-medium text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        >
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
          Count confirmed
        </div>
      )}
      {hasDraft && <p id={draftDescriptionId} className={inline ? "col-span-2 text-xs text-amber-800 dark:text-amber-200" : "text-xs text-amber-800 dark:text-amber-200"}>Unsaved count</p>}
      {hasDraft && (
        <Button
          variant="ghost"
          size="sm"
          className={inline ? "col-span-2 h-auto min-h-11 w-full whitespace-normal" : "h-auto min-h-[44px] w-full whitespace-normal"}
          disabled={discardDisabled}
          onClick={onDiscard}
        >
          Discard count draft
        </Button>
      )}
    </div>
  );
}
