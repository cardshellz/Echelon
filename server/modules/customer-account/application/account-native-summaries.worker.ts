import { z } from "zod";
import type {
  AccountNativeCursor,
  AccountNativeMaintenance,
  AccountNativeObservation,
  AccountNativeProvider,
} from "./account-native-summaries.ports";

export interface AccountNativeReport {
  code: string;
  connectionId?: number;
  outcome: "completed" | "failed";
  facts?: number;
  causeCode?: string;
}

/** The existing account maintenance scheduler owns this bounded read-only scan.
 * A saved cursor advances only after its facts commit; replay is safe. */
export class AccountNativeSummariesWorker {
  constructor(
    private readonly dependencies: {
      store: AccountNativeMaintenance;
      provider: AccountNativeProvider;
      now(): Date;
      newId(): string;
      report(event: AccountNativeReport): void;
    },
  ) {}

  private async retain(
    cursor: AccountNativeCursor,
    observation: AccountNativeObservation,
  ): Promise<void> {
    if (
      [...observation.facts, ...(observation.failures ?? [])].some(
        (fact) =>
          fact.channelId !== cursor.channelId ||
          fact.connectionId !== cursor.connectionId ||
          fact.shopDomain !== cursor.shopDomain,
      )
    )
      throw new Error("ACCOUNT_NATIVE_SCOPE_CHANGED");
    await this.dependencies.store.retain(observation);
    if (observation.failures?.length)
      this.dependencies.report({
        code: "ACCOUNT_NATIVE_SOURCE_RECORDS_UNAVAILABLE",
        connectionId: cursor.connectionId,
        outcome: "failed",
        causeCode: observation.failures[0].code,
      });
  }

  async run(): Promise<void> {
    const { store, provider, now, report } = this.dependencies;
    let cursor: AccountNativeCursor | null;
    try {
      cursor = await store.claim(now(), this.dependencies.newId());
    } catch (cause) {
      // A failure before a lease exists cannot be attributed to a connection.
      // Retain its classified cause instead of only the scheduler's aggregate error.
      report({ code: "ACCOUNT_NATIVE_CLAIM_FAILED", outcome: "failed", causeCode: failureCode(cause) });
      throw cause;
    }
    if (!cursor) return;
    let failed = true;
    try {
      const claims = await store.claimOrders(cursor, now());
      if (claims.length) {
        const observation = await provider.byIds(
          cursor.connectionId,
          claims.map((claim) => claim.externalOrderId),
        );
        if (
          [...observation.facts, ...(observation.failures ?? [])].some(
            (fact) =>
              !claims.some(
                (claim) => claim.externalOrderId === fact.externalOrderId,
              ),
          )
        )
          throw new Error("ACCOUNT_NATIVE_IDENTITY_CHANGED");
        await this.retain(cursor, observation);
        await store.completeOrders(
          cursor,
          claims,
          observation.startedAt,
          now(),
        );
      }
      if (cursor.deltaDue) {
        const page = await provider.page(
          cursor.connectionId,
          cursor.deltaAfter,
          cursor.deltaSince,
        );
        await this.retain(cursor, page.observation);
        await store.completePage(cursor, "delta", page, now());
      }
      if (!cursor.backfillComplete && cursor.backfillDue) {
        const page = await provider.page(
          cursor.connectionId,
          cursor.backfillAfter,
          null,
        );
        await this.retain(cursor, page.observation);
        await store.completePage(cursor, "backfill", page, now());
      }
      failed = false;
      report({
        code: "ACCOUNT_NATIVE_SWEEP",
        connectionId: cursor.connectionId,
        outcome: "completed",
      });
    } catch (cause) {
      report({
        code: "ACCOUNT_NATIVE_SWEEP_FAILED",
        connectionId: cursor.connectionId,
        outcome: "failed",
        causeCode: failureCode(cause),
      });
    } finally {
      await store.release(cursor, now(), failed);
    }
  }
}

function failureCode(cause: unknown): string {
  const parsed = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/) }).safeParse(cause);
  return parsed.success ? parsed.data.code : cause instanceof z.ZodError
    ? "ACCOUNT_NATIVE_RESPONSE_INVALID" : "ACCOUNT_NATIVE_REFRESH_FAILED";
}
