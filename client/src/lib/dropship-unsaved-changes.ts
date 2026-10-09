/**
 * Unsaved changes on a page with several editors (the Catalog page's
 * Listing settings step). Each editor reports, under its own id, whether it
 * holds changes the vendor has not saved; leaving the page asks first while
 * any are reported. Pure: no React, no browser APIs.
 */

/** One editor that holds changes the vendor has not saved yet. */
export interface UnsavedDraft {
  /** Stable per editor and store, so one editor never clears another's entry. */
  id: string;
  /** The editor's title as the vendor sees it, e.g. "Listing pricing rules". */
  label: string;
  /**
   * How many changes the editor holds, when it counts them (the new Listing
   * settings step does; the older panels do not).
   */
  changes?: number;
  /**
   * Drops the editor's changes when the vendor chooses "Discard and leave".
   * It must keep one identity across renders: an entry whose label and count
   * did not change is kept as it is, with the first `discard` it was given.
   */
  discard?: () => void;
}

/** What an editor adds to its entry when it counts its changes. */
export interface UnsavedDraftExtra {
  changes: number;
  discard: () => void;
}

/**
 * Adds or replaces the entry for `id` when `entry` is given, or removes it
 * when `entry` is null. Returns the same array when nothing changed, so a
 * React state update with it does not re-render, and never mutates the input.
 * `discard` is not compared (a new closure each render would re-render
 * forever), only whether the entry has one.
 */
export function updateUnsavedDrafts(
  drafts: readonly UnsavedDraft[],
  id: string,
  entry: UnsavedDraft | null,
): readonly UnsavedDraft[] {
  const index = drafts.findIndex((draft) => draft.id === id);
  if (entry === null) {
    return index === -1 ? drafts : drafts.filter((draft) => draft.id !== id);
  }
  if (index !== -1 && sameEntry(drafts[index], entry)) return drafts;
  return index === -1 ? [...drafts, entry] : drafts.map((draft, at) => (at === index ? entry : draft));
}

function sameEntry(current: UnsavedDraft, next: UnsavedDraft): boolean {
  return current.label === next.label
    && current.changes === next.changes
    && (current.discard === undefined) === (next.discard === undefined);
}

/**
 * The drafts a leave question is about: every draft, or only those whose id
 * is in `scope` (closing one editor, or opening another, asks about that
 * editor's draft only).
 */
export function scopeUnsavedDrafts(
  drafts: readonly UnsavedDraft[],
  scope: readonly string[] | null,
): readonly UnsavedDraft[] {
  if (scope === null) return drafts;
  const ids = new Set(scope);
  return drafts.filter((draft) => ids.has(draft.id));
}

/** The leave prompt's sentence naming every editor with unsaved changes, or null when there are none. */
export function describeUnsavedDrafts(drafts: readonly UnsavedDraft[]): string | null {
  const labels = Array.from(new Set(drafts.map((draft) => draft.label)));
  if (labels.length === 0) return null;
  return `You have changes that aren't saved in ${joinLabels(labels)}.`;
}

/**
 * The leave prompt (R:536): "You have 2 changes that aren't saved." when
 * every draft counts its changes, otherwise today's sentence naming the
 * editors (`describeUnsavedDrafts`). Null when there are none.
 */
export function describeLeavePrompt(drafts: readonly UnsavedDraft[]): string | null {
  if (drafts.length === 0) return null;
  if (!drafts.every((draft) => isChangeCount(draft.changes))) return describeUnsavedDrafts(drafts);
  const total = drafts.reduce((sum, draft) => sum + (draft.changes ?? 0), 0);
  // The singular is interim: the record gives only the plural (R:536).
  return total === 1 ? "You have 1 change that isn't saved." : `You have ${total} changes that aren't saved.`;
}

function isChangeCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
