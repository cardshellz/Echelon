import * as http from "http";
import type { Pool } from "pg";
import {
  registerScheduledJob,
  type RegisteredJobHandle,
} from "../../../infrastructure/job-registry";

export const EBAY_LISTING_RECONCILE_LOCK_ID = 918502;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

export interface EbayListingReconciliationSchedulerDeps {
  db?: { execute: (query: any) => Promise<any> };
  dbPool: Pick<Pool, "connect">;
  notify?: (event: string, payload: Record<string, unknown>) => void;
  log?: (message: string, source?: string) => void;
}

/**
 * eBay Listing Reconciliation Scheduler (`P1.5` / `P1.7`) — checks synced
 * listings against eBay every 30 minutes under a mandatory advisory lock.
 */
export function startEbayListingReconciliationScheduler(
  deps: EbayListingReconciliationSchedulerDeps,
): RegisteredJobHandle {
  async function runEbayReconciliation(): Promise<void> {
    const client = await deps.dbPool.connect();
    try {
      const countResult = await client.query(
        `SELECT COUNT(*) AS cnt FROM channels.channel_listings WHERE channel_id = 67 AND sync_status = 'synced'`,
      );
      const count = parseInt(countResult.rows[0]?.cnt || "0", 10);
      if (count === 0) {
        return;
      }

      const internalApiKey = process.env.INTERNAL_API_KEY;
      if (!internalApiKey) {
        console.warn(
          "[eBay Reconcile] Skipping scheduled listing reconciliation: INTERNAL_API_KEY is not configured",
        );
        return;
      }

      const port = process.env.PORT || 5000;
      const reqData = JSON.stringify({});
      const options = {
        hostname: "127.0.0.1",
        port,
        path: "/api/ebay/listings/reconcile?_internal=1",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(reqData),
          Authorization: `Bearer ${internalApiKey}`,
        },
      };

      await new Promise<void>((resolve) => {
        const req = http.request(options, (res: any) => {
          let body = "";
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              console.warn(
                `[eBay Reconcile] Scheduled endpoint returned ${res.statusCode}: ${body.slice(0, 300)}`,
              );
              resolve();
              return;
            }

            try {
              const data = JSON.parse(body);
              const changes = (data.ended || 0) + (data.deleted || 0);
              if (data.checked > 0) {
                console.log(
                  `[eBay Reconcile] checked=${data.checked} active=${data.active} ended=${data.ended} deleted=${data.deleted} errors=${data.errors}`,
                );
              }
              if (changes > 0) {
                console.log(
                  `[eBay Reconcile] ⚠️ ${changes} listing(s) ended/deleted on eBay — check listing feed`,
                );
                try {
                  deps.notify?.("listing_status_change", {
                    title: "eBay Listings Changed",
                    message: `${changes} listing(s) ended or deleted on eBay since last check`,
                    data: { ended: data.ended, deleted: data.deleted, changes: data.changes },
                  });
                } catch {}
              }
            } catch {
              // ignore parse errors
            }
            resolve();
          });
        });
        req.on("error", (err: any) => {
          console.warn(`[eBay Reconcile] Scheduled run failed: ${err.message}`);
          resolve();
        });
        req.write(reqData);
        req.end();
      });
    } finally {
      client.release();
    }
  }

  const handle = registerScheduledJob({
    name: "channels.ebay_listing_reconcile",
    cadenceMs: RECONCILE_INTERVAL_MS,
    initialDelayMs: INITIAL_DELAY_MS,
    advisoryLockId: EBAY_LISTING_RECONCILE_LOCK_ID,
    writableStates: ["channels.channel_listings.sync_status"],
    deadLetterPolicy: "log_and_retry_next_tick",
    disableEnvVar: "EBAY_LISTING_RECONCILE_DISABLED",
    db: deps.db,
    gateInitialRunOnSchedule: true,
    run: runEbayReconciliation,
  });

  if (!handle.disabled) {
    deps.log?.("[eBay Reconcile] Scheduled reconciliation started (every 30 min)", "ebay-reconcile");
  }
  return handle;
}
