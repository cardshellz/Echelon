import { costSourceRevisionSchema, type CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { costFingerprint } from "../../inventory/domain/cost-fingerprint";

export interface CostSourceProposal {
  input: Omit<CostSourceRevision, "revision" | "fingerprint">;
  sourceEvidence: unknown;
}

export interface StoredCostSource {
  contract: unknown;
  fingerprint: unknown;
  source_evidence: unknown;
}

/** Equivalence never repairs a damaged immutable record. The captured contract,
 * its stored fingerprint and its exact original evidence must agree first. */
export function verifiedStoredCostSource(saved: StoredCostSource | undefined): CostSourceProposal | null {
  if (!saved) return null;
  const parsed = costSourceRevisionSchema.safeParse(saved.contract);
  if (!parsed.success) return null;
  const { revision: _revision, fingerprint, ...input } = parsed.data;
  if (saved.fingerprint !== fingerprint) return null;
  const proposal = { input, sourceEvidence: saved.source_evidence };
  try {
    return costFingerprint(proposal) === fingerprint ? proposal : null;
  } catch (error) {
    // JSONB cannot contain cycles/non-JSON values. Such a supplied snapshot is
    // not compatibility evidence; the caller must keep the current proposal.
    if (error instanceof TypeError) return null;
    throw error;
  }
}
