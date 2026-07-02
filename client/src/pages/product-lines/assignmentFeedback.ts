export type AssignmentMode = "move" | "duplicate";

export interface ProductLineAssignmentResult {
  requested?: number;
  added?: number;
  alreadyAssigned?: number;
  removedFromSource?: number;
  addedToTarget?: number;
}

export interface AssignmentFeedbackInput {
  result: ProductLineAssignmentResult | null | undefined;
  mode: AssignmentMode;
  requestedFallback: number;
  targetName: string;
  sourceName?: string;
}

export interface AssignmentFeedback {
  title: string;
  description: string;
}

function normalizeCount(value: unknown, fallback = 0): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return fallback;
  }
  return value as number;
}

function productLabel(count: number): string {
  return `${count} product${count === 1 ? "" : "s"}`;
}

export function buildAssignmentFeedback({
  result,
  mode,
  requestedFallback,
  targetName,
  sourceName = "source",
}: AssignmentFeedbackInput): AssignmentFeedback {
  const requested = normalizeCount(result?.requested, requestedFallback);
  const added =
    mode === "move"
      ? normalizeCount(result?.addedToTarget, 0)
      : normalizeCount(result?.added, normalizeCount(result?.addedToTarget, 0));
  const alreadyAssigned = normalizeCount(
    result?.alreadyAssigned,
    Math.max(0, requested - added),
  );
  const removedFromSource =
    mode === "move" ? normalizeCount(result?.removedFromSource, 0) : 0;

  const parts: string[] = [];
  if (mode === "move") {
    parts.push(`${removedFromSource} removed from ${sourceName}`);
  }
  if (added > 0) {
    parts.push(`${added} newly assigned to ${targetName}`);
  }
  if (alreadyAssigned > 0) {
    parts.push(`${alreadyAssigned} already assigned to ${targetName}`);
  }
  if (parts.length === 0) {
    parts.push("No assignment changes were needed");
  }

  return {
    title:
      mode === "move"
        ? `${productLabel(requested)} move completed`
        : `${productLabel(requested)} assignment updated`,
    description: `${parts.join(". ")}.`,
  };
}
