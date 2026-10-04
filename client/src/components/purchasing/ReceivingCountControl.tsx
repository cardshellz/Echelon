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
  saveTestId: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** Keep count entry and its confirmation state together in both layouts. */
export function ReceivingCountControl({
  lineId, value, hasDraft, showSave, confirmed, disabled, discardDisabled, compact,
  saveTestId, onChange, onSave, onDiscard,
}: ReceivingCountControlProps) {
  const draftDescriptionId = `received-count-draft-${compact ? "desktop" : "mobile"}-${lineId}`;

  return (
    <div className={compact ? "w-36 space-y-2" : "mt-1 space-y-2"}>
      <Input
        type="number"
        aria-label={`Received count for line ${lineId}`}
        aria-describedby={hasDraft ? draftDescriptionId : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.repeat || disabled) return;
          event.preventDefault();
          onSave();
        }}
        disabled={disabled}
        className="h-10 w-full"
        min={0}
        autoComplete="off"
      />
      {hasDraft && (
        <p id={draftDescriptionId} className="text-xs text-amber-800 dark:text-amber-200">
          Unsaved count
        </p>
      )}
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
          className="flex items-center justify-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-2 text-xs font-medium text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        >
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
          Count confirmed
        </div>
      )}
      {hasDraft && (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-h-[44px] w-full whitespace-normal"
          disabled={discardDisabled}
          onClick={onDiscard}
        >
          Discard count draft
        </Button>
      )}
    </div>
  );
}
