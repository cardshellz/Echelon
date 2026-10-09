import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createDropshipIdempotencyKey } from "@/lib/dropship-ops-surface";
import {
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  SAVED_FLASH_MS,
  decideOpen,
  isDraftDirty,
  isSavedFlashVisible,
  nextSaveAttempt,
  reduceListingSettingsDraft,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
  type WriteFailure,
} from "@/lib/dropship-listing-settings-drafts";
import { useLeaveGuard, useUnsavedDraft } from "../catalog/UnsavedChangesGuard";

/** How a save ended, as the row that sent it reports it. */
export type ListingSettingsSaveSettlement =
  | { kind: "saved" }
  /** Saved, but the re-read that redraws the row failed. */
  | { kind: "saved_view_stale" }
  /** A failed save, classified with `classifyWriteFailure`. */
  | { kind: "failure"; failure: WriteFailure };

export interface ListingSettingsDraftsValue {
  /** The step's one draft (D4), or null. */
  draft: ListingSettingsDraft | null;
  /** Whether "Saved" shows now (for SAVED_FLASH_MS after a confirmed save). */
  savedFlashVisible: boolean;
  /** The injected clock. */
  now: () => number;
  /**
   * Opens an editor with the saved value it starts from. Returns false when
   * it did not open now: another editor is saving, or another editor holds
   * changes, in which case the vendor is asked first and the editor opens
   * after "Discard and leave".
   */
  open: (editor: EditorId, place: string, base: DraftValue) => boolean;
  /** The vendor's new value (ignored while the draft is locked). */
  edit: (value: DraftValue) => void;
  /**
   * Starts a save of the request with this signature and returns its request
   * key: the same key for the same request, a new `keyPrefix:…` key for any
   * other. Null when no save can start (none open, one in flight, or an
   * unconfirmed save whose request differs).
   */
  startSave: (signature: string, keyPrefix: string) => string | null;
  /** Settles the save sent with `key`; an answer for an older or discarded attempt is ignored. */
  settle: (key: string, settlement: ListingSettingsSaveSettlement) => void;
  /**
   * "Load latest and keep my changes": the latest saved value becomes the base, and fields both changed are
   * marked. A draft with no changes takes the latest value as it is (nothing of the vendor's to keep on top).
   */
  rebase: (latest: DraftValue) => void;
  /** Drops the draft. */
  discard: () => void;
  /** Hides the editor; a draft with changes is kept (browser Back, the drawer). */
  close: () => void;
  /** × or Esc: closes at once without changes, otherwise asks first and drops them on "Discard and leave". */
  requestClose: () => void;
}

const ListingSettingsDraftsContext = createContext<ListingSettingsDraftsValue | null>(null);

interface DraftsState {
  storeConnectionId: number;
  draft: ListingSettingsDraft | null;
}

/** Shown in the leave prompt when nothing names the place (never while a draft has changes). */
const NO_PLACE_LABEL = "Listing settings";

/**
 * Holds the Listing settings step's one draft at page level (plan 4.1, 4.6),
 * so moving between catalog steps keeps it. It is not keyed by store: it
 * drops its draft when `storeConnectionId` changes (the store picker asked
 * first). It reports the draft to the page's leave guard with its change
 * count and a stable `discard`.
 *
 * The draft lives in a ref that every callback reads and writes at once, and
 * React state mirrors it for rendering. So a second click before React
 * re-renders (a double Save) sees the first one's attempt and never sends a
 * request under a second key.
 */
