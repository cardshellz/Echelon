import { describe, expect, it } from "vitest";
import { selectReturnPolicyVersions } from "../return-policy-version-view";

describe("selectReturnPolicyVersions", () => {
  const policies = [
    { id: 1, name: "Store", version: 1, status: "retired" },
    { id: 2, name: "Channel", version: 1, status: "active" },
    { id: 3, name: "Store", version: 2, status: "retired" },
    { id: 4, name: "Channel", version: 2, status: "active" },
  ] as const;

  it("returns active versions in deterministic policy and version order", () => {
    expect(selectReturnPolicyVersions(policies, "active").map(({ id }) => id)).toEqual([4, 2]);
  });

  it("returns retired versions without mutating the source collection", () => {
    const sourceIds = policies.map(({ id }) => id);

    expect(selectReturnPolicyVersions(policies, "history").map(({ id }) => id)).toEqual([3, 1]);
    expect(policies.map(({ id }) => id)).toEqual(sourceIds);
  });
});