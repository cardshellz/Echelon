import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assemblyRequest, prepareAssemblyAttempt } from "../../assembly-api";

afterEach(() => vi.unstubAllGlobals());
describe("assembly command receipts and retry identity", () => {
  it("keeps one command ID for retries and does not mutate input", () => {
    const body = { action: "start", expectedVersion: 1 }; const before = structuredClone(body); const id = vi.fn(() => "one");
    const first = prepareAssemblyAttempt("/work", body, null, id);
    expect(prepareAssemblyAttempt("/work", body, first, id)).toBe(first);
    expect(id).toHaveBeenCalledOnce(); expect(body).toEqual(before);
    expect(() => prepareAssemblyAttempt("/work", { ...body, expectedVersion: 2 }, first, id)).toThrow("previous uncertain request");
    expect(() => prepareAssemblyAttempt("/other", body, first, id)).toThrow("previous uncertain request");
  });
  it("network failure is uncertain and preserves the original physical action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(assemblyRequest("/work", z.object({}), {})).rejects.toMatchObject({ uncertain: true, code: "NETWORK_UNCERTAIN" });
  });
  it.each([[409, false], [403, false], [503, true]])("classifies HTTP %s without hiding server guidance", async (status, uncertain) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "WORK_BLOCKED", message: "Resolve the blocked job" }), { status })));
    await expect(assemblyRequest("/work", z.object({}), {})).rejects.toMatchObject({ uncertain, message: "Resolve the blocked job" });
  });
  it("does not claim success for a malformed successful receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(assemblyRequest("/work", z.object({ id: z.string() }), {})).rejects.toMatchObject({ uncertain: true, code: "RECEIPT_INVALID" });
  });
  it("uses the authenticated session and validates a successful receipt", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 })); vi.stubGlobal("fetch", fetch);
    await expect(assemblyRequest("/work", z.object({ id: z.string() }), { commandId: "same" })).resolves.toEqual({ id: "1" });
    expect(fetch).toHaveBeenCalledWith("/work", expect.objectContaining({ method: "POST", credentials: "include", body: '{"commandId":"same"}' }));
  });
});