export function ListingSettingsDraftsProvider({
  storeConnectionId,
  now = () => Date.now(),
  newKey = createDropshipIdempotencyKey,
  children,
}: {
  storeConnectionId: number;
  now?: () => number;
  /** Makes a request key for a prefix; injected so tests are reproducible. */
  newKey?: (prefix: string) => string;
  children: ReactNode;
}) {
  const [state, setState] = useState<DraftsState>(() => ({ storeConnectionId, draft: null }));
  const stateRef = useRef(state);
  const nowRef = useRef(now);
  nowRef.current = now;
  const newKeyRef = useRef(newKey);
  newKeyRef.current = newKey;

  let current = state;
  if (state.storeConnectionId !== storeConnectionId) {
    // Another store: its settings are not this draft's. React re-renders at
    // once with the reset state (state derived from props, set during render).
    current = { storeConnectionId, draft: null };
    stateRef.current = current;
    setState(current);
  }
  const draft = current.draft;
  const guardId = `${LISTING_SETTINGS_GUARD_ID_PREFIX}${storeConnectionId}`;
  const guardIdRef = useRef(guardId);
  guardIdRef.current = guardId;

  const apply = useCallback((action: ListingSettingsDraftAction) => {
    const before = stateRef.current;
    const next = reduceListingSettingsDraft(before.draft, action);
    if (next === before.draft) return;
    const updated = { ...before, draft: next };
    stateRef.current = updated;
    setState(updated);
  }, []);

  const guard = useLeaveGuard();
  // Stable on purpose: the guard keeps the first `discard` it is given (updateUnsavedDrafts).
  const discard = useCallback(() => apply({ type: "discard" }), [apply]);
  useUnsavedDraft(guardId, draft?.place ?? NO_PLACE_LABEL, isDraftDirty(draft), { changes: draft?.changes ?? 0, discard });

  // "Saved" goes away after SAVED_FLASH_MS. The clock decides; the timer only wakes the render.
  const savedAtMs = draft?.phase === "saved" ? draft.savedAtMs : null;
  useEffect(() => {
    if (savedAtMs === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      const nowMs = nowRef.current();
      const live = stateRef.current.draft;
      if (isSavedFlashVisible(live, nowMs)) {
        timer = setTimeout(wake, Math.max(1, savedAtMs + SAVED_FLASH_MS - nowMs));
      } else {
        apply({ type: "tick", nowMs });
      }
    };
    timer = setTimeout(wake, Math.max(0, savedAtMs + SAVED_FLASH_MS - nowRef.current()));
    return () => clearTimeout(timer);
  }, [savedAtMs, apply]);

  const open = useCallback((editor: EditorId, place: string, base: DraftValue) => {
    const decision = decideOpen(stateRef.current.draft, editor);
    if (decision === "refuse") return false;
    if (decision === "ask") {
      guard(() => {
        apply({ type: "discard" });
        apply({ type: "open", editor, place, base });
      }, [guardIdRef.current]);
      return false;
    }
    apply({ type: "open", editor, place, base });
    return true;
  }, [apply, guard]);

  const edit = useCallback((value: DraftValue) => apply({ type: "edit", value }), [apply]);

  const startSave = useCallback((signature: string, keyPrefix: string) => {
    const attempt = nextSaveAttempt(stateRef.current.draft, signature, () => newKeyRef.current(keyPrefix));
    if (attempt === null) return null;
    apply({ type: "startSave", attempt });
    return attempt.key;
  }, [apply]);

  const settle = useCallback((key: string, settlement: ListingSettingsSaveSettlement) => {
    if (settlement.kind === "failure") apply({ type: "failure", key, failure: settlement.failure });
    else apply({ type: "saved", key, nowMs: nowRef.current(), viewStale: settlement.kind === "saved_view_stale" });
  }, [apply]);

  const rebase = useCallback((latest: DraftValue) => apply({ type: "rebase", latest }), [apply]);
  const close = useCallback(() => apply({ type: "close" }), [apply]);

  const requestClose = useCallback(() => {
    const live = stateRef.current.draft;
    if (live === null) return;
    // A save in flight is never dropped by closing; the draft stays until it settles.
    if (live.phase === "saving" || !isDraftDirty(live)) {
      apply({ type: "close" });
      return;
    }
    guard(() => apply({ type: "discard" }), [guardIdRef.current]);
  }, [apply, guard]);

  const savedFlashVisible = isSavedFlashVisible(draft, now());
  const value = useMemo<ListingSettingsDraftsValue>(() => ({
    draft,
    savedFlashVisible,
    now: () => nowRef.current(),
    open,
    edit,
    startSave,
    settle,
    rebase,
    discard,
    close,
    requestClose,
  }), [draft, savedFlashVisible, open, edit, startSave, settle, rebase, discard, close, requestClose]);

  return <ListingSettingsDraftsContext.Provider value={value}>{children}</ListingSettingsDraftsContext.Provider>;
}

/** The step's draft and its actions. Every editor on the step sits inside a ListingSettingsDraftsProvider. */
export function useListingSettingsDrafts(): ListingSettingsDraftsValue {
  const value = useContext(ListingSettingsDraftsContext);
  if (value === null) {
    throw new Error("useListingSettingsDrafts needs a ListingSettingsDraftsProvider above it.");
  }
  return value;
}
