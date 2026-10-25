import { afterEach, describe, expect, it, vi } from "vitest";
import { nextSupplierReturnFollowupAttempt, SupplierReturnFollowupService } from "../../application/supplier-return-followup.service";

describe("supplier return publication retry scheduling", () => {
  const at = new Date("2026-10-20T12:00:00.000Z");
  it.each([[0, 30_000], [1, 60_000], [2, 120_000], [3, 240_000], [4, 300_000], [2_147_483_647, 300_000]])(
    "bounds the next delay after %i failed attempts",
    (attempts, delay) => {
      expect(nextSupplierReturnFollowupAttempt(at, attempts).getTime() - at.getTime()).toBe(delay);
      expect(at.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    },
  );
  it("rejects malformed attempts and clocks before producing a due time", () => {
    for (const attempts of [-1, 0.5, Number.NaN, 2_147_483_648]) {
      expect(() => nextSupplierReturnFollowupAttempt(at, attempts)).toThrow();
    }
    expect(() => nextSupplierReturnFollowupAttempt(new Date("invalid"), 0)).toThrow();
    expect(() => nextSupplierReturnFollowupAttempt(new Date(8_640_000_000_000_000), 0)).toThrow();
  });
});

describe("supplier return retry database timestamps", () => {
  const at = new Date("2026-10-20T12:00:00.000Z");
  afterEach(() => vi.restoreAllMocks());

  function fixture(nextAttemptAt: unknown, publisher: (variantId: number, trigger: string) => Promise<void>) {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ completed_at: null, next_attempt_at: nextAttemptAt, attempt_count: 0, has_receipt: true }] })
      .mockResolvedValue({ rows: [] });
    const transaction = { execute };
    const database = {
      execute: vi.fn(),
      transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    } as unknown as ConstructorParameters<typeof SupplierReturnFollowupService>[0];
    return { execute, worker: new SupplierReturnFollowupService(database, publisher, () => at) };
  }

  it.each([at, "2026-10-20 12:00:00+00", "2026-10-20T12:00:00.000Z"])(
    "accepts the actual PostgreSQL due timestamp transport %s",
    async value => {
      const publisher = vi.fn().mockResolvedValue(undefined);
      const { worker, execute } = fixture(value, publisher);
      expect(await worker.recover(1, 200)).toBe(true);
      expect(publisher).toHaveBeenCalledWith(200, "supplier_return");
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, undefined, "", "not-a-date", new Date("invalid"), 0])(
    "retains work without publication or acknowledgement for invalid timestamp %s",
    async value => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const publisher = vi.fn().mockResolvedValue(undefined);
      const { worker, execute } = fixture(value, publisher);
      expect(await worker.recover(1, 200)).toBe(false);
      expect(publisher).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("does not bypass a future PostgreSQL retry time", async () => {
    const publisher = vi.fn().mockResolvedValue(undefined);
    const { worker, execute } = fixture("2026-10-20 12:00:30+00", publisher);
    expect(await worker.recover(1, 200)).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("waits for the inventory publication owner before acknowledging the return followup", async () => {
    let started!: () => void, release!: () => void;
    const publicationStarted = new Promise<void>(resolve => { started = resolve; });
    const publisher = vi.fn(() => new Promise<void>(resolve => { release = resolve; started(); }));
    const { worker, execute } = fixture("2026-10-20 12:00:00+00", publisher);
    const pending = worker.recover(1, 200);
    await publicationStarted;
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    expect(await pending).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
