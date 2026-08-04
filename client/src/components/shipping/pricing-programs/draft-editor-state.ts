import type { DraftLayout, RateGroup } from "../rate-table-model";

export function cloneRateGroups(groups: readonly RateGroup[]): RateGroup[] {
  return groups.map((group) => ({
    ...group,
    regions: [...group.regions],
    zipEntries: group.zipEntries.map((entry) => ({
      ...entry,
      prefixes: [...entry.prefixes],
    })),
    bands: group.bands.map((band) => ({ ...band })),
  }));
}

export function groupsWithSavedLayout(
  groups: readonly RateGroup[],
  draftLayout: DraftLayout | null,
): RateGroup[] {
  return groups.map((group, index) => {
    const saved = draftLayout?.groups[index];
    return saved === undefined
      ? { ...group }
      : {
          ...group,
          destinationGroupId: saved.destinationGroupId ?? null,
          destinationGroupLockVersion:
            saved.destinationGroupLockVersion ?? null,
          name: saved.name,
          availability: saved.availability ?? "offered",
        };
  });
}

export function initialDraftDirtyState(input: {
  draftId: number | null;
  hasUnsavedInitialChanges: boolean;
}): boolean {
  return input.draftId === null || input.hasUnsavedInitialChanges;
}

export function shouldSaveBeforeReview(input: {
  draftId: number | null;
  dirty: boolean;
  hasServerAnalysis: boolean;
}): boolean {
  return input.draftId === null || input.dirty || !input.hasServerAnalysis;
}
