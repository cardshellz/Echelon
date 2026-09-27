import { createHash } from "node:crypto";
import type { ReturnPolicy, ReturnBusinessContext } from "@shared/schema";
import {
  MAX_RETURN_POLICY_ARCHIVE_CONTEXTS,
  returnPolicyArchivePolicySchema,
  returnPolicyArchivePreviewSchema,
  type ReturnPolicyArchivePreview,
} from "@shared/returns/return-policy-archive.contract";
import {
  normalizeReturnPolicyScope,
  resolveReturnPolicy,
  returnPolicyMatches,
  ReturnPolicyDomainError,
} from "../domain/return-policy";

export interface ReturnPolicyArchiveSnapshot {
  policies: ReturnPolicy[];
  historicalReferences: ReturnPolicyArchivePreview["historicalReferences"];
}

/** Partition the resolver's finite equality predicates, including each residual
 * "other" class. These are all possible policy contexts, not a sample of orders.
 * Store partitions exist only for their exact vendor/channel, avoiding a global
 * Cartesian product or a misleading single fallback for a broad policy.
 */
export function buildReturnPolicyArchivePreview(
  snapshot: ReturnPolicyArchiveSnapshot,
  policyId: number,
): ReturnPolicyArchivePreview {
  const target = snapshot.policies.find((policy) => policy.id === policyId);
  if (!target || target.status !== "active") {
    throw new ReturnPolicyDomainError(
      "RETURN_POLICY_NOT_ACTIVE",
      "Only an active policy can be archived.",
    );
  }
  const active = snapshot.policies
    .filter((policy) => policy.status === "active")
    .sort((a, b) => a.id - b.id);
  if (
    active.length > 2_000 ||
    new Set(active.map((policy) => policy.id)).size !== active.length
  ) {
    throw new ReturnPolicyDomainError(
      "RETURN_POLICY_ARCHIVE_LIMIT",
      "The policy catalog needs administrator review before archiving.",
    );
  }
  const candidates = active.map((policy) => {
    const summary = returnPolicyArchivePolicySchema.parse(policy);
    if (normalizeReturnPolicyScope(summary).scopeKey !== summary.scopeKey) {
      throw new ReturnPolicyDomainError(
        "RETURN_POLICY_SCOPE_INVALID",
        "The saved policy scope could not be verified.",
      );
    }
    return summary;
  });
  const removed = candidates.filter((policy) => policy.id !== policyId);
  const targetCandidate = candidates.find((policy) => policy.id === policyId)!;
  const effects: ReturnPolicyArchivePreview["effects"] = [];
  const overrides = new Map<number, typeof targetCandidate>();
  let contexts = 0;
  for (const businessContext of ["retail", "dropship"] as const) {
    const relevant = candidates.filter(
      (policy) =>
        policy.businessContext === null ||
        policy.businessContext === businessContext,
    );
    const channelIds = exactIds(relevant.map((policy) => policy.channelId));
    for (const channelId of [...channelIds, null]) {
      const channelRepresentative = channelId ?? otherId(channelIds);
      const channelPolicies = relevant.filter(
        (policy) =>
          policy.channelId === null ||
          policy.channelId === channelRepresentative,
      );
      const vendorIds =
        businessContext === "dropship"
          ? exactIds(channelPolicies.map((policy) => policy.vendorId))
          : [];
      for (const vendorId of [...vendorIds, null]) {
        const storeIds =
          vendorId === null
            ? []
            : exactIds(
                channelPolicies
                  .filter((policy) => policy.vendorId === vendorId)
                  .map((policy) => policy.storeConnectionId),
              );
        for (const storeConnectionId of [...storeIds, null]) {
          if (++contexts > MAX_RETURN_POLICY_ARCHIVE_CONTEXTS) {
            throw new ReturnPolicyDomainError(
              "RETURN_POLICY_ARCHIVE_LIMIT",
              "The policy impact is too large to review safely in one operation.",
            );
          }
          const context = {
            businessContext,
            channelId: channelRepresentative,
            vendorId,
            storeConnectionId,
          };
          if (!returnPolicyMatches(targetCandidate, context)) continue;
          const before = resolveReturnPolicy(candidates, context)!;
          if (before.winner.id !== policyId) {
            overrides.set(before.winner.id, before.winner);
            continue;
          }
          const after = resolveReturnPolicy(removed, context);
          effects.push({
            contextLabel: contextLabel(
              businessContext,
              channelId,
              channelIds,
              vendorId,
              vendorIds,
              storeConnectionId,
              storeIds,
            ),
            before: targetCandidate,
            after: after?.winner ?? null,
          });
        }
      }
    }
  }
  const evidence = {
    policies: active,
    historicalReferences: snapshot.historicalReferences,
  };
  return returnPolicyArchivePreviewSchema.parse({
    policy: targetCandidate,
    revision: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
    effects,
    unaffectedMoreSpecificPolicies: [...overrides.values()].sort(
      (a, b) => a.id - b.id,
    ),
    historicalReferences: snapshot.historicalReferences,
  });
}
function exactIds(values: Array<number | null>): number[] {
  return [
    ...new Set(values.filter((value): value is number => value !== null)),
  ].sort((a, b) => a - b);
}
function otherId(ids: number[]): number {
  const present = new Set(ids);
  let id = 1;
  while (present.has(id)) id++;
  return id;
}
function contextLabel(
  context: ReturnBusinessContext,
  channelId: number | null,
  channels: number[],
  vendorId: number | null,
  vendors: number[],
  storeId: number | null,
  stores: number[],
): string {
  const residual = (
    name: string,
    excluded: number[],
    includesUnassigned = false,
  ): string =>
    `${excluded.length ? `Other ${name} (excluding ${excluded.join(", ")})` : `All ${name}`}${includesUnassigned ? ", including unassigned" : ""}`;
  const parts = [
    context === "retail" ? "Retail" : "Dropship",
    channelId === null
      ? residual("channels", channels)
      : `Channel ${channelId}`,
  ];
  if (context === "dropship") {
    parts.push(
      vendorId === null
        ? residual("vendors", vendors, true)
        : `Vendor ${vendorId}`,
    );
    if (vendorId !== null)
      parts.push(
        storeId === null
          ? residual("stores", stores, true)
          : `Store ${storeId}`,
      );
  }
  return parts.join(" · ");
}
