import { describe, expect, it } from "vitest";
import { parseOrderActionWarmOptions } from "../../../../../scripts/lib/order-action-warm-options";

describe("bounded order action warming arguments", () => {
  it("defaults to dry-run and retains an explicit bounded scope", () => {
    expect(parseOrderActionWarmOptions(["--order-id=100", "--order-id=200", "--actor=release-check"]))
      .toEqual({ orderIds: [100, 200], actor: "release-check", execute: false, passes: 10 });
    expect(parseOrderActionWarmOptions(["--order-id=100", "--actor=release-check", "--execute", "--passes=5"]))
      .toMatchObject({ execute: true, passes: 5 });
  });
  it.each([
    [], ["--order-id=0"], ["--order-id=-1"], ["--order-id=1.5"], ["--order-id=9007199254740992"],
    ["--order-id=1", "--order-id=1"], ["--order-id=1", "--passes=0"], ["--order-id=1", "--passes=11"],
    ["--order-id=1", "--unknown"], ["--order-id=1", "unexpected"],
    Array.from({ length: 21 }, (_, index) => `--order-id=${index + 1}`),
  ])("rejects invalid, absent, duplicate or unbounded scope %#", (...args) => {
    expect(() => parseOrderActionWarmOptions([...args, "--actor=release-check"])).toThrow();
  });
});
