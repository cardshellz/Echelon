import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBackgroundOpeningSource } from "../../inventory-opening-capture";
import { openingSource } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";
const id="0f1b4b41-6cad-4caa-a3dd-d591179a6d84";
const status={id,state:"complete",stage:"complete",createdAt:"2026-09-10T00:00:00Z",completedAt:"2026-09-10T00:01:00Z",chunkCount:2,errorCode:null};
const response=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe("background source client",()=>{
  it("assembles all chunks and validates before returning source",async()=>{
    const text=JSON.stringify(openingSource()), middle=Math.floor(text.length/2);
    const fetchMock=vi.fn().mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({captureId:id,index:0,text:text.slice(0,middle)}))
      .mockResolvedValueOnce(response({captureId:id,index:1,text:text.slice(middle)}));
    vi.stubGlobal("fetch",fetchMock);
    expect(await fetchBackgroundOpeningSource(id,vi.fn())).toEqual(openingSource());
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({idempotencyKey:id}));
    expect(fetchMock.mock.calls.every(call=>!String(call[0]).endsWith("/source"))).toBe(true);
  });
  it("polls status without starting another job",async()=>{
    vi.useFakeTimers();
    const fetchMock=vi.fn().mockResolvedValueOnce(response({...status,state:"running",stage:"inventory_custody",completedAt:null,chunkCount:0}))
      .mockResolvedValueOnce(response({...status,chunkCount:1}))
      .mockResolvedValueOnce(response({captureId:id,index:0,text:JSON.stringify(openingSource())}));
    vi.stubGlobal("fetch",fetchMock); const progress=vi.fn();
    const result=fetchBackgroundOpeningSource(id,progress);
    await vi.advanceTimersByTimeAsync(2000); await result;
    expect(fetchMock.mock.calls.filter(call=>call[1]?.method==="POST")).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("Capture running: inventory custody");
  });
  it.each(["failed","wrong-id","wrong-index","invalid-json"])("never exposes partial %s evidence",async problem=>{
    const fetchMock=vi.fn().mockResolvedValueOnce(response(problem==="failed"?{...status,state:"failed",errorCode:"INTERRUPTED",chunkCount:0}:{...status,chunkCount:1}))
      .mockResolvedValueOnce(response({captureId:problem==="wrong-id"?"9f1b4b41-6cad-4caa-a3dd-d591179a6d84":id,index:problem==="wrong-index"?1:0,text:"{"}));
    vi.stubGlobal("fetch",fetchMock);
    await expect(fetchBackgroundOpeningSource(id,vi.fn())).rejects.toThrow();
  });
});
