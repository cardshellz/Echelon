/** Adapters describe provider effects; this policy alone decides whether an
 * unknown operation can be superseded by a fresh, current-value replacement.
 * Replacement never asserts that the old request failed or was not sent. */
export type PublicationEffect = "replace_existing" | "publish" | "remove" | "unknown";
export const MAX_PUBLICATION_REPLACEMENT_REQUESTS = 2000;

export interface LegacyMaintenanceEvidence {
  previousTarget: string;
  currentTarget: string;
  effect: PublicationEffect;
  affectedScopeKeys: readonly string[];
  replacementScopeKeys: readonly string[];
}

export function supportsCurrentValueReplacement(input: {
  owner: string;
  effects: readonly PublicationEffect[];
  stockIntentProven: boolean;
  legacyMaintenance?: LegacyMaintenanceEvidence;
}): boolean {
  if (!["legacy", "outbox"].includes(input.owner) || input.effects.length > MAX_PUBLICATION_REPLACEMENT_REQUESTS) return false;
  if (input.effects.length > 0) return input.effects.every(effect => effect === "replace_existing");
  if (input.owner === "outbox") return input.stockIntentProven;
  const proof = input.legacyMaintenance;
  return proof !== undefined && proof.effect === "replace_existing"
    && proof.previousTarget.length > 0 && proof.previousTarget === proof.currentTarget
    && proof.affectedScopeKeys.length > 0
    && new Set(proof.affectedScopeKeys).size === proof.affectedScopeKeys.length
    && proof.affectedScopeKeys.every(key => key.length > 0 && proof.replacementScopeKeys.includes(key));
}
