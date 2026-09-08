import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCutoverControls } from "../../inventory-cutover-controls";
import { InventoryPublicationRecoveryPanel } from "../../inventory-publication-recovery-panel";
import { CutoverHttpError, isDefinitiveCutoverRejection } from "../../inventory-cutover-http";

type Mutation = { mutationFn(): Promise<unknown>; onError?(error: Error): void; onSuccess?(result: unknown): void };
type Query = { queryKey: unknown[]; queryFn(input: { signal: AbortSignal }): Promise<unknown> };
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, mutations: [] as Mutation[], queries: [] as Query[],
  queryData: null as unknown, queryError: null as Error | null, fetching: false, refetch: vi.fn(), changed: vi.fn() }));

// Hook harness preserves one mounted component's state/refs across explicit
// renders. Tests invoke the actual component handlers and HTTP boundary; no DOM
// layout or React reconciliation behavior is claimed by this unit test.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (index >= hooks.cells.length) hooks.cells[index] = initial;
      return [hooks.cells[index], (next: unknown) => {
        hooks.cells[index] = typeof next === "function" ? (next as (prior: unknown) => unknown)(hooks.cells[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (index >= hooks.cells.length) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Query) => {
    hooks.queries.push(options);
    return { data: hooks.queryData, error: hooks.queryError, isError: hooks.queryError !== null,
      isFetching: hooks.fetching, refetch: hooks.refetch };
  },
  useMutation: (options: Mutation) => {
    hooks.mutations.push(options);
    return { error: null, data: null, isPending: false, mutate: vi.fn() };
  },
}));

