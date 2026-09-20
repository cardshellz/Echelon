import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { pool } from "../db";
import { createHistoricalShipStationContentsClient } from
  "../modules/shipping/historical-shipstation-contents-audit.client";
import { PgHistoricalShipStationContentsReviewRepository } from
  "../modules/shipping/historical-shipstation-contents-review.repository";
import { HistoricalShipStationContentsReviewService } from
  "../modules/shipping/historical-shipstation-contents-review.service";
import { classifyReviewedShipStationContents } from
  "../modules/shipping/historical-shipstation-contents-review.service";

interface Options {
  readonly shippingProviderLabelId: string;
  readonly intake: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let shippingProviderLabelId: string | null = null;
  let intake = false;
  for (const argument of argv) {
    if (argument.startsWith("--label-id=")) {
      if (shippingProviderLabelId !== null) throw new Error("--label-id was supplied twice");
      shippingProviderLabelId = argument.slice("--label-id=".length);
    } else if (argument === "--intake") {
      if (intake) throw new Error("--intake was supplied twice");
      intake = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!shippingProviderLabelId || !/^[1-9][0-9]*$/.test(shippingProviderLabelId)
    || BigInt(shippingProviderLabelId) > BigInt("9223372036854775807")) {
    throw new Error("--label-id must be a positive PostgreSQL bigint");
  }
  return { shippingProviderLabelId, intake };
}

export async function runCurrentShipStationContentsReviewJob(options: Options) {
  const repository = new PgHistoricalShipStationContentsReviewRepository(pool);
  const provider = createHistoricalShipStationContentsClient();
  const candidate = await repository.loadCandidate(options.shippingProviderLabelId);
  if (candidate === null || candidate.expectedContents.kind !== "available") {
    throw new Error("The label has no single reviewable WMS package");
  }
  const observed = classifyReviewedShipStationContents(await provider.loadShipmentContents(
    candidate.providerShipmentId, candidate.expectedContents,
  ), candidate.expectedContents);
  if (observed.kind === "not_found") throw new Error("The ShipStation shipment no longer exists");
  if (observed.evidence.recoveryStatus !== "provider_wms_conflict") {
    throw new Error(`Expected a provider/WMS conflict; observed ${observed.evidence.recoveryStatus}`);
  }
  const report = {
    shippingProviderLabelId: candidate.shippingProviderLabelId,
    orderNumbers: candidate.wmsOrders.map((order) => order.orderNumber),
    trackingNumber: candidate.trackingNumber,
    providerContents: observed.providerObservation.lines,
    wmsContents: candidate.expectedContents.lines.map((line) => ({
      sku: line.sku, quantity: line.quantity,
    })),
    providerObservationHash: observed.providerObservation.evidenceHash,
    action: options.intake ? "review_created" : "dry_run_only",
    ...(options.intake ? {
      review: await new HistoricalShipStationContentsReviewService(repository, provider).intake({
        shippingProviderLabelId: candidate.shippingProviderLabelId,
        reason: "provider_wms_conflict",
        expectedEvidenceHash: observed.providerObservation.evidenceHash,
      }),
    } : {}),
  };
  return Object.freeze(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      console.log(JSON.stringify(await runCurrentShipStationContentsReviewJob(
        parseOptions(process.argv.slice(2)),
      )));
    } catch (error) {
      console.error(JSON.stringify({
        code: "CURRENT_SHIPSTATION_CONTENTS_REVIEW_FAILED",
        message: error instanceof Error ? error.message : "Unknown failure",
      }));
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
