import { describe, expect, it, vi } from "vitest";
import { assertPublicationTransactionGuard, recordPublicationGuardProviderAttempt,
  type PublicationTransactionGuard } from "../../application/publication-transaction-guard";

describe("publication transaction guards", () => {
  it("uses only the explicitly supplied owner, including concurrent work", async () => {
    const client = { query: vi.fn() };
    const checked: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = vi.fn(async () => { entered(); await wait; checked.push("first"); });
    const second = vi.fn(async () => { checked.push("second"); });
    const pending = assertPublicationTransactionGuard(client,first);
    await ready;
    await assertPublicationTransactionGuard(client,second);
    await assertPublicationTransactionGuard(client);
    release();
    await pending;
    expect(checked).toEqual(["second","first"]);
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  });

  it("classifies owner and evidence failures so an adapter cannot bypass them", async () => {
    const client = { query: vi.fn() };
    const guard = Object.assign(vi.fn(async () => { throw Object.assign(new Error("lock failed"),{ code: "55P03" }); }), {
      recordProviderAttempt: vi.fn(async () => { throw new Error("receipt failed"); }),
    }) as PublicationTransactionGuard;
    await expect(assertPublicationTransactionGuard(client,guard)).rejects.toMatchObject({
      code: "PUBLICATION_OWNER_CHECK_FAILED",context: { sqlState: "55P03" },
    });
    await expect(recordPublicationGuardProviderAttempt(client,"1",guard,{ scopes: [],environment: null })).rejects.toMatchObject({
      code: "PUBLICATION_OWNER_EVIDENCE_FAILED",context: { attemptId: "1" },
    });
  });
});
