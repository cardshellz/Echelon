export type ReturnPolicyVersionView = "active" | "history";

interface ReturnPolicyVersionSummary {
  name: string;
  version: number;
  status: string;
}

export function selectReturnPolicyVersions<T extends ReturnPolicyVersionSummary>(
  policies: readonly T[],
  view: ReturnPolicyVersionView,
): T[] {
  const expectedStatus = view === "active" ? "active" : "retired";
  return [...policies]
    .filter((policy) => policy.status === expectedStatus)
    .sort((left, right) => left.name.localeCompare(right.name) || right.version - left.version);
}