import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ReceivingCountControlProps {
  lineId: number;
  value: string;
  hasDraft: boolean;
  showSave: boolean;
  disabled: boolean;
  discardDisabled: boolean;
  compact: boolean;
  saveTestId: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** Keep count entry and its explicit save/discard actions together in both layouts. */
export function ReceivingCountControl({
  lineId, value, hasDraft, showSave, disabled, discardDisabled, compact,
  saveTestId, onChange, onSave, onDiscard,
}: ReceivingCountControlProps) {
  const draftDescriptionId = `received-count-draft-${compact ? "desktop" : "mobile"}-${lineId}`;

  return (
    <div className={compact ? "w-32 space-y-2" : "mt-1 space-y-2"}>
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
          variant="outline"
          size="sm"
          className="h-auto min-h-[44px] w-full whitespace-normal"
          onClick={onSave}
          disabled={disabled}
          aria-label={`Save received count for line ${lineId}`}
          data-testid={saveTestId}
        >
          <Check className="h-4 w-4 shrink-0" />
          Save count
        </Button>
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
