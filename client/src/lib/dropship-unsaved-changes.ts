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
}

/**
 * Adds or replaces the entry for `id` when `entry` is given, or removes it
 * when `entry` is null. Returns the same array when nothing changed, so a
 * React state update with it does not re-render, and never mutates the input.
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
  if (index !== -1 && drafts[index].label === entry.label) return drafts;
  return index === -1 ? [...drafts, entry] : drafts.map((draft, at) => (at === index ? entry : draft));
}

/** The leave prompt's sentence naming every editor with unsaved changes, or null when there are none. */
export function describeUnsavedDrafts(drafts: readonly UnsavedDraft[]): string | null {
  const labels = Array.from(new Set(drafts.map((draft) => draft.label)));
  if (labels.length === 0) return null;
  return `You have changes that aren't saved in ${joinLabels(labels)}.`;
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
