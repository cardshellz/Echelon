import { describe, expect, it, vi } from "vitest";
import { runOpeningCapture } from "../../application/inventory-opening-capture.worker";
import { openingCaptureChunks } from "../../infrastructure/inventory-opening-capture-artifact";
import { openingSource } from "../fixtures/inventory-cutover-opening-interface.fixture";
import { OPENING_CAPTURE_CHUNK_CHARACTERS } from "@shared/types/inventory-opening-capture";

const id = "0f1b4b41-6cad-4caa-a3dd-d591179a6d84";
function setup() {
  const store = { claim: vi.fn().mockResolvedValue({id,actor:"operator"}), progress:vi.fn(), writeResult:vi.fn().mockResolvedValue(2), complete:vi.fn(), fail:vi.fn() };
  const source = { capture:vi.fn().mockResolvedValue(openingSource()) };
  return { store,source,log:vi.fn() };
}
describe("background opening capture", () => {
  it("captures once and publishes only after every chunk, without verification or activation", async () => {
    const {store,source,log} = setup();
    expect(await runOpeningCapture(store,source,log)).toBe(true);
    expect(source.capture).toHaveBeenCalledExactlyOnceWith("operator",id);
    expect(store.writeResult).toHaveBeenCalledExactlyOnceWith(id,openingSource());
    expect(store.complete).toHaveBeenCalledExactlyOnceWith(id,2);
    expect(store.fail).not.toHaveBeenCalled();
  });
  it("does no source work for an empty queue", async () => {
    const {store,source,log} = setup(); store.claim.mockResolvedValue(null);
    expect(await runOpeningCapture(store,source,log)).toBe(false);
    expect(source.capture).not.toHaveBeenCalled();
  });
  it.each(["source","chunk","complete"])("fails closed on %s failure and does not retry a snapshot", async point => {
    const {store,source,log} = setup();
    const error = new Error("secret SQL payload");
    if (point === "source") source.capture.mockRejectedValue(error);
    if (point === "chunk") store.writeResult.mockRejectedValue(error);
    if (point === "complete") store.complete.mockRejectedValue(error);
    await runOpeningCapture(store,source,log);
    expect(source.capture).toHaveBeenCalledOnce();
    expect(store.fail).toHaveBeenCalledExactlyOnceWith(id,"CUTOVER_CAPTURE_FAILED");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    if (point !== "complete") expect(store.complete).not.toHaveBeenCalled();
  });
  it("bounds transport chunks and preserves Unicode and JSON escaping exactly", () => {
    const value = { name:"x".repeat(OPENING_CAPTURE_CHUNK_CHARACTERS-10)+"📦", rows:Array.from({length:500},(_,i)=>({i,name:'á📦"\\\n'.repeat(30)})), absent:undefined };
    const chunks = [...openingCaptureChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk=>chunk.length<=OPENING_CAPTURE_CHUNK_CHARACTERS && Buffer.byteLength(chunk)<=131072)).toBe(true);
    // Model pg's UTF-8 roundtrip, which would corrupt split surrogate pairs.
    expect(chunks.map(chunk=>Buffer.from(chunk).toString()).join("")).toBe(JSON.stringify(value));
  });
  it("rejects oversized artifacts instead of publishing a truncated census", () => {
    const rows = Array(2049).fill("x".repeat(OPENING_CAPTURE_CHUNK_CHARACTERS));
    expect(() => { for (const _chunk of openingCaptureChunks(rows)) { /* discard bounded chunks */ } }).toThrow("CUTOVER_CAPTURE_ARTIFACT_LIMIT");
  });
  it("retains only recognized failure codes and stages", async () => {
    const {store,source,log} = setup();
    source.capture.mockRejectedValue(Object.assign(new Error("secret SQL"), { code:"CUTOVER_EVIDENCE_CAPTURE_TIMEOUT",stage:"inventory_custody" }));
    await runOpeningCapture(store,source,log);
    expect(store.fail).toHaveBeenCalledWith(id,"CUTOVER_EVIDENCE_CAPTURE_TIMEOUT");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({stage:"inventory_custody"}));
    source.capture.mockRejectedValue({code:"secret SQL",stage:"secret SQL"});
    await runOpeningCapture(store,source,log);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
