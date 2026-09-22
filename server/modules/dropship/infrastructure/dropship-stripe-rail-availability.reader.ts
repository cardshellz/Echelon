/**
 * Reads which funding rails the Stripe account can actually run, for the
 * readiness page.
 *
 * A rail can be configured in our environment and still be refused by Stripe
 * because the account never enabled it. Stripe says so only in the message of
 * the failing request, so without this the fact first appears as an
 * unexplained refusal in front of a vendor. Reading the account's own
 * capabilities states it before anyone meets it.
 *
 * The result is cached because the readiness page is a read path and must not
 * call Stripe once per panel render, and because an account capability changes
 * roughly never. A failure is cached for much less time than a success so a
 * recovered account shows up promptly. Concurrent callers share one in-flight
 * read rather than each starting their own.
 */

import type { DropshipClock } from "../application/dropship-ports";
import type {
  DropshipStripeRailAvailability,
  DropshipWalletFundingProvider,
} from "../application/dropship-wallet-service";
import { DropshipError } from "../domain/errors";

/** A capability changes roughly never, so a successful read is held a while. */
export const STRIPE_RAIL_AVAILABILITY_SUCCESS_TTL_MS = 5 * 60_000;

/** A failure is held only long enough to stop a page reload hammering Stripe. */
export const STRIPE_RAIL_AVAILABILITY_FAILURE_TTL_MS = 30_000;

export type DropshipStripeRailAvailabilityReader = () => Promise<DropshipStripeRailAvailability>;

interface CachedAvailability {
  value: DropshipStripeRailAvailability;
  expiresAtMs: number;
}

export function createDropshipStripeRailAvailabilityReader(deps: {
  /** Null when no funding provider is configured; the reader then reports "unavailable". */
  provider: DropshipWalletFundingProvider | null;
  clock: DropshipClock;
  successTtlMs?: number;
  failureTtlMs?: number;
}): DropshipStripeRailAvailabilityReader {
  const successTtlMs = deps.successTtlMs ?? STRIPE_RAIL_AVAILABILITY_SUCCESS_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? STRIPE_RAIL_AVAILABILITY_FAILURE_TTL_MS;
  let cached: CachedAvailability | null = null;
  let inFlight: Promise<DropshipStripeRailAvailability> | null = null;

  return async function readRailAvailability(): Promise<DropshipStripeRailAvailability> {
    const nowMs = deps.clock.now().getTime();
    if (cached && nowMs < cached.expiresAtMs) return cached.value;
    if (inFlight) return inFlight;

    const provider = deps.provider;
    if (!provider) {
      const value = unavailable("DROPSHIP_FUNDING_PROVIDER_NOT_CONFIGURED");
      cached = { value, expiresAtMs: nowMs + failureTtlMs };
      return value;
    }

    inFlight = provider.readRailAvailability()
      // A readiness page must never fail because Stripe is briefly unreachable,
      // so the failure becomes a reportable outcome rather than an exception.
      .catch((error: unknown) => unavailable(reasonFor(error)))
      .then((value) => {
        cached = {
          value,
          expiresAtMs: deps.clock.now().getTime() + (value.outcome === "read" ? successTtlMs : failureTtlMs),
        };
        return value;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

function unavailable(reason: string): DropshipStripeRailAvailability {
  return { outcome: "unavailable", accountId: null, cardPayments: null, achPayments: null, reason };
}

/** The structured code when we have one; the error's name otherwise. Never raw provider prose. */
function reasonFor(error: unknown): string {
  if (error instanceof DropshipError) return error.code;
  if (error instanceof Error) return error.name;
  return "unknown_error";
}
