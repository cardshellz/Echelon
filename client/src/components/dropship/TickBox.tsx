/**
 * A native checkbox (Space ticks it, a screen reader reads it as one),
 * "mixed" when some of what it stands for is ticked.
 */
export function TickBox({ label, checked, indeterminate = false, disabled = false, describedBy, onChange }: {
  /** Read out; left out when a visible label names it. */
  label?: string;
  checked: boolean;
  indeterminate?: boolean;
  /** The rows are an older list's, kept on screen while the new one loads: ticking them would tick products it may not hold. */
  disabled?: boolean;
  /** The id of the words that say why the box is as it is (Catalog step 1's How text); left out elsewhere, so the markup is unchanged. */
  describedBy?: string;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      aria-describedby={describedBy}
      checked={checked}
      disabled={disabled}
      // `indeterminate` is a property only, never an attribute.
      ref={(element) => { if (element) element.indeterminate = indeterminate; }}
      onChange={onChange}
      className="h-4 w-4 shrink-0 cursor-pointer accent-[#C060E0]"
    />
  );
}
