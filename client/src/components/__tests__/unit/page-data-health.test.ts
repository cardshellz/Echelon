import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { isUnhandledPageReadFailure } from "../../page-data-health";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(handlesLoadError?: unknown) {
  const client = new QueryClient();
  const options = {
    queryKey: ["page-data"],
    queryFn: vi.fn().mockResolvedValue({ ok: true }),
    initialData: { ok: true },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    meta: { handlesLoadError },
  };
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);
  cleanups.push(() => { unsubscribe(); client.clear(); });
  const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
  return { query, observer, options, unsubscribe };
}

describe("app-wide page-read error ownership", () => {
  for (const cached of [false, true]) {
    it(`includes an unhandled ${cached ? "refresh" : "initial-load"} failure`, () => {
      const { query } = fixture();
      query.setState({ status: "error", error: new Error("offline"), data: cached ? { ok: true } : undefined });
      expect(isUnhandledPageReadFailure(query)).toBe(true);
    });

    it(`excludes an inline-handled ${cached ? "refresh" : "initial-load"} failure`, () => {
      const { query } = fixture(true);
      query.setState({ status: "error", error: new Error("offline"), data: cached ? { ok: true } : undefined });
      expect(isUnhandledPageReadFailure(query)).toBe(false);
    });
  }

  it("requires an explicit true opt-out, not a truthy metadata value", () => {
    for (const metadata of [false, "true", 1]) {
      const { query } = fixture(metadata);
      query.setState({ status: "error", error: new Error("offline") });
      expect(isUnhandledPageReadFailure(query)).toBe(true);
    }
  });

  it("excludes successful active reads", () => {
    expect(isUnhandledPageReadFailure(fixture().query)).toBe(false);
  });

  it("excludes a failed query when its observer becomes disabled", () => {
    const { query, observer, options } = fixture();
    query.setState({ status: "error", error: new Error("offline") });
    expect(isUnhandledPageReadFailure(query)).toBe(true);
    observer.setOptions({ ...options, enabled: false });
    expect(isUnhandledPageReadFailure(query)).toBe(false);
  });

  it("does not follow an unmounted page through retained cache state", () => {
    const { query, unsubscribe } = fixture();
    query.setState({ status: "error", error: new Error("offline") });
    expect(isUnhandledPageReadFailure(query)).toBe(true);
    unsubscribe();
    expect(query.state.status).toBe("error");
    expect(isUnhandledPageReadFailure(query)).toBe(false);
  });
});
