/** A request that may have committed is immutable until its outcome is known. */
export type DraftSaveState<Command> =
  | { kind: "idle" }
  | { kind: "saving" | "uncertain"; command: Command }
  | { kind: "conflict" };

export function isDefinitiveDraftRejection(status: number | null): boolean {
  // Timeout/proxy errors do not prove that the transaction was rejected.
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

export function canReplaceDraftBaseline(input: {
  dirty: boolean;
  saveState: DraftSaveState<unknown>["kind"];
}): boolean {
  return !input.dirty && input.saveState === "idle";
}
