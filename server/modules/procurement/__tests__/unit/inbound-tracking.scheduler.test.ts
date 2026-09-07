import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundTrackingService } from "../../inbound-tracking.service";
vi.mock("../../../../db",()=>({pool:{}}));
import { startInboundTrackingScheduler } from "../../inbound-tracking.runtime";
afterEach(()=>vi.useRealTimers());
describe("inbound tracking scheduler",()=>{
  it("does not overlap long polls and stops future work on shutdown",async()=>{
    vi.useFakeTimers(); let release:()=>void=()=>{};
    const poll=vi.fn(()=>new Promise<{claimed:number;failed:number}>((resolve)=>{release=()=>resolve({claimed:1,failed:0});}));
    const scheduler=startInboundTrackingScheduler({poll} as unknown as InboundTrackingService);
    await vi.advanceTimersByTimeAsync(30_000); expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000); expect(poll).toHaveBeenCalledTimes(1);
    release(); await Promise.resolve(); scheduler.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(poll).toHaveBeenCalledTimes(1);
  });
  it("logs a failed sweep safely and retries on the next interval",async()=>{
    vi.useFakeTimers(); const poll=vi.fn().mockRejectedValueOnce(new Error("sensitive-driver-details")).mockResolvedValue({claimed:0,failed:0});
    const error=vi.spyOn(console,"error").mockImplementation(()=>{}); const scheduler=startInboundTrackingScheduler({poll} as unknown as InboundTrackingService);
    try{await vi.advanceTimersByTimeAsync(30_000);expect(error).toHaveBeenCalledWith(expect.stringContaining("TRACKING_SWEEP_FAILED"));expect(JSON.stringify(error.mock.calls)).not.toContain("sensitive-driver-details");await vi.advanceTimersByTimeAsync(30_000);expect(poll).toHaveBeenCalledTimes(2);}finally{scheduler.stop();error.mockRestore();}
  });
});
