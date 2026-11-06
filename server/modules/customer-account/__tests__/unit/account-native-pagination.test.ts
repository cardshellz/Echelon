import { describe, expect, it } from "vitest";
import { accountNativeScanQuery, advanceAccountNativeScan, readAccountNativeScan,
  serializeAccountNativeScan, type AccountNativeScan } from "../../domain/account-native-pagination";

const start = () => readAccountNativeScan(4, null, null);
const info = (hasNextPage: boolean, endCursor: string | null = null) => ({ hasNextPage, endCursor });
const range = (): AccountNativeScan => ({ ...start(), upper: "1000" });

describe("lossless native history checkpoints", () => {
  it("uses unordered discovery only to bound a range, never to skip its unseen IDs", () => {
    const step = advanceAccountNativeScan(start(), ["200", "199", "500"], info(true, "discovery"));
    expect(step).toEqual({ kind: "range", scan: { ...start(), upper: "500" } });
    if (step.kind === "complete") throw new Error("Expected a range");
    expect(accountNativeScanQuery(step.scan)).toEqual({ after: null, search: "id:<=500", sort: "ID" });
    const next = advanceAccountNativeScan(step.scan, ["200", "199"], info(true, "opaque"));
    expect(next).toEqual({ kind: "continue", scan: { ...step.scan, pageCursor: "opaque", seen: 2 } });
  });
  it("moves the numeric boundary only after exhausting a bounded connection", () => {
    expect(advanceAccountNativeScan(range(), ["9", "3"], info(false, "end")))
      .toEqual({ kind: "continue", scan: { ...start(), lower: "1000" } });
    expect(advanceAccountNativeScan(start(), [], info(false))).toEqual({ kind: "complete" });
  });
  it("splits before the connection limit and resumes both halves using exact integer bounds", () => {
    const scan = { ...range(), upper: "90071992547409930001", pageCursor: "page-99", seen: 9900 };
    const step = advanceAccountNativeScan(scan, Array.from({ length: 100 }, (_, i) => String(BigInt("90071992547409929000")+BigInt(i))), info(true, "page-100"));
    if (step.kind === "complete") throw new Error("Expected split");
    expect(step.scan).toMatchObject({ lower: "0", upper: "90071992547409929050", pending: [scan.upper], seen: 0, pageCursor: null });
    const second = advanceAccountNativeScan(step.scan, [], info(false));
    if (second.kind === "complete") throw new Error("Expected right half");
    expect(second.scan).toMatchObject({ lower: step.scan.upper, upper: scan.upper, pending: [] });
  });
  it("fails explicitly for duplicate, out-of-range, empty and non-advancing provider pages", () => {
    for (const ids of [["1", "1"], ["1001"], ["0"]])
      expect(() => advanceAccountNativeScan(range(), ids, info(false))).toThrow();
    for (const [ids, page] of [[[], info(true, "next")], [["1"], info(true)], [["1"], info(true, "old")]] as const)
      expect(() => advanceAccountNativeScan({ ...range(), pageCursor: "old", seen: 1 }, ids, page))
        .toThrowError(expect.objectContaining({ code: "ACCOUNT_NATIVE_CURSOR_NOT_ADVANCING" }));
  });
  it("binds resumable progress to the exact connection and update window", () => {
    const since = new Date("2026-11-06T12:00:00Z");
    const scan = readAccountNativeScan(4, null, since), saved = serializeAccountNativeScan(scan);
    expect(readAccountNativeScan(4, saved, since)).toEqual(scan);
    for (const [connection, window] of [[5, since], [4, null], [4, new Date(since.getTime()+1)]] as const)
      expect(() => readAccountNativeScan(connection, saved, window))
        .toThrowError(expect.objectContaining({ code: "ACCOUNT_NATIVE_CURSOR_SCOPE_CHANGED" }));
    for (const invalid of ["99", "{}", "not-json", JSON.stringify({ ...scan, upper: "100", pending: ["99"] }),
      JSON.stringify({ ...scan, pageCursor: "opaque", seen: 0 })])
      expect(() => readAccountNativeScan(4, invalid, since)).toThrow();
  });
});
