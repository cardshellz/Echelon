import { describe, expect, it } from "vitest";
import { runDueListingWork } from "../../application/listing-work-runner";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("shared listing work runner", () => {
  it("starts independent work up to its limit and drains every claim", async () => {
    const gate = deferred();
    const twoStarted = deferred();
    const started: number[] = [];
    const completed: number[] = [];
    let next = 1;
    const run = runDueListingWork({
      limit: 3,
      claim: async () => next <= 3 ? next++ : null,
      process: async claim => {
        started.push(claim);
        if (started.length === 2) twoStarted.resolve();
        await gate.promise;
        completed.push(claim);
      },
    });
    await twoStarted.promise;
    expect(started).toEqual([1, 2]);
    gate.resolve();
    await run;
    expect(started).toEqual([1, 2, 3]);
    expect(completed).toEqual([1, 2, 3]);
  });

  it("drains already claimed work before reporting a claim failure", async () => {
    const gate = deferred();
    const started = deferred();
    const failure = new Error("claim failed");
    let claims = 0;
    let completed = false;
    let settled = false;
    const run = runDueListingWork({
      limit: 3,
      claim: async () => {
        if (++claims === 1) return 1;
        throw failure;
      },
      process: async () => { started.resolve(); await gate.promise; completed = true; },
    });
    const outcome = run.then(() => { settled = true; }, error => { settled = true; throw error; });
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(outcome).rejects.toBe(failure);
    expect(completed).toBe(true);
    expect(claims).toBe(2);
  });

  it("does not abandon a claim obtained while another job fails", async () => {
    const claimingSecond = deferred();
    const secondClaim = deferred<number>();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const failure = new Error("first job failed");
    let claims = 0;
    let secondCompleted = false;
    const run = runDueListingWork({
      limit: 3,
      claim: async () => {
        claims += 1;
        if (claims === 1) return 1;
        if (claims === 2) { claimingSecond.resolve(); return secondClaim.promise; }
        return null;
      },
      process: async claim => {
        if (claim === 1) { await claimingSecond.promise; throw failure; }
        secondStarted.resolve();
        await releaseSecond.promise;
        secondCompleted = true;
      },
    });
    await claimingSecond.promise;
    await Promise.resolve();
    secondClaim.resolve(2);
    await secondStarted.promise;
    releaseSecond.resolve();
    await expect(run).rejects.toBe(failure);
    expect(secondCompleted).toBe(true);
    expect(claims).toBe(2);
  });
});
