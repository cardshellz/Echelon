import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runHistoricalShipStationSplitRepair,
  type HistoricalSplitRepairFlags,
  type HistoricalSplitRepairMode,
} from "../server/modules/oms/historical-shipstation-split-repair.service";
import type { ShipStationShipment } from "../server/modules/oms/shipstation.service";

const DEFAULT_LIMIT = 25;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_RATE_LIMIT_ERRORS = 20;
const DEFAULT_PROGRESS_EVERY = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const SHIPSTATION_BASE_URL = "https://ssapi.shipstation.com";

interface ShipStationLookupCircuit {
  rateLimitResponses: number;
  stoppedEarlyReason: string | null;
}

class ShipStationLookupHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ShipStationLookupHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CliFlags extends HistoricalSplitRepairFlags {
  readonly help: boolean;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxRateLimitErrors: number;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --dry-run --limit=25",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --dry-run --limit=all --json",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --execute --limit=all --confirm-count=N --operator=EMAIL --reason=TEXT --idempotency-key=KEY",
    "",
    "Flags:",
    "  --dry-run                    Fetch, classify, and prove only. Default.",
    "  --execute                    Apply only proof-complete repairs.",
    "  --limit=N|all                Max unique provider packages. Default 25.",
    "  --provider-shipment-id=N     Restrict to one ShipStation shipment id.",
    "  --after-provider-shipment-id=N Dry-run resume cursor after this ShipStation shipment id.",
    "  --confirm-count=N            Required for execute; must equal selected package count.",
    "  --operator=IDENTITY          Required for execute audit trail.",
    "  --reason=TEXT                Required for execute audit trail.",
    "  --idempotency-key=KEY        Required for execute; deterministically identifies the run.",
    "  --concurrency=N             Concurrent ShipStation lookups. Default 2, max 4.",
    "  --delay-ms=N                 Delay between ShipStation lookups. Default 250.",
    "  --request-timeout-ms=N       Abort each provider request after N ms. Default 20000.",
    "  --max-retries=N              Retry transient provider failures N times. Default 3.",
    "  --retry-base-delay-ms=N      Exponential retry base delay. Default 2000.",
    "  --max-rate-limit-errors=N    Stop after N rate-limit responses. Default 20; 0 disables.",
    "  --progress-every=N           Emit progress every N packages. Default 10; 0 disables.",
    "  --json                       Print summary JSON to stdout; progress goes to stderr.",
    "  --help                       Show this help.",
  ].join("\n");
}

