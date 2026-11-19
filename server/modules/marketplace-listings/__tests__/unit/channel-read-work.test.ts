import { describe, expect, it, vi } from "vitest";
import { mapChannelReads } from "../../application/channel-read-work";
import { ChannelReadCoordinator } from "../../application/channel-read-coordinator";

describe("shared bounded channel reads", () => {
  it("preserves order under out-of-order completion", async () => {
    const releases = new Map<number, (value: number) => void>();
    const result = mapChannelReads([1, 2, 3], 2, item => new Promise<number>(resolve => { releases.set(item, resolve); }));
    expect([...releases.keys()]).toEqual([1, 2]);
    releases.get(2)!(20);
    await vi.waitFor(() => expect(releases.has(3)).toBe(true));
    releases.get(3)!(30); releases.get(1)!(10);
    expect(await result).toEqual([10, 20, 30]);
  });
  it("drains in-flight work before exposing failure and never starts later work", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async (item: number) => { if (item === 1) throw new Error("Read failed"); await held; return item; });
    let settled = false;
    const result = mapChannelReads([1, 2, 3, 4], 2, read).then(() => { settled = true; }, error => { settled = true; throw error; });
    const rejection = expect(result).rejects.toThrow("Read failed");
    await Promise.resolve();
    expect(settled).toBe(false); expect(read.mock.calls.map(([item]) => item)).toEqual([1, 2]);
    release(); await rejection;
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("coalesces immediately and does not cache completed or rejected results", async () => {
    const coordinator = new ChannelReadCoordinator<number>(1);
    const load = vi.fn(async () => 5);
    const first = coordinator.read(1, load);
    expect(coordinator.read(1, load)).toBe(first);
    expect(load).not.toHaveBeenCalled();
    expect(await first).toBe(5);
    await expect(coordinator.read(1, async () => { throw new Error("Read failed"); })).rejects.toThrow();
    expect(await coordinator.read(1, load)).toBe(5); expect(load).toHaveBeenCalledTimes(2);
  });
  it.each([0, -1, 21, 1.5, Number.NaN])("rejects invalid fan-out %s", async concurrency => {
    expect(() => new ChannelReadCoordinator(concurrency)).toThrow(RangeError);
    await expect(mapChannelReads([1], concurrency, async value => value)).rejects.toThrow(RangeError);
  });
});
