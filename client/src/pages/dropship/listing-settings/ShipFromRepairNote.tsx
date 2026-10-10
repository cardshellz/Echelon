import { useEffect, useRef, useState } from "react";
import type { ConnectionBanner, ListingSettingsRight, ListingSettingsRightReason } from "@/lib/dropship-listing-settings-access";
import { Button } from "@/components/ui/button";
import { LISTING_SETTINGS_SAVE_WORDS, isDraftDirty, isDraftLocked } from "@/lib/dropship-listing-settings-drafts";
import {
  STORE_DEFAULT_EDITOR_WORDS,
  isStoreDefaultPolicyEditor,
  planFromSignature,
  planShipFromRepair,
  readShipFromRepairStart,
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
 * answer reloads the setup the policy editor is open on. A new repair is
 * planned only from the setup read again at the click (`readShipFromRepairStart`),
 * so a repair that landed while its answer was lost (its draft since taken by
 * another editor, or the page reloaded) reads as done and is not sent again.
 */
export function ShipFromRepairNote({ setup, right, onSaved, saveCallbacks, onBlocked }: ShipFromRepairNoteProps) {
  const drafts = useListingSettingsDrafts();
  const draft = drafts.draft?.editor === "shipFrom" ? drafts.draft : null;
  const save = useStoreSetupSave({ setup, saveCallbacks, onSaved, onBlocked });
  // The setup read "Update now" makes before it plans a repair.
  const [checking, setChecking] = useState(false);
  const checkingNow = useRef(false);
  // The step's draft as of the last render, for the decisions made after that read.
  const stepDraft = useRef(drafts.draft);
  stepDraft.current = drafts.draft;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
  // Check again stays offered while the repair is unconfirmed, even after a newer read says the
  // location is right: it is how the vendor learns how their save ended.
  const offered = uncertain || (needed && (right.editable || policyDraftWaiting));
  const disabled = policyDraftWaiting || (!right.editable && !uncertain) || draft?.phase === "saving"
    || saveCallbacks.disabled === true || setup.isFetching || checking;

  const onUpdate = async () => {
    if (disabled || checkingNow.current) return;
    const attempt = draft?.attempt;
    if (uncertain && attempt) {
      // "Check again": the same request with the same key, so it can never repair twice.
      const plan = save.prepare(() => planFromSignature(attempt.signature));
      if (plan) void save.run(plan);
      return;
    }
    // A new repair: read the setup again first, never plan from the cached read (a 409's
    // stale revision, or a repair whose answer was lost and that may have landed).
    checkingNow.current = true;
    setChecking(true);
    save.clearProblem();
    // throwOnError: a read cancelled in flight (another refetch, a save's cache sync) otherwise
    // resolves with the cached answer, which is the read this one is here to replace.
    const start = await readShipFromRepairStart(() => setup.refetch({ throwOnError: true })); // never rejects
    checkingNow.current = false;
    if (!mounted.current) return;
    setChecking(false);
    const held = stepDraft.current;
    if (start.kind === "read_failed") {
      save.showProblem(STORE_DEFAULT_EDITOR_WORDS.shipFromCheckFailed);
      return;
    }
    if (start.kind === "not_needed") {
      // Nothing to send. An earlier failed repair's words go with it, so the note can close.
      if (held?.editor === "shipFrom" && !isDraftLocked(held)) drafts.discard();
      return;
    }
    // C19: a policy change made while the setup was read; the button now waits for it.
    if (isStoreDefaultPolicyEditor(held?.editor) && isDraftDirty(held)) return;
    // The repair holds the step's one draft while it runs. Another editor's
    // unsaved change asks first; the vendor clicks again after deciding.
    // Open, plan and start run together, so no other editor can take the draft between them.
    if (!drafts.open("shipFrom", STORE_DEFAULT_EDITOR_WORDS.shipFromPlace, {})) return;
    const fresh = start.setup;
    const plan = save.prepare(() => planShipFromRepair(fresh));
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
        <Button type="button" variant="outline" className="w-fit shrink-0" disabled={disabled || (locked && !uncertain)} onClick={() => void onUpdate()}>
          {draft?.phase === "saving" ? LISTING_SETTINGS_SAVE_WORDS.saving
            : uncertain ? LISTING_SETTINGS_SAVE_WORDS.checkAgain
              : checking ? STORE_DEFAULT_EDITOR_WORDS.checkingEbay
                : STORE_DEFAULT_EDITOR_WORDS.updateNow}
        </Button>
      )}
    </div>
  );
}