function valueFor(argv: readonly string[], prefix: string): string | null {
  const arg = argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function optionalPositiveInteger(
  value: string | null,
  flag: string,
  fallback: number | null,
  allowAll: boolean,
): number | null {
  if (value === null) return fallback;
  if (allowAll && value === "all") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer${allowAll ? " or all" : ""}`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | null, flag: string, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function boundedPositiveInteger(
  value: string | null,
  flag: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = optionalPositiveInteger(value, flag, fallback, false);
  if (parsed === null || parsed > maximum) {
    throw new Error(`${flag} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

export function parseFlags(argv: readonly string[]): CliFlags {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  if (dryRun && execute) throw new Error("Cannot pass both --dry-run and --execute");
  const known = /^(--help|-h|--dry-run|--execute|--limit=|--provider-shipment-id=|--after-provider-shipment-id=|--confirm-count=|--operator=|--reason=|--idempotency-key=|--concurrency=|--delay-ms=|--request-timeout-ms=|--max-retries=|--retry-base-delay-ms=|--max-rate-limit-errors=|--progress-every=|--json$)/;
  const unknown = argv.find((arg) => !known.test(arg));
  if (unknown) throw new Error(`Unknown flag: ${unknown}`);

  const mode: HistoricalSplitRepairMode = execute ? "execute" : "dry-run";
  const flags: CliFlags = Object.freeze({
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    limit: optionalPositiveInteger(valueFor(argv, "--limit="), "--limit", DEFAULT_LIMIT, true),
    providerShipmentId: optionalPositiveInteger(
      valueFor(argv, "--provider-shipment-id="),
      "--provider-shipment-id",
      null,
      false,
    ),
    afterProviderShipmentId: optionalPositiveInteger(
      valueFor(argv, "--after-provider-shipment-id="),
      "--after-provider-shipment-id",
      null,
      false,
    ),
    confirmCount: optionalPositiveInteger(
      valueFor(argv, "--confirm-count="),
      "--confirm-count",
      null,
      false,
    ),
    operator: valueFor(argv, "--operator="),
    reason: valueFor(argv, "--reason="),
    idempotencyKey: valueFor(argv, "--idempotency-key="),
    concurrency: boundedPositiveInteger(
      valueFor(argv, "--concurrency="),
      "--concurrency",
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
    ),
    delayMs: nonnegativeInteger(valueFor(argv, "--delay-ms="), "--delay-ms", DEFAULT_DELAY_MS),
    requestTimeoutMs: optionalPositiveInteger(
      valueFor(argv, "--request-timeout-ms="),
      "--request-timeout-ms",
      DEFAULT_REQUEST_TIMEOUT_MS,
      false,
    )!,
    maxRetries: nonnegativeInteger(valueFor(argv, "--max-retries="), "--max-retries", DEFAULT_MAX_RETRIES),
    retryBaseDelayMs: nonnegativeInteger(
      valueFor(argv, "--retry-base-delay-ms="),
      "--retry-base-delay-ms",
      DEFAULT_RETRY_BASE_DELAY_MS,
    ),
    maxRateLimitErrors: nonnegativeInteger(
      valueFor(argv, "--max-rate-limit-errors="),
      "--max-rate-limit-errors",
      DEFAULT_MAX_RATE_LIMIT_ERRORS,
    ),
    progressEvery: nonnegativeInteger(
      valueFor(argv, "--progress-every="),
      "--progress-every",
      DEFAULT_PROGRESS_EVERY,
    ),
    json: argv.includes("--json"),
  });
  if (flags.providerShipmentId !== null && flags.afterProviderShipmentId !== null) {
    throw new Error("--provider-shipment-id and --after-provider-shipment-id cannot be combined");
  }
  if (mode === "execute" && flags.afterProviderShipmentId !== null) {
    throw new Error("--after-provider-shipment-id is dry-run only; execute must select the complete unresolved cohort");
  }
  if (mode === "execute" && flags.confirmCount === null) {
    throw new Error("--confirm-count is required with --execute");
  }
  return flags;
}

function shipStationAuthHeader(): string {
  const apiKey = process.env.SHIPSTATION_API_KEY?.trim();
  const apiSecret = process.env.SHIPSTATION_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error("SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set");
  }
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

function providerLookupError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function retryAfterMilliseconds(response: Response): number | null {
  const raw = response.headers.get("x-rate-limit-reset")
    ?? response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  return null;
}

function retryDelayMilliseconds(
  attempt: number,
  baseDelayMs: number,
  providerDelayMs: number | null,
): number {
  if (providerDelayMs !== null) return Math.min(providerDelayMs, MAX_RETRY_DELAY_MS);
  return Math.min(baseDelayMs * (2 ** attempt), MAX_RETRY_DELAY_MS);
}

function isRetryableLookupError(error: unknown): boolean {
  if (error instanceof ShipStationLookupHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof Error && (
    error.name === "AbortError"
    || error.name === "TimeoutError"
    || error instanceof TypeError
  );
}

export async function fetchShipStationShipmentById(
  providerShipmentId: number,
  flags: Pick<
    CliFlags,
    | "requestTimeoutMs"
    | "maxRetries"
    | "retryBaseDelayMs"
    | "maxRateLimitErrors"
  >,
  circuit: ShipStationLookupCircuit,
  dependencies: {
    readonly fetchImpl?: typeof fetch;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly logRetry?: (message: string) => void;
  } = {},
): Promise<ShipStationShipment | null> {
  if (!Number.isSafeInteger(providerShipmentId) || providerShipmentId <= 0) {
    throw new Error("ShipStation shipment id must be a positive integer");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const logRetry = dependencies.logRetry ?? (() => undefined);
  const url = new URL("/shipments", SHIPSTATION_BASE_URL);
  url.searchParams.set("shipmentId", String(providerShipmentId));
  url.searchParams.set("includeShipmentItems", "true");

  for (let attempt = 0; attempt <= flags.maxRetries; attempt += 1) {
    if (circuit.stoppedEarlyReason !== null) {
      throw providerLookupError(
        "SHIPSTATION_RATE_LIMIT_CIRCUIT_OPEN",
        circuit.stoppedEarlyReason,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), flags.requestTimeoutMs);
    let providerDelayMs: number | null = null;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: shipStationAuthHeader(),
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      providerDelayMs = retryAfterMilliseconds(response);
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        if (response.status === 429) {
          circuit.rateLimitResponses += 1;
          if (
            flags.maxRateLimitErrors > 0
            && circuit.rateLimitResponses >= flags.maxRateLimitErrors
          ) {
            circuit.stoppedEarlyReason =
              `ShipStation rate-limit breaker opened after ${circuit.rateLimitResponses} responses`;
          }
        }
        throw new ShipStationLookupHttpError(
          response.status,
          `ShipStation GET ${url.pathname}${url.search} failed ${response.status}: ${body}`,
          providerDelayMs,
        );
      }
      const payload = await response.json() as { shipments?: unknown };
      if (!Array.isArray(payload.shipments)) {
        throw providerLookupError(
          "SHIPSTATION_RESPONSE_INVALID",
          `ShipStation shipment ${providerShipmentId} response has no shipments array`,
        );
      }
      return (payload.shipments as ShipStationShipment[]).find(
        (shipment) => shipment.shipmentId === providerShipmentId,
      ) ?? null;
    } catch (error) {
      if (circuit.stoppedEarlyReason !== null) {
        throw providerLookupError(
          "SHIPSTATION_RATE_LIMIT_CIRCUIT_OPEN",
          circuit.stoppedEarlyReason,
          error,
        );
      }
      if (!isRetryableLookupError(error) || attempt >= flags.maxRetries) {
        if (error instanceof Error && error.name === "AbortError") {
          throw providerLookupError(
            "SHIPSTATION_REQUEST_TIMEOUT",
            `ShipStation shipment ${providerShipmentId} lookup exceeded ${flags.requestTimeoutMs}ms after ${attempt + 1} attempt(s)`,
            error,
          );
        }
        throw error;
      }
      const delayMs = retryDelayMilliseconds(
        attempt,
        flags.retryBaseDelayMs,
        error instanceof ShipStationLookupHttpError ? error.retryAfterMs : providerDelayMs,
      );
      logRetry(
        `[Historical ShipStation split repair] RETRY shipment=${providerShipmentId} ` +
          `attempt=${attempt + 1}/${flags.maxRetries} waitMs=${delayMs}`,
      );
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw providerLookupError(
    "SHIPSTATION_LOOKUP_EXHAUSTED",
    `ShipStation shipment ${providerShipmentId} lookup exhausted retries`,
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(usage());
    return;
  }

  console.error(
    `[Historical ShipStation split repair] START mode=${flags.mode} ` +
      `limit=${flags.limit ?? "all"} concurrency=${flags.concurrency} ` +
      `requestTimeoutMs=${flags.requestTimeoutMs} maxRetries=${flags.maxRetries} ` +
      `progressEvery=${flags.progressEvery}`,
  );

  const [
    { db, pool },
    { createHistoricalShipStationSplitRepairRepository },
    { createDrizzleCarrierTrackingRepository },
    { CarrierTrackingService, makeCarrierTrackingLogger, systemCarrierTrackingClock },
    { createShipStationTrackingEventsClient },
  ] = await Promise.all([
    import("../server/db"),
    import("../server/modules/oms/historical-shipstation-split-repair.repository"),
    import("../server/modules/shipping/carrier-tracking.repository"),
    import("../server/modules/shipping/carrier-tracking.service"),
    import("../server/modules/shipping/shipstation-tracking-events.client"),
  ]);

  const repository = createHistoricalShipStationSplitRepairRepository(pool);
  const lookupCircuit: ShipStationLookupCircuit = {
    rateLimitResponses: 0,
    stoppedEarlyReason: null,
  };
  const carrierTracking = new CarrierTrackingService({
    repository: createDrizzleCarrierTrackingRepository(db),
    clock: systemCarrierTrackingClock,
    logger: makeCarrierTrackingLogger(),
    trackingEventsClient: createShipStationTrackingEventsClient(),
  });
  try {
    const summary = await runHistoricalShipStationSplitRepair(flags, {
      loadRetryCandidates: repository.loadRetryCandidates,
      lookupProviderShipment: async (providerShipmentId) =>
        fetchShipStationShipmentById(providerShipmentId, flags, lookupCircuit, {
          logRetry: console.error,
        }),
      providerLookupState: () => Object.freeze({ ...lookupCircuit }),
      progress: (progress) => console.error(
        `[Historical ShipStation split repair] PROGRESS ${JSON.stringify(progress)}`,
      ),
      inspectPackages: repository.inspectPackages,
      applyComponent: repository.applyComponent,
      reconcileProviderPackage: async (applied, providerPackage) => {
        await carrierTracking.observeShipStationLabel({
          shipmentId: providerPackage.providerShipmentId,
          orderId: providerPackage.providerOrderId,
          orderKey: providerPackage.providerOrderKey,
          orderNumber: providerPackage.orderNumber,
          trackingNumber: providerPackage.trackingNumber,
          carrierCode: providerPackage.carrierCode,
          serviceCode: providerPackage.serviceCode,
          shipDate: providerPackage.shippedAt.toISOString(),
          voidDate: null,
          isReturnLabel: false,
          shipmentItems: providerPackage.items.map((item) => ({
            lineItemKey: `wms-item-${item.sourceShipmentItemId}`,
            quantity: item.quantity,
          })),
        });
        const links = await carrierTracking.reconcileShipStationLabel(
          String(providerPackage.providerShipmentId),
        );
        if (links.totalLinks <= 0) {
          throw new Error(
            `Provider shipment ${providerPackage.providerShipmentId} did not link to any repaired WMS package`,
          );
        }
        const exactTargetLinkCount = await repository.proveProviderPackageLinks(applied);

        try {
          const hydration = await carrierTracking.hydrateShipStationTrackingIdentity({
            carrierCode: providerPackage.carrierCode,
            trackingNumber: providerPackage.trackingNumber,
          });
          return Object.freeze({
            providerLabelLinkCount: exactTargetLinkCount,
            dispatchEvidence: hydration.dispatchEvidence,
            dispatchCommandCreated: hydration.dispatchCommandInserted,
            trackingHydrationError: null,
          });
        } catch (error) {
          return Object.freeze({
            providerLabelLinkCount: exactTargetLinkCount,
            dispatchEvidence: null,
            dispatchCommandCreated: false,
            trackingHydrationError: error instanceof Error ? error.message : String(error),
          });
        }
      },
      finalizeMappedPackage: repository.finalizeMappedPackage,
      finalizeRepairedPackage: async (applied, packagePlan, materialized, audit) =>
        repository.finalizeRepairedPackage(
          applied,
          packagePlan,
          materialized.physicalShipmentId,
          audit,
        ),
      finalizeNonOutboundPackage: repository.finalizeNonOutboundPackage,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: () => new Date(),
      log: flags.json ? () => undefined : console.log,
    });
    console.log(JSON.stringify(summary));
    if (
      summary.failures.length > 0
      || summary.unsafe > 0
      || summary.stoppedEarlyReason !== null
    ) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (isMain) {
  main().catch((error) => {
    console.error("[Historical ShipStation split repair] fatal:", error);
    process.exit(1);
  });
}