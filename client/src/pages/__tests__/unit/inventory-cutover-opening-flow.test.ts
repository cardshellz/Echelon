import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCutoverOpeningPanel } from "../../inventory-cutover-opening-panel";
import { openingAssessment, openingSaved, openingSource, openingVerification } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

type Mutation = { mutationFn(): Promise<unknown>; onSuccess?(result: unknown): void; onError?(error: Error): void };
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, mutations: [] as Mutation[],
  source: null as unknown, sourceError: null as Error | null, fetching: false, changed: vi.fn(), refetch: vi.fn() }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++; if (index >= hooks.cells.length) hooks.cells[index] = initial;
    return [hooks.cells[index], (next: unknown) => { hooks.cells[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.cells[index]) : next; }];
  }, useRef: (initial: unknown) => {
    const index = hooks.cursor++; if (index >= hooks.cells.length) hooks.cells[index] = { current: initial }; return hooks.cells[index];
  } };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: hooks.source, error: hooks.sourceError,
  isError: hooks.sourceError !== null, isFetching: hooks.fetching, refetch: hooks.refetch }),
  useMutation: (options: Mutation) => { hooks.mutations.push(options); return { error: null, data: null, isPending: false, mutate: vi.fn() }; } }));

function render(canActivate = true) {
  hooks.cursor = 0; hooks.mutations = [];
  return InventoryCutoverOpeningPanel({ actorId: "operator-1", canActivate, onStateChanged: hooks.changed });
}
function nodes(root: ReactNode): Array<Record<string, unknown>> {
  if (Array.isArray(root)) return root.flatMap(nodes); if (!isValidElement(root)) return [];
  const props = root.props as Record<string, unknown>; return [props, ...nodes(props.children as ReactNode)];
}
function field(root: ReactNode, id: string) {
  const found = nodes(root).find(props => props.id === id); if (!found) throw new Error(`Field ${id} missing`); return found;
}
async function importVerification(input = openingVerification()) {
  const root = render(); const file = { size: 1, text: async () => JSON.stringify(input) } as File;
  (field(root, "opening-verification-file").onChange as (event: unknown) => void)({ target: { files: [file], value: "file" } });
  await vi.waitFor(() => expect(hooks.cells[0]).not.toBeNull());
}
async function invoke(index: number) {
  const mutation = hooks.mutations[index];
  try { const result = await mutation.mutationFn(); mutation.onSuccess?.(result); return result; }
  catch (error) { mutation.onError?.(error as Error); throw error; }
}
function confirmAndReason() {
  let root = render();
  const checkbox = nodes(root).find(props => props.type === "checkbox")!;
  (checkbox.onChange as (event: unknown) => void)({ target: { checked: true } });
  root = render();
  (field(root, "opening-verification-reason").onChange as (event: unknown) => void)({ target: { value: "Exact reviewed reason" } });
  return render();
}
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.source = openingSource(); hooks.sourceError = null; hooks.fetching = false; vi.clearAllMocks();
  let index = 0; vi.stubGlobal("crypto", { randomUUID: () => `opening-test-${++index}` }); });
afterEach(() => vi.unstubAllGlobals());

describe("opening verification explicit operator and retry flow", () => {
  it("requires independent confirmation after import and cannot skip server preview", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await importVerification(); render();
    await expect(invoke(0)).rejects.toThrow("independently verify");
    confirmAndReason(); await expect(invoke(1)).rejects.toThrow("without blockers"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preview never saves, and audit save retains the exact complete document and reason", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(openingAssessment())))
      .mockResolvedValueOnce(new Response(JSON.stringify(openingSaved()), { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    await importVerification(); confirmAndReason(); await invoke(0); render();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toMatch(/\/preview$/);
    await invoke(1); const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request).toEqual({ verification: openingVerification(), reason: "Exact reviewed reason", idempotencyKey: "opening:opening-test-1" });
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/verify$/); expect(hooks.changed).toHaveBeenCalledOnce();
  });
  it("retains same body/key through uncertain proxy409 and failed source refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(openingAssessment())))
      .mockResolvedValueOnce(new Response("Unverified proxy response", { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...openingSaved(), alreadyApplied: true }))); vi.stubGlobal("fetch", fetchMock);
    await importVerification(); confirmAndReason(); await invoke(0); render(); await expect(invoke(1)).rejects.toThrow("could not be verified");
    hooks.sourceError = new Error("Source unavailable"); const root = render();
    expect(field(root, "opening-verification-reason").disabled).toBe(true); expect(field(root, "opening-verification-file").disabled).toBe(true);
    await invoke(1); expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(hooks.changed).toHaveBeenCalledOnce();
  });
  it("allows a fresh review after explicit changed-evidence rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(openingAssessment())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "CUTOVER_OPENING_EVIDENCE_CHANGED", message: "Refresh required" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock); await importVerification(); confirmAndReason(); await invoke(0); render();
    await expect(invoke(1)).rejects.toThrow("Refresh required"); const root = render();
    expect(field(root, "opening-verification-reason").disabled).toBe(false);
    await expect(invoke(1)).rejects.toThrow("without blockers"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("cannot retry after activation permission is removed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(openingAssessment())))
      .mockRejectedValueOnce(new Error("Connection lost")); vi.stubGlobal("fetch", fetchMock);
    await importVerification(); confirmAndReason(); await invoke(0); render(); await expect(invoke(1)).rejects.toThrow("Connection lost");
    render(false); await expect(invoke(1)).rejects.toThrow("authorized operator"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("reimporting clears both confirmation and previous assessment", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(openingAssessment()))); vi.stubGlobal("fetch", fetchMock);
    await importVerification(); confirmAndReason(); await invoke(0);
    await importVerification({ ...openingVerification(), verificationReference: "New evidence reference" }); render();
    await expect(invoke(0)).rejects.toThrow("independently verify"); confirmAndReason();
    await expect(invoke(1)).rejects.toThrow("without blockers"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
