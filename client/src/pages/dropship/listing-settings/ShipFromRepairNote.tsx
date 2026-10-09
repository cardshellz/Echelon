import type { ConnectionBanner, ListingSettingsRight, ListingSettingsRightReason } from "@/lib/dropship-listing-settings-access";
import { Button } from "@/components/ui/button";
import { LISTING_SETTINGS_SAVE_WORDS, isDraftDirty, isDraftLocked } from "@/lib/dropship-listing-settings-drafts";
import {
  STORE_DEFAULT_EDITOR_WORDS,
  isStoreDefaultPolicyEditor,
  planFromSignature,
  planShipFromRepair,
  shipFromRepairNeeded,
  type StoreSetupSaveCallbacks,
} from "@/lib/dropship-listing-settings-store-requests";
import { rightReasonLine } from "@/lib/dropship-listing-settings-words";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { StoreSetupSaveNotice, liveSetup, useStoreSetupSave, type ListingSetupRead } from "./PolicyDefaultRow";

export interface ShipFromRepairNoteProps {
  setup: ListingSetupRead;
  /** `rights.shipFrom` (plan 4.3): the shipping right, the location missing, and no unsaved policy change. */
  right: ListingSettingsRight;
  onSaved: () => void;
  saveCallbacks: StoreSetupSaveCallbacks;
  onBlocked?: (banner: ConnectionBanner | null) => void;
}

/** The shipping row and the banner already say these; the note does not repeat them. */
const REASONS_SAID_ELSEWHERE: ReadonlySet<ListingSettingsRightReason> = new Set([
  "shipping_setup", "shipping_unavailable", "not_needed", "save_policy_first",
]);

/**
 * Under the Shipping policy row: "Card Shellz needs to update where your items
 * ship from." [Update now] (R:513). One click runs W10, which points the
 * store's listings at the Card Shellz-managed eBay location again and changes
 * no setting. It waits for an unsaved policy change (C19), because the W10
 * answer reloads the setup the policy editor is open on.
 */
export function ShipFromRepairNote({ setup, right, onSaved, saveCallbacks, onBlocked }: ShipFromRepairNoteProps) {
  const drafts = useListingSettingsDrafts();
  const draft = drafts.draft?.editor === "shipFrom" ? drafts.draft : null;
  const save = useStoreSetupSave({ setup, saveCallbacks, onSaved, onBlocked });

  const live = liveSetup(setup);
  const needed = live !== null && shipFromRepairNeeded(live);
  // C19: the right says so when the step passes the draft in; the draft itself is checked too.
  const policyDraftWaiting = (isStoreDefaultPolicyEditor(drafts.draft?.editor) && isDraftDirty(drafts.draft))
    || (!right.editable && right.reason === "save_policy_first");
  const flash = draft !== null && draft.phase === "saved" && drafts.savedFlashVisible;
  const failed = draft !== null && draft.message !== null && draft.phase !== "editing";
  if (!needed && !flash && !failed && save.problem === null) return null;

  const locked = isDraftLocked(draft);
  const uncertain = draft?.phase === "uncertain";
  const reason = !right.editable && !REASONS_SAID_ELSEWHERE.has(right.reason) ? rightReasonLine(right.reason) : null;
  const offered = needed && (right.editable || policyDraftWaiting || uncertain);
  const disabled = policyDraftWaiting || (!right.editable && !uncertain) || draft?.phase === "saving"
    || saveCallbacks.disabled === true || setup.isFetching;

  const onUpdate = () => {
    if (disabled || live === null) return;
    const attempt = draft?.attempt;
    if (uncertain && attempt) {
      // "Check again": the same request with the same key, so it can never repair twice.
      const plan = save.prepare(() => planFromSignature(attempt.signature));
      if (plan) void save.run(plan);
      return;
    }
    // The repair holds the step's one draft while it runs. Another editor's
    // unsaved change asks first; the vendor clicks again after deciding.
    if (!drafts.open("shipFrom", STORE_DEFAULT_EDITOR_WORDS.shipFromPlace, {})) return;
    const plan = save.prepare(() => planShipFromRepair(live));
    if (plan) void save.run(plan);
  };

  return (
    <div
      data-testid="ship-from-repair-note"
      className="mt-2 flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        {needed && <p>{STORE_DEFAULT_EDITOR_WORDS.shipFromNeeded}</p>}
        {needed && policyDraftWaiting && <p className="text-xs">{STORE_DEFAULT_EDITOR_WORDS.saveOrCancelPolicyFirst}</p>}
        {needed && reason && <p className="text-xs">{reason}</p>}
        <StoreSetupSaveNotice draft={failed ? draft : null} problem={save.problem} />
        <p role="status" className="empty:hidden text-emerald-800">{flash ? LISTING_SETTINGS_SAVE_WORDS.saved : ""}</p>
      </div>
      {offered && (
        <Button type="button" variant="outline" className="w-fit shrink-0" disabled={disabled || (locked && !uncertain)} onClick={onUpdate}>
          {draft?.phase === "saving" ? LISTING_SETTINGS_SAVE_WORDS.saving
            : uncertain ? LISTING_SETTINGS_SAVE_WORDS.checkAgain
              : STORE_DEFAULT_EDITOR_WORDS.updateNow}
        </Button>
      )}
    </div>
  );
}
