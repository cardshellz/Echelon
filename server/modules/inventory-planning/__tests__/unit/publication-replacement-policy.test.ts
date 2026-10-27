import { describe, expect, it } from "vitest";
import { supportsCurrentValueReplacement, type LegacyMaintenanceEvidence } from "../../domain/publication-replacement-policy";

describe("shared current-value replacement policy", () => {
  const evidence: LegacyMaintenanceEvidence = { previousTarget: "verified-resource-set", currentTarget: "verified-resource-set",
    effect: "replace_existing", affectedScopeKeys: ["member"], replacementScopeKeys: ["group", "member"] };
  it("allows proved existing-resource maintenance without inventing a terminal result", () => {
    expect(supportsCurrentValueReplacement({ owner: "legacy", effects: [], stockIntentProven: false, legacyMaintenance: evidence })).toBe(true);
  });
  it.each(["publish", "remove", "unknown"] as const)("refuses an unknown %s effect", effect => {
    expect(supportsCurrentValueReplacement({ owner: "legacy", effects: [effect], stockIntentProven: false })).toBe(false);
    expect(supportsCurrentValueReplacement({ owner: "legacy", effects: [], stockIntentProven: false,
      legacyMaintenance: { ...evidence, effect } })).toBe(false);
  });
  it.each([
    { currentTarget: "different-offer-or-account" }, { previousTarget: "" }, { affectedScopeKeys: [] },
    { affectedScopeKeys: ["outside"] }, { affectedScopeKeys: ["member", "member"] },
  ])("retains unresolved identity and scope changes: %j", change => {
    expect(supportsCurrentValueReplacement({ owner: "legacy", effects: [], stockIntentProven: false,
      legacyMaintenance: { ...evidence, ...change } })).toBe(false);
  });
  it("requires evidence for an empty journal and rejects other active owner kinds", () => {
    expect(supportsCurrentValueReplacement({ owner: "legacy", effects: [], stockIntentProven: true })).toBe(false);
    expect(supportsCurrentValueReplacement({ owner: "setup", effects: [], stockIntentProven: false, legacyMaintenance: evidence })).toBe(false);
  });
});
