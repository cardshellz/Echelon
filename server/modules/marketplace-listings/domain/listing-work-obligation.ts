/** Execution owners normalize their durable receipts; lifecycle alone decides
 * whether those facts still represent channel work. Unsubmitted drafts are not
 * commands. Unknown effects remain obligations even after an error. */
export type ListingWorkPhase =
  "unsubmitted" | "pending" | "attention" | "completed" | "settled";
export function hasListingWorkObligation(phase: ListingWorkPhase): boolean {
  return phase === "pending" || phase === "attention";
}

export function canSettleUnsentListingFailure(input: {
  failed: boolean;
  dispatchProvenAbsent: boolean;
  failedScope: string;
  replacementScope: string;
  replacementVerified: boolean;
}): boolean {
  return (
    input.failed &&
    input.dispatchProvenAbsent &&
    input.replacementVerified &&
    input.failedScope === input.replacementScope
  );
}
