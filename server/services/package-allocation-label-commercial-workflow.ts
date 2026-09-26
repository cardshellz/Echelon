import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "@shared/schema";
import { PackageAllocationBootstrapPersistenceService } from "../modules/shipping/package-allocation-bootstrap.service";
import {
  createTransactionBoundPackageAllocationLedgerRepository,
  PackageAllocationLedgerRepositoryError,
} from "../modules/shipping/package-allocation-ledger.repository";
import type { PackageAllocationLabelCommercialWorkflow } from "../modules/shipping/package-allocation-label-commercial-fulfillment.service";
import {
  adaptPersistedDeclaredPackageLifecycleEvidence,
  projectPersistedDeclaredPackageLifecycleShadow,
} from "../modules/shipping/declared-package-lifecycle-shadow.domain";
import { createChannelFulfillmentAuthorityRepository } from "../modules/oms/channel-fulfillment-authority.repository";
import {
  createChannelFulfillmentAuthorityService,
  type ChannelFulfillmentAuthorityClock,
  type ChannelFulfillmentAuthorityLogger,
} from "../modules/oms/channel-fulfillment-authority.service";
import { createChannelFulfillmentProjector } from "../modules/oms/channel-fulfillment-projection.repository";

// Preserve three total attempts, with at most 150ms of backoff. Immediate
// retries can exhaust the budget while a competing label transaction commits.
const TRANSACTION_RETRY_DELAYS_MS = [50, 100] as const;
const MAX_ERROR_CAUSE_DEPTH = 10;
const STATEMENT_TIMEOUT = "30000ms";
const LOCK_TIMEOUT = "5000ms";
const IDLE_TRANSACTION_TIMEOUT = "60000ms";

function retryableSerializationFailure(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && cause instanceof Error; depth += 1) {
    if (cause instanceof PackageAllocationLedgerRepositoryError && cause.code === "CONCURRENT_WRITE") return true;
    const code: unknown = (cause as Error & { code?: unknown }).code;
    if (code === "40001" || code === "40P01") return true;
    cause = cause.cause;
  }
  return false;
}

/** One database connection spans both owners' public APIs. No provider call is
 * permitted here: only the existing channel worker sends committed commands. */
export function createPackageAllocationLabelCommercialWorkflow(dependencies: {
  readonly pool: Pick<Pool, "connect">;
  readonly clock: ChannelFulfillmentAuthorityClock;
  readonly logger: ChannelFulfillmentAuthorityLogger;
  readonly waitForRetry?: (delayMs: number) => Promise<void>;
}): PackageAllocationLabelCommercialWorkflow {
  const waitForRetry = dependencies.waitForRetry ?? delay;
  return {
    async run(work) {
      for (let attempt = 1; ; attempt += 1) {
        const client = await dependencies.pool.connect();
        let discardError: Error | undefined;
        let retryDelayMs: number | undefined;
        try {
          const database = drizzle(client, { schema });
          const committedEvents: Readonly<Record<string, unknown>>[] = [];
          const result = await database.transaction(async (tx) => {
            await tx.execute(sql`SELECT
              set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
              set_config('lock_timeout', ${LOCK_TIMEOUT}, true),
              set_config('idle_in_transaction_session_timeout', ${IDLE_TRANSACTION_TIMEOUT}, true)`);
            const ledger = createTransactionBoundPackageAllocationLedgerRepository(client);
            const bootstrap = new PackageAllocationBootstrapPersistenceService(ledger);
            const fulfillmentAuthority = createChannelFulfillmentAuthorityService({
              repository: createChannelFulfillmentAuthorityRepository(tx),
              projector: createChannelFulfillmentProjector(tx),
              providerExecutor: {
                execute: async () => { throw new Error("Provider execution is forbidden inside label activation"); },
              },
              clock: dependencies.clock,
              logger: {
                info: (event) => { committedEvents.push(event); },
                warn: (event) => dependencies.logger.warn(event),
                error: (event) => dependencies.logger.error(event),
              },
            });
            return work({
              async loadLabelContents(shippingProviderLabelId) {
                const exactLabelId = Number(shippingProviderLabelId);
                if (!Number.isSafeInteger(exactLabelId) || exactLabelId <= 0
                  || String(exactLabelId) !== String(shippingProviderLabelId)) return null;
                const locked = await ledger.withSerializableTransaction((transaction) =>
                  transaction.lockAuthorityReadinessPackages([exactLabelId]));
                if (locked.length !== 1) return null;
                const persistedEvidence = locked[0].persistedEvidence;
                const adapted = adaptPersistedDeclaredPackageLifecycleEvidence(persistedEvidence);
                const projected = projectPersistedDeclaredPackageLifecycleShadow(persistedEvidence);
                if (adapted.outcome !== "adapted" || projected.outcome !== "projected") return null;
                return Object.freeze({
                  authoritativeContents: projected.projection.authoritativeContents,
                  providerObservations: Object.freeze(adapted.input.events.flatMap((event) =>
                    event.kind === "outbound_label_observed"
                    && event.contentsEvidence.status === "authoritative"
                      ? [{ eventKey: event.eventKey, contents: event.contentsEvidence.lines }]
                      : [])),
                  leadCorrections: Object.freeze(adapted.input.events.flatMap((event) =>
                    event.kind === "package_contents_attested"
                    && event.authorization === "lead_approved"
                      ? [{ resolvesEventKeys: event.resolvesEventKeys }]
                      : [])),
                });
              },
              bootstrap,
              fulfillmentAuthority,
            });
          }, { isolationLevel: "serializable" });
          for (const event of committedEvents) dependencies.logger.info(event);
          return result;
        } catch (error) {
          // Never return a possibly aborted connection to the pool. Owner
          // errors retain their classification for review/webhook retry.
          discardError = error instanceof Error ? error : new Error("Label transaction failed");
          retryDelayMs = TRANSACTION_RETRY_DELAYS_MS[attempt - 1];
          const retry = retryableSerializationFailure(error) && retryDelayMs !== undefined;
          dependencies.logger.warn({ code: "LABEL_COMMERCIAL_TRANSACTION_FAILED", attempt, retry });
          if (!retry) throw error;
        } finally {
          client.release(discardError);
        }
        // The entire failed transaction has rolled back and its connection is
        // released before waiting. The next attempt acquires a fresh snapshot;
        // never retry only the failed statement or a nested savepoint.
        if (retryDelayMs !== undefined) await waitForRetry(retryDelayMs);
      }
    },
  };
}
