import {
  buildPackageHistory,
  packageHistoryHash,
  packageHistoryNativeRevision,
  PackageHistoryError,
  type RetainedPackageHistoryShipment,
} from "./package-history.domain";
import type {
  PackageHistoryReport,
  PackageHistorySource,
  PackageHistoryStore,
  PackageHistoryFilter,
} from "./package-history.ports";
import { z } from "zod";

const CONCURRENCY = 2;
const MAX_TRACKING_NUMBERS = 200;
/** Captures presentation/evidence only. No shipment, inventory, payment, points,
 * fulfillment projector or carrier-dispatch dependency is available here. */
export class PackageHistoryWorker {
  constructor(
    private readonly dependencies: {
      source: PackageHistorySource;
      store: PackageHistoryStore;
      now(): Date;
      newId(): string;
      report(event: PackageHistoryReport): void;
    },
  ) {}

  async run(filter?: PackageHistoryFilter): Promise<number> {
    const { source, store, now, report } = this.dependencies;
    const emit = (event: PackageHistoryReport) => {
      try {
        report(event);
      } catch {
        console.error(
          JSON.stringify({
            action: "shipping_package_history_report",
            outcome: "failed",
            omsOrderId: event.omsOrderId,
            code: "PACKAGE_HISTORY_REPORT_FAILED",
          }),
        );
      }
    };
    await store.drain(1_000, filter);
    const claims = await store.claim(
      CONCURRENCY,
      now(),
      this.dependencies.newId(),
      filter,
    );
    await Promise.all(
      claims.map(async (claim) => {
        try {
          const scope = await source.scope(claim.omsOrderId);
          const native = await source.native(scope);
          const renew = async () => {
            if (!(await store.renew(claim, now())))
              throw new PackageHistoryError(
                "PACKAGE_HISTORY_SOURCE_CHANGED",
                "transient",
              );
          };
          await renew();
          const tracking = [
            ...new Set(
              native.fulfillments
                .filter((f) => f.status === "SUCCESS")
                .filter((f) =>
                  f.lines.some((item) =>
                    scope.lines.some(
                      (line) =>
                        line.externalLineId === item.lineItemId &&
                        line.requiresShipping &&
                        item.quantity > 0,
                    ),
                  ),
                )
                .flatMap((f) => f.tracking),
            ),
          ].sort();
          if (tracking.length > MAX_TRACKING_NUMBERS)
            throw new PackageHistoryError("PACKAGE_HISTORY_PACKAGE_LIMIT");
          const observations = new Map<
            number,
            RetainedPackageHistoryShipment
          >();
          // Sequential bounded provider reads respect its rate limit. The two
          // leased jobs run concurrently; never lease a backlog behind API I/O.
          for (const number of tracking) {
            await renew();
            for (const observation of await source.shipments(number)) {
              const id = observation.shipment.shipmentId,
                previous = observations.get(id);
              if (
                previous &&
                packageHistoryHash(previous) !== packageHistoryHash(observation)
              )
                throw new PackageHistoryError(
                  "PACKAGE_HISTORY_PROVIDER_CHANGED",
                  "transient",
                );
              observations.set(id, observation);
            }
          }
          const document = buildPackageHistory(scope, native, [
            ...observations.values(),
          ]);
          if (
            tracking.length &&
            packageHistoryNativeRevision(await source.native(scope)) !==
              packageHistoryNativeRevision(native)
          )
            throw new PackageHistoryError(
              "PACKAGE_HISTORY_NATIVE_CHANGED",
              "transient",
            );
          await renew();
          // A local line/owner change while the provider was read invalidates the
          // whole observation. The repository also compares generation/lease.
          if (
            packageHistoryHash(await source.scope(claim.omsOrderId)) !==
            packageHistoryHash(scope)
          )
            throw new PackageHistoryError(
              "PACKAGE_HISTORY_SOURCE_CHANGED",
              "transient",
            );
          const published = await store.complete(claim, document, now());
          emit({
            action: "shipping_package_history",
            outcome: published ? "published" : "superseded",
            omsOrderId: claim.omsOrderId,
          });
        } catch (cause) {
          const error =
            cause instanceof PackageHistoryError
              ? cause
              : cause instanceof z.ZodError
                ? new PackageHistoryError(
                    "PACKAGE_HISTORY_SOURCE_INVALID",
                    "review",
                  )
                : new PackageHistoryError(
                    "PACKAGE_HISTORY_CAPTURE_UNAVAILABLE",
                    "transient",
                  );
          await store.fail(claim, error.code, error.classification, now());
          emit({
            action: "shipping_package_history",
            outcome:
              error.classification === "review" || claim.attempts >= 7
                ? "review"
                : "retry",
            omsOrderId: claim.omsOrderId,
            code: error.code,
          });
        }
      }),
    );
    return claims.length;
  }
}