const HASH = "a".repeat(64);
const TIME = "2026-09-08T12:00:00.000Z";
const unresolved = { attemptId: "7", owner: "legacy", state: "uncertain", outboxId: null,
  destinationKind: "dropship_store_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "account-1", externalInventoryItemId: "sku-P5" };

function evidence(action: "commit" | "finish") {
  const common = { activationRunId: "1", authorityRevision: "2", capturedAt: TIME, ready: true, blockers: [],
    providerWriteAttempted: false, operationalWriteAttempted: false, publicationRows: [] };
  return action === "commit" ? { ...common, contractVersion: "inventory_cutover_review_v1", reviewHash: HASH,
    selectionManifestHash: HASH, reconstructionHash: HASH, freshClaimImpactHash: HASH,
    manifest: { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [1], publicationTargetIds: [],
      selections: [{ kind: "model", key: "1", definitionId: 1, definitionHash: HASH }] },
    summary: { orders: 0, lines: 0, retainedIndependentBuildHolds: 0 } }
    : { ...common, contractVersion: "inventory_cutover_verification_v1", verificationHash: HASH,
      configurationFreezeOpen: true, completedAt: null, expectedPublicationRows: 0, verifiedPublicationRows: 0 };
}
function result(action: "commit" | "finish") {
  return action === "commit" ? { activationRunId: "1", runtimeAuthority: "canonical", authorityRevision: "3", reviewHash: HASH,
    selectionManifestHash: HASH, reconstructionHash: HASH, fullPublicationRows: 0, publicationVerification: "pending", alreadyApplied: true }
    : { activationRunId: "1", runtimeAuthority: "canonical", authorityRevision: "2", verificationHash: HASH,
      verifiedPublicationRows: 0, completedAt: TIME, configurationFreezeReleased: true, alreadyApplied: true };
}
function nodes(root: ReactNode): Array<Record<string, unknown>> {
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (!isValidElement(root)) return [];
  const props = root.props as Record<string, unknown>;
  return [props, ...nodes(props.children as ReactNode)];
}
function field(root: ReactNode, suffix: string) {
  const value = nodes(root).find(props => typeof props.id === "string" && props.id.endsWith(suffix));
  if (!value) throw new Error(`Missing field ${suffix}`);
  return value;
}
function change(root: ReactNode, suffix: string, value: string) {
  (field(root, suffix).onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function button(root: ReactNode, label: string) {
  return nodes(root).find(props => props.children === label && typeof props.onClick === "function");
}
function renderCutover(action: "commit" | "finish", canActivate = true) {
  hooks.cursor = 0; hooks.mutations = []; hooks.queries = [];
  return InventoryCutoverControls({ actorId: "operator-1", canActivate, activationRunId: "1",
    runtimeAuthority: action === "commit" ? "legacy" : "canonical", onStateChanged: hooks.changed });
}
function renderRecovery(canActivate = true, activationRunId: string | null = "1") {
  hooks.cursor = 0; hooks.mutations = []; hooks.queries = [];
  return InventoryPublicationRecoveryPanel({ actorId: "operator-1", canActivate, activationRunId, onStateChanged: hooks.changed });
}
function cutoverMutation(action: "commit" | "finish") { return hooks.mutations[action === "commit" ? 0 : 1]; }
async function rejectMutation(mutation: Mutation) {
  try { await mutation.mutationFn(); throw new Error("Expected rejected mutation"); }
  catch (error) { mutation.onError?.(error as Error); return error; }
}
function prepareRecovery() {
  hooks.queryData = { unresolvedAttempts: [unresolved], pendingCatchupCount: 0 };
  let root = renderRecovery();
  change(root, "-attempt", "7"); change(root, "-kind", "provider_terminal_request_record");
  change(root, "-outcome", "completed"); change(root, "-reference", "Retained request record 7");
  change(root, "-hash", HASH); change(root, "-reason", "Inspected the retained terminal request");
  root = renderRecovery();
  const checkbox = nodes(root).find(props => props.type === "checkbox")!;
  (checkbox.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  return renderRecovery();
}

beforeEach(() => {
  hooks.cells = []; hooks.cursor = 0; hooks.mutations = []; hooks.queries = []; hooks.queryData = null;
  hooks.queryError = null; hooks.fetching = false; vi.clearAllMocks();
  let sequence = 0; vi.stubGlobal("crypto", { randomUUID: () => `test-command-${++sequence}` });
});
afterEach(() => vi.unstubAllGlobals());

describe("same-command cutover retries across failed refresh", () => {
  it.each(["commit", "finish"] as const)("keeps exact %s body/key/reason after unverifiable proxy409 and failed refresh", async action => {
    hooks.queryData = evidence(action); let root = renderCutover(action);
    change(root, "cutover-reason-1", "Original reviewed reason"); root = renderCutover(action);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("proxy conflict", { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result(action)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(rejectMutation(cutoverMutation(action))).resolves.toMatchObject({ status: 409, code: undefined });
    hooks.queryError = new Error("Refresh unavailable"); hooks.queryData = null;
    root = renderCutover(action);
    expect(button(root, "Retry the same command")).toBeDefined();
    expect(field(root, "cutover-reason-1").disabled).toBe(true);
    await expect(cutoverMutation(action).mutationFn()).resolves.toMatchObject({ alreadyApplied: true });
    const bodies = fetchMock.mock.calls.map(([, init]) => init?.body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(String(bodies[0]))).toMatchObject({ reason: "Original reviewed reason", idempotencyKey: expect.stringContaining("test-command-1") });
  });

  it.each(["commit", "finish"] as const)("allows a fresh reviewed %s command only after a known definitive rejection", async action => {
    hooks.queryData = evidence(action); let root = renderCutover(action);
    change(root, "cutover-reason-1", "Initial reason"); renderCutover(action);
    const code = action === "commit" ? "CUTOVER_REVIEW_CHANGED" : "CUTOVER_VERIFICATION_CHANGED";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code, message: "Capture fresh evidence" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(result(action)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await rejectMutation(cutoverMutation(action)); root = renderCutover(action);
    expect(button(root, "Retry the same command")).toBeUndefined();
    expect(field(root, "cutover-reason-1").disabled).toBe(false);
    change(root, "cutover-reason-1", "Fresh reviewed reason"); renderCutover(action);
    await cutoverMutation(action).mutationFn();
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)); const next = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey); expect(next.reason).toBe("Fresh reviewed reason");
  });

  it.each(["commit", "finish"] as const)("rechecks permission before a retained %s retry", async action => {
    hooks.queryData = evidence(action); let root = renderCutover(action);
    change(root, "cutover-reason-1", "Reviewed reason"); renderCutover(action);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Uncertain network outcome")); vi.stubGlobal("fetch", fetchMock);
    await rejectMutation(cutoverMutation(action)); renderCutover(action, false);
    await expect(cutoverMutation(action).mutationFn()).rejects.toThrow("authorized operator");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("same-evidence recovery retry flow", () => {
  it("retains exact attestation after invalid409 even when refresh fails and the selected row disappears", async () => {
    prepareRecovery();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("not-json", { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ attemptId: "7", basis: "operator_attestation", replay: true, providerWriteAttempted: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await rejectMutation(hooks.mutations[0]); hooks.queryData = null; hooks.queryError = new Error("Failed history refresh");
    const root = renderRecovery(); expect(button(root, "Retry same attestation")?.disabled).toBe(false);
    expect(field(root, "-hash").disabled).toBe(true);
    await expect(hooks.mutations[0].mutationFn()).resolves.toMatchObject({ basis: "operator_attestation", replay: true });
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it("requires renewed permission even when exact evidence is retained", async () => {
    prepareRecovery(); const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Uncertain network outcome")); vi.stubGlobal("fetch", fetchMock);
    await rejectMutation(hooks.mutations[0]); expect(renderRecovery(false)).toBeNull();
    await expect(hooks.mutations[0].mutationFn()).rejects.toThrow("permission is required"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves latest aborted history on demand without sending a fabricated run ID", async () => {
    const payload = { activationRunId: "9", gateEpoch: "2", suppressed: false, capturedAt: TIME, basis: "recorded_attempt_history",
      providerWriteAttempted: false, pendingCatchupCount: 0, unresolvedAttempts: [] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    renderRecovery(true, null); expect(fetchMock).not.toHaveBeenCalled();
    await hooks.queries[0].queryFn({ signal: new AbortController().signal });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/inventory-planning/admin/publication-recovery/pending");
    expect(fetchMock.mock.calls[0][1]?.body).toBe("{}"); expect(hooks.queries[0].queryKey).toContain(null);
  });
});

describe("definitive rejection classification", () => {
  it.each([new CutoverHttpError("Unknown", 409), new CutoverHttpError("Unknown proxy", 409, "PROXY_CONFLICT"),
    new CutoverHttpError("Retry same key", 409, "CUTOVER_CONCURRENT_CHANGE"), new CutoverHttpError("Uncertain", 500, "CUTOVER_REVIEW_CHANGED"),
    Object.assign(new Error("Spoofed shape"), { status: 409, code: "CUTOVER_REVIEW_CHANGED" }),
  ])("preserves the original command for unproven outcomes: %#", error => { expect(isDefinitiveCutoverRejection(error)).toBe(false); });
  it.each(["CUTOVER_REVIEW_CHANGED", "CUTOVER_VERIFICATION_CHANGED", "PUBLICATION_RECOVERY_STATE_INVALID", "PUBLICATION_RECOVERY_REPLAY_CONFLICT"])(
    "permits new reviewed intent after definitive owner rejection %s", code => {
      expect(isDefinitiveCutoverRejection(new CutoverHttpError("Rejected", 409, code))).toBe(true);
    },
  );
});
