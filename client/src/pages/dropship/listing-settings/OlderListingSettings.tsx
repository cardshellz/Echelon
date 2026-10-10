import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { OLDER_SETTINGS_WORDS } from "@/lib/dropship-listing-settings-attention";
import { NotSavedBadge } from "../catalog/UnsavedChangesGuard";

export interface OlderListingSettingsProps {
  /** False (no eBay store ready) shows the children as they are today, with no header and no toggle. */
  collapsible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An older panel holds a change that isn't saved: "● Not saved" by the title. */
  unsaved: boolean;
  /** Today's step 2 panels, unchanged. */
  children: ReactNode;
}

/**
 * "Older settings" (A1): today's step 2 panels, collapsed under the new step
 * until PRs 9-12 replace them.
 *
 * The panels stay mounted while closed, so their reads, drafts and leave
 * guard work as today: a toggle button (`aria-expanded`, `aria-controls`) and
 * a plain element with the `hidden` attribute around them (D3). Radix
 * `CollapsibleContent forceMount` is not used: with it, closed content stays
 * visible. The wrapper keeps one shape whether or not it collapses, so a
 * change of `collapsible` never remounts the panels and loses their drafts.
 */
export function OlderListingSettings({ collapsible, open, onOpenChange, unsaved, children }: OlderListingSettingsProps) {
  const titleId = useId();
  const contentId = useId();
  const closed = collapsible && !open;
  return (
    <div
      data-testid="older-listing-settings"
      data-collapsible={collapsible ? "true" : "false"}
      {...(collapsible ? { role: "region", "aria-labelledby": titleId } : {})}
      className={collapsible ? "mt-8 rounded-lg border border-zinc-200 bg-white" : undefined}
    >
      {collapsible ? (
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id={titleId} className="flex flex-wrap items-center gap-2 text-base font-semibold text-zinc-900">
              {OLDER_SETTINGS_WORDS.title}
              {unsaved && <NotSavedBadge />}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">{OLDER_SETTINGS_WORDS.intro}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 self-start"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => onOpenChange(!open)}
          >
            {open ? OLDER_SETTINGS_WORDS.hide : OLDER_SETTINGS_WORDS.show}
          </Button>
        </div>
      ) : null}
      {/* No display class here: one would override the `hidden` attribute. */}
      <div
        id={contentId}
        hidden={closed}
        data-testid="older-listing-settings-content"
        className={collapsible ? "border-t border-zinc-200 px-4 pb-4" : undefined}
      >
        {children}
      </div>
    </div>
  );
}
