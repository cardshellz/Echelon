import { describe, expect, it } from "vitest";
import type {
  DropshipStripeRailAvailability,
  DropshipWalletFundingProvider,
} from "../../application/dropship-wallet-service";
import { DropshipError } from "../../domain/errors";
import {
  STRIPE_RAIL_AVAILABILITY_FAILURE_TTL_MS,
  STRIPE_RAIL_AVAILABILITY_SUCCESS_TTL_MS,
  createDropshipStripeRailAvailabilityReader,
} from "../../infrastructure/dropship-stripe-rail-availability.reader";

const BOTH_LIVE: DropshipStripeRailAvailability = {
  outcome: "read",
  accountId: "acct_test",
  cardPayments: "active",
  achPayments: "active",
  reason: null,
};

/** A clock the test moves by hand, so no cache expiry depends on wall time. */
function testClock(startMs = 1_000_000) {
  let ms = startMs;
  return { now: () => new Date(ms), advance: (by: number) => { ms += by; } };
}

function providerReturning(
  results: Array<DropshipStripeRailAvailability | Error>,
): { provider: DropshipWalletFundingProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    async readRailAvailability() {
      const result = results[Math.min(calls, results.length - 1)];
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as DropshipWalletFundingProvider;
  return { provider, calls: () => calls };
}

describe("createDropshipStripeRailAvailabilityReader", () => {
  it("reads once and serves the cached answer until it expires", async () => {
    const clock = testClock();
    const { provider, calls } = providerReturning([BOTH_LIVE]);
    const read = createDropshipStripeRailAvailabilityReader({ provider, clock });

    expect(await read()).toEqual(BOTH_LIVE);
    expect(await read()).toEqual(BOTH_LIVE);
    expect(calls()).toBe(1);

    // One millisecond before the deadline the cache still answers.
    clock.advance(STRIPE_RAIL_AVAILABILITY_SUCCESS_TTL_MS - 1);
    expect(await read()).toEqual(BOTH_LIVE);
    expect(calls()).toBe(1);

    clock.advance(1);
    expect(await read()).toEqual(BOTH_LIVE);
    expect(calls()).toBe(2);
  });

  it("reports a failure as an outcome rather than throwing, and retries sooner than a success", async () => {
    const clock = testClock();
    const { provider, calls } = providerReturning([
      new DropshipError("DROPSHIP_STRIPE_CREDENTIALS_REJECTED", "nope", { classification: "fatal" }),
      BOTH_LIVE,
    ]);
    const read = createDropshipStripeRailAvailabilityReader({ provider, clock });

    // The readiness page must still render, so the error becomes data.
    expect(await read()).toEqual({
      outcome: "unavailable",
      accountId: null,
      cardPayments: null,
      achPayments: null,
      reason: "DROPSHIP_STRIPE_CREDENTIALS_REJECTED",
    });

    // Held briefly so a page reload does not hammer Stripe...
    clock.advance(STRIPE_RAIL_AVAILABILITY_FAILURE_TTL_MS - 1);
    expect(await read()).toMatchObject({ outcome: "unavailable" });
    expect(calls()).toBe(1);

    // ...but far sooner than a success, so a recovered account shows up.
    clock.advance(1);
    expect(await read()).toEqual(BOTH_LIVE);
    expect(calls()).toBe(2);
  });

  it("never names the provider's own wording as the reason", async () => {
    const clock = testClock();
    const { provider } = providerReturning([new TypeError("fetch failed against acct_live_secret")]);
    const read = createDropshipStripeRailAvailabilityReader({ provider, clock });

    const result = await read();
    expect(result.reason).toBe("TypeError");
    expect(JSON.stringify(result)).not.toContain("acct_live_secret");
  });

  it("reports no provider as unavailable without pretending a rail is off", async () => {
    const clock = testClock();
    const read = createDropshipStripeRailAvailabilityReader({ provider: null, clock });

    expect(await read()).toEqual({
      outcome: "unavailable",
      accountId: null,
      cardPayments: null,
      achPayments: null,
      reason: "DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED",
    });
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const clock = testClock();
    const { provider, calls } = providerReturning([BOTH_LIVE]);
    const read = createDropshipStripeRailAvailabilityReader({ provider, clock });

    const [first, second, third] = await Promise.all([read(), read(), read()]);
    expect(first).toEqual(BOTH_LIVE);
    expect(second).toEqual(BOTH_LIVE);
    expect(third).toEqual(BOTH_LIVE);
    expect(calls()).toBe(1);
  });
});
