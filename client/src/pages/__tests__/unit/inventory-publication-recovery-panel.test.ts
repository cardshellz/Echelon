import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMutation, useQuery } from "@tanstack/react-query";
import { InventoryPublicationRecoveryPanel } from "../../inventory-publication-recovery-panel";

const state = vi.hoisted(() => ({ data: null as unknown, error: null as Error | null,
  result: null as unknown, fetching: false, mutate: vi.fn(), refetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: state.data, error: state.error, isError: state.error !== null,
    isFetching: state.fetching, refetch: state.refetch })),
  useMutation: vi.fn(() => ({ data: state.result, error: null, isPending: false, mutate: state.mutate })),
}));
const unresolved = { attemptId: "7", owner: "legacy", state: "uncertain", outboxId: null,
  destinationKind: "dropship_store_connection", connectionId: 9, providerKey: "ebay",
  providerScopeType: "account", externalScopeId: "account-1", externalInventoryItemId: "sku-P5" };
function render(overrides: Partial<Parameters<typeof InventoryPublicationRecoveryPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(InventoryPublicationRecoveryPanel, {
    actorId: "operator-1", canActivate: true, activationRunId: "1", onStateChanged: vi.fn(), ...overrides,
  }));
}
beforeEach(() => {
  state.data = null; state.error = null; state.result = null; state.fetching = false; vi.clearAllMocks();
});
describe("publication recovery operator panel", () => {
  it.each([{ canActivate: false }, { actorId: null }])("does not show recovery controls without authority %j", props => {
    expect(render(props)).toBe("");
  });
  it("never captures or submits automatically and scopes history to actor and run", () => {
    const html = render();
    expect(html).toContain("Check stalled publications");
    expect(html).toContain("Do not clear it just because stock currently looks correct");
    expect(state.refetch).not.toHaveBeenCalled(); expect(state.mutate).not.toHaveBeenCalled();
    expect(vi.mocked(useQuery).mock.calls[0][0]).toMatchObject({
      enabled: false, retry: false, gcTime: 0, queryKey: ["inventory-publication-recovery", "operator-1", "1"],
    });
  });
  it("does not present idle recorded history as a provider verification", () => {
    state.data = { unresolvedAttempts: [], pendingCatchupCount: 2 };
    const html = render();
    expect(html).toContain("0 unresolved attempts"); expect(html).toContain("2 catch-up scopes pending");
    expect(html).toContain("not a provider verification"); expect(html).not.toContain("<input");
  });
  it("requires selection and retained terminal evidence instead of defaulting to clearance", () => {
    state.data = { unresolvedAttempts: [unresolved], pendingCatchupCount: 2 };
    const html = render();
    expect(html).toContain("#7 · ebay connection 9 · sku-P5 · uncertain");
    expect(html).toContain("Retained evidence SHA-256");
    expect(html).toContain("Select an attempt"); expect(html).toContain("Choose terminal outcome");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Record operator attestation/);
  });
  it("explicitly labels a successful manual attestation without claiming a provider write", () => {
    state.result = { attemptId: "7", basis: "operator_attestation", replay: false, providerWriteAttempted: false };
    const html = render();
    expect(html).toContain("Operator attestation recorded for attempt 7");
    expect(html).toContain("No provider write or provider verification was performed");
  });
  it("does not submit even if a denied operator invokes the mutation directly", async () => {
    render({ canActivate: false });
    const options = vi.mocked(useMutation).mock.calls[0][0];
    await expect(options.mutationFn!({} as never, {} as never)).rejects.toThrow("permission is required");
  });
});
