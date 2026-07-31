import crypto from "node:crypto";

import type { ShipStationShipment } from "./shipstation.service";

export const HISTORICAL_SPLIT_REPAIR_SOURCE =
  "historical_ss_split_repair";

export type HistoricalSplitRepairMode = "dry-run" | "execute";

export interface HistoricalSplitRetryCandidate {
  readonly providerShipmentId: number;
  readonly retryIds: readonly number[];
}

export interface HistoricalSplitProviderItem {
  readonly sourceShipmentItemId: number;
  readonly quantity: number;
}

export interface HistoricalSplitProviderPackage {
  readonly providerShipmentId: number;
  readonly providerOrderId: number;
  readonly providerOrderKey: string | null;
  readonly orderNumber: string;
  readonly trackingNumber: string;
  readonly carrierCode: string;
  readonly serviceCode: string | null;
  readonly shippedAt: Date;
  readonly items: readonly HistoricalSplitProviderItem[];
}

export interface HistoricalSplitRepairPackagePlan {
  readonly providerPackage: HistoricalSplitProviderPackage;
  readonly retryIds: readonly number[];
}

export interface HistoricalSplitRepairComponent {
  readonly componentKey: string;
  readonly packages: readonly HistoricalSplitRepairPackagePlan[];
}

export interface HistoricalSplitCanonicalPackage {
  readonly packagePlan: HistoricalSplitRepairPackagePlan;
  readonly applied: HistoricalSplitAppliedPackage;
  readonly materialized: HistoricalSplitMaterializationResult;
}

export interface HistoricalSplitInspection {
  readonly alreadyCanonical: readonly HistoricalSplitCanonicalPackage[];
  readonly repairableComponents: readonly HistoricalSplitRepairComponent[];
  readonly unsafe: readonly HistoricalSplitRepairFailure[];
}

export interface HistoricalSplitAppliedPackage {
  readonly providerShipmentId: number;
  readonly legacyWmsShipmentIds: readonly number[];
  readonly wmsOrderIds: readonly number[];
}

export interface HistoricalSplitMaterializationResult {
  readonly physicalShipmentId: number;
  readonly channelCommandCount: number;
}

export interface HistoricalSplitProviderReconciliationResult {
  readonly providerLabelLinkCount: number;
  readonly dispatchEvidence: "confirmed" | "not_confirmed" | "review" | null;
  readonly dispatchCommandCreated: boolean;
  readonly trackingHydrationError: string | null;
}

export interface HistoricalSplitRepairFailure {
  readonly providerShipmentIds: readonly number[];
  readonly code: string;
  readonly message: string;
}

export interface HistoricalSplitRepairFlags {
  readonly mode: HistoricalSplitRepairMode;
  readonly limit: number | null;
  readonly providerShipmentId: number | null;
  readonly afterProviderShipmentId: number | null;
  readonly confirmCount: number | null;
  readonly operator: string | null;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly progressEvery: number;
  readonly json: boolean;
}

export interface HistoricalSplitProviderLookupState {
  readonly rateLimitResponses: number;
  readonly stoppedEarlyReason: string | null;
}

export interface HistoricalSplitRepairProgress {
  readonly runId: string;
  readonly processed: number;
  readonly total: number;
  readonly completedThroughProviderShipmentId: number | null;
  readonly loaded: number;
  readonly failed: number;
  readonly rateLimitResponses: number;
  readonly elapsedMs: number;
}

export interface HistoricalSplitRepairDependencies {
  loadRetryCandidates(
    flags: HistoricalSplitRepairFlags,
  ): Promise<readonly HistoricalSplitRetryCandidate[]>;
  lookupProviderShipment(
    providerShipmentId: number,
  ): Promise<ShipStationShipment | null>;
  inspectPackages(
    packages: readonly HistoricalSplitRepairPackagePlan[],
  ): Promise<HistoricalSplitInspection>;
  applyComponent(
    component: HistoricalSplitRepairComponent,
    audit: HistoricalSplitRepairAudit,
  ): Promise<readonly HistoricalSplitAppliedPackage[]>;
  reconcileProviderPackage(
    applied: HistoricalSplitAppliedPackage,
    providerPackage: HistoricalSplitProviderPackage,
  ): Promise<HistoricalSplitProviderReconciliationResult>;
  finalizeMappedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    reconciliation: HistoricalSplitProviderReconciliationResult,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
  finalizeRepairedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    materialized: HistoricalSplitMaterializationResult,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
  finalizeNonOutboundPackage(
    candidate: HistoricalSplitRetryCandidate,
    shipment: ShipStationShipment,
    disposition: "voided" | "return_label",
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): Date;
  providerLookupState?(): HistoricalSplitProviderLookupState;
  progress?(progress: HistoricalSplitRepairProgress): void;
  log?(message: string): void;
}

export interface HistoricalSplitRepairAudit {
  readonly runId: string;
  readonly operator: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

export interface HistoricalSplitRepairSummary {
  readonly mode: HistoricalSplitRepairMode;
  readonly runId: string;
  readonly candidates: number;
  readonly providerLookupsProcessed: number;
  readonly providerPackagesLoaded: number;
  readonly alreadyCanonical: number;
  readonly repairable: number;
  readonly reshaped: number;
  readonly repaired: number;
  readonly providerLabelsLinked: number;
  readonly dispatchConfirmed: number;
  readonly dispatchCommandsCreated: number;
  readonly trackingDeferred: number;
  readonly voided: number;
  readonly returnLabels: number;
  readonly providerMissing: number;
  readonly invalidProviderEvidence: number;
  readonly rateLimitResponses: number;
  readonly stoppedEarlyReason: string | null;
  readonly unsafe: number;
  readonly failures: readonly HistoricalSplitRepairFailure[];
}

interface HistoricalSplitProviderLookupOutcome {
  readonly candidate: HistoricalSplitRetryCandidate;
  readonly shipment: ShipStationShipment | null;
  readonly failure: HistoricalSplitRepairFailure | null;
}

function requiredText(
  value: string | null,
  field: string,
  maximum: number,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${field} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function historicalSplitRunId(idempotencyKey: string): string {
  const hash = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function parseHistoricalProviderPackage(
  shipment: ShipStationShipment,
): HistoricalSplitProviderPackage {
  const providerShipmentId = positiveInteger(shipment.shipmentId);
  const providerOrderId = positiveInteger(shipment.orderId);
  const orderNumber = String(shipment.orderNumber ?? "").trim();
  const trackingNumber = String(shipment.trackingNumber ?? "").trim();
  const carrierCode = String(shipment.carrierCode ?? "").trim();
  const shippedAt = validDate(shipment.shipDate);
  if (
    providerShipmentId === null
    || providerOrderId === null
    || !orderNumber
    || orderNumber.length > 100
    || !trackingNumber
    || trackingNumber.length > 200
    || !carrierCode
    || carrierCode.length > 100
    || shippedAt === null
  ) {
    throw Object.assign(
      new Error(
        `ShipStation shipment ${shipment.shipmentId ?? "unknown"} lacks complete outbound identity`,
      ),
      { code: "PROVIDER_PACKAGE_IDENTITY_INCOMPLETE" },
    );
  }

  const providerOrderKey = String(shipment.orderKey ?? "").trim() || null;
  if (providerOrderKey && providerOrderKey.length > 100) {
    throw Object.assign(
      new Error(`ShipStation shipment ${providerShipmentId} has an invalid order key`),
      { code: "PROVIDER_ORDER_KEY_INVALID" },
    );
  }

  const quantities = new Map<number, number>();
  const shipmentItems = Array.isArray(shipment.shipmentItems)
    ? shipment.shipmentItems
    : [];
  if (shipmentItems.length === 0) {
    throw Object.assign(
      new Error(`ShipStation shipment ${providerShipmentId} has no shipment items`),
      { code: "PROVIDER_PACKAGE_ITEMS_MISSING" },
    );
  }

  for (const item of shipmentItems) {
    const match = typeof item.lineItemKey === "string"
      ? /^wms-item-([1-9][0-9]*)$/.exec(item.lineItemKey.trim())
      : null;
    const sourceShipmentItemId = match ? positiveInteger(match[1]) : null;
    const quantity = positiveInteger(item.quantity);
    if (sourceShipmentItemId === null || quantity === null) {
      throw Object.assign(
        new Error(
          `ShipStation shipment ${providerShipmentId} contains an item without an exact positive wms-item identity and quantity`,
        ),
        { code: "PROVIDER_PACKAGE_ITEM_IDENTITY_INCOMPLETE" },
      );
    }
    quantities.set(
      sourceShipmentItemId,
      (quantities.get(sourceShipmentItemId) ?? 0) + quantity,
    );
  }

  return Object.freeze({
    providerShipmentId,
    providerOrderId,
    providerOrderKey,
    orderNumber,
    trackingNumber,
    carrierCode,
    serviceCode: String(shipment.serviceCode ?? "").trim() || null,
    shippedAt,
    items: Object.freeze(
      [...quantities.entries()]
        .sort(([left], [right]) => left - right)
        .map(([sourceShipmentItemId, quantity]) =>
          Object.freeze({ sourceShipmentItemId, quantity })
        ),
    ),
  });
}

export function buildHistoricalSplitRepairComponents(
  packages: readonly HistoricalSplitRepairPackagePlan[],
  sourceShipmentIdByItem: ReadonlyMap<number, number> = new Map(),
): readonly HistoricalSplitRepairComponent[] {
  const packageById = new Map(
    packages.map((candidate) => [
      candidate.providerPackage.providerShipmentId,
      candidate,
    ]),
  );
  const packageIdsBySourceItem = new Map<number, Set<number>>();
  const packageIdsBySourceShipment = new Map<number, Set<number>>();
  for (const candidate of packages) {
    for (const item of candidate.providerPackage.items) {
      if (!packageIdsBySourceItem.has(item.sourceShipmentItemId)) {
        packageIdsBySourceItem.set(item.sourceShipmentItemId, new Set());
      }
      packageIdsBySourceItem
        .get(item.sourceShipmentItemId)!
        .add(candidate.providerPackage.providerShipmentId);
      const sourceShipmentId = sourceShipmentIdByItem.get(item.sourceShipmentItemId);
      if (sourceShipmentId !== undefined) {
        if (!packageIdsBySourceShipment.has(sourceShipmentId)) {
          packageIdsBySourceShipment.set(sourceShipmentId, new Set());
        }
        packageIdsBySourceShipment
          .get(sourceShipmentId)!
          .add(candidate.providerPackage.providerShipmentId);
      }
    }
  }

  const visited = new Set<number>();
  const components: HistoricalSplitRepairComponent[] = [];
  const sortedPackageIds = [...packageById.keys()].sort((left, right) => left - right);
  for (const rootId of sortedPackageIds) {
    if (visited.has(rootId)) continue;
    const queue = [rootId];
    const componentPackageIds = new Set<number>();
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      componentPackageIds.add(currentId);
      const current = packageById.get(currentId);
      if (!current) continue;
      for (const item of current.providerPackage.items) {
        for (const linkedId of packageIdsBySourceItem.get(item.sourceShipmentItemId) ?? []) {
          if (!visited.has(linkedId)) queue.push(linkedId);
        }
        const sourceShipmentId = sourceShipmentIdByItem.get(item.sourceShipmentItemId);
        if (sourceShipmentId !== undefined) {
          for (const linkedId of packageIdsBySourceShipment.get(sourceShipmentId) ?? []) {
            if (!visited.has(linkedId)) queue.push(linkedId);
          }
        }
      }
    }
    const componentPackages = [...componentPackageIds]
      .sort((left, right) => left - right)
      .map((id) => packageById.get(id)!)
      .filter(Boolean);
    components.push(Object.freeze({
      componentKey: componentPackages
        .map((candidate) => candidate.providerPackage.providerShipmentId)
        .join(","),
      packages: Object.freeze(componentPackages),
    }));
  }
  return Object.freeze(components);
}

function failure(
  providerShipmentIds: readonly number[],
  code: string,
  error: unknown,
): HistoricalSplitRepairFailure {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    providerShipmentIds: Object.freeze([...providerShipmentIds]),
    code:
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : code,
    message,
  });
}

export async function runHistoricalShipStationSplitRepair(
  flags: HistoricalSplitRepairFlags,
  dependencies: HistoricalSplitRepairDependencies,
): Promise<HistoricalSplitRepairSummary> {
  const log = dependencies.log ?? console.log;
  const candidates = await dependencies.loadRetryCandidates(flags);
  if (flags.mode === "execute" && flags.confirmCount !== candidates.length) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected dry-run count ${candidates.length}`,
    );
  }

  const runId = flags.idempotencyKey
    ? historicalSplitRunId(flags.idempotencyKey)
    : crypto.randomUUID();
  const audit: HistoricalSplitRepairAudit | null = flags.mode === "execute"
    ? Object.freeze({
        runId,
        operator: requiredText(flags.operator, "--operator", 120),
        reason: requiredText(flags.reason, "--reason", 500),
        idempotencyKey: requiredText(
          flags.idempotencyKey,
          "--idempotency-key",
          500,
        ),
        occurredAt: dependencies.now(),
      })
    : null;

  const activePackages: HistoricalSplitRepairPackagePlan[] = [];
  const failures: HistoricalSplitRepairFailure[] = [];
  const lookupOutcomes = new Array<HistoricalSplitProviderLookupOutcome | undefined>(
    candidates.length,
  );
  const lookupStartedAt = dependencies.now().getTime();
  let nextLookupIndex = 0;
  let completedThroughIndex = -1;
  let providerLookupsProcessed = 0;
  let providerPackagesLoaded = 0;
  let providerLookupFailures = 0;
  let voided = 0;
  let returnLabels = 0;
  let providerMissing = 0;
  let invalidProviderEvidence = 0;

  if (!flags.json) {
    log(
      `[Historical ShipStation split repair] mode=${flags.mode} ` +
        `candidates=${candidates.length} limit=${flags.limit ?? "all"} ` +
        `concurrency=${flags.concurrency} progressEvery=${flags.progressEvery}`,
    );
  }

  const lookupState = (): HistoricalSplitProviderLookupState =>
    dependencies.providerLookupState?.() ?? Object.freeze({
      rateLimitResponses: 0,
      stoppedEarlyReason: null,
    });
  const shouldPrintProgress = (processed: number): boolean =>
    flags.progressEvery > 0 && (
      processed % flags.progressEvery === 0
      || processed === candidates.length
      || lookupState().stoppedEarlyReason !== null
    );
  const worker = async (): Promise<void> => {
    while (true) {
      if (lookupState().stoppedEarlyReason !== null) return;
      const index = nextLookupIndex;
      nextLookupIndex += 1;
      if (index >= candidates.length) return;

      const candidate = candidates[index];
      let shipment: ShipStationShipment | null = null;
      let lookupFailure: HistoricalSplitRepairFailure | null = null;
      try {
        shipment = await dependencies.lookupProviderShipment(
          candidate.providerShipmentId,
        );
      } catch (error) {
        lookupFailure = failure(
          [candidate.providerShipmentId],
          "PROVIDER_LOOKUP_FAILED",
          error,
        );
      }
      lookupOutcomes[index] = Object.freeze({
        candidate,
        shipment,
        failure: lookupFailure,
      });
      providerLookupsProcessed += 1;
      while (lookupOutcomes[completedThroughIndex + 1] !== undefined) {
        completedThroughIndex += 1;
      }
      if (shipment) providerPackagesLoaded += 1;
      if (lookupFailure) providerLookupFailures += 1;

      if (dependencies.progress && shouldPrintProgress(providerLookupsProcessed)) {
        const state = lookupState();
        dependencies.progress(Object.freeze({
          runId,
          processed: providerLookupsProcessed,
          total: candidates.length,
          completedThroughProviderShipmentId:
            candidates[completedThroughIndex]?.providerShipmentId ?? null,
          loaded: providerPackagesLoaded,
          failed: providerLookupFailures,
          rateLimitResponses: state.rateLimitResponses,
          elapsedMs: Math.max(0, dependencies.now().getTime() - lookupStartedAt),
        }));
      }
      if (lookupState().stoppedEarlyReason !== null) return;
      if (flags.delayMs > 0 && providerLookupsProcessed < candidates.length) {
        await dependencies.sleep(flags.delayMs);
      }
    }
  };

  const workerCount = Math.min(flags.concurrency, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const providerLookupState = lookupState();
  const mutationAllowed = audit !== null
    && providerLookupState.stoppedEarlyReason === null
    && providerLookupsProcessed === candidates.length;

  for (const outcome of lookupOutcomes) {
    if (!outcome) continue;
    const { candidate, shipment, failure: lookupFailure } = outcome;
    if (lookupFailure) {
      failures.push(lookupFailure);
      continue;
    }
    if (!shipment) {
      providerMissing += 1;
      failures.push(failure(
        [candidate.providerShipmentId],
        "PROVIDER_PACKAGE_NOT_FOUND",
        new Error(
          `ShipStation shipment ${candidate.providerShipmentId} was not found`,
        ),
      ));
      continue;
    }

    const disposition = shipment.isReturnLabel === true
      ? "return_label"
      : shipment.voidDate
        ? "voided"
        : null;
    if (disposition) {
      if (disposition === "voided") voided += 1;
      else returnLabels += 1;
      if (mutationAllowed && audit) {
        try {
          await dependencies.finalizeNonOutboundPackage(
            candidate,
            shipment,
            disposition,
            audit,
          );
        } catch (error) {
          failures.push(failure(
            [candidate.providerShipmentId],
            "NON_OUTBOUND_FINALIZATION_FAILED",
            error,
          ));
        }
      }
    } else {
      try {
        const providerPackage = parseHistoricalProviderPackage(shipment);
        activePackages.push(Object.freeze({
          providerPackage,
          retryIds: candidate.retryIds,
        }));
      } catch (error) {
        invalidProviderEvidence += 1;
        failures.push(failure(
          [candidate.providerShipmentId],
          "PROVIDER_PACKAGE_INVALID",
          error,
        ));
      }
    }
  }

  let inspection: HistoricalSplitInspection = Object.freeze({
    alreadyCanonical: Object.freeze([]),
    repairableComponents: Object.freeze([]),
    unsafe: Object.freeze([]),
  });
  if (activePackages.length > 0) {
    inspection = await dependencies.inspectPackages(activePackages);
    failures.push(...inspection.unsafe);
  }

  let repaired = 0;
  let reshaped = 0;
  let providerLabelsLinked = 0;
  let dispatchConfirmed = 0;
  let dispatchCommandsCreated = 0;
  let trackingDeferred = 0;
  if (mutationAllowed && audit) {
    for (const canonical of inspection.alreadyCanonical) {
      try {
        await dependencies.finalizeRepairedPackage(
          canonical.applied,
          canonical.packagePlan,
          canonical.materialized,
          audit,
        );
      } catch (error) {
        failures.push(failure(
          [canonical.packagePlan.providerPackage.providerShipmentId],
          "CANONICAL_RETRY_FINALIZATION_FAILED",
          error,
        ));
      }
    }

    for (const component of inspection.repairableComponents) {
      let appliedPackages: readonly HistoricalSplitAppliedPackage[];
      try {
        appliedPackages = await dependencies.applyComponent(component, audit);
        reshaped += appliedPackages.length;
      } catch (error) {
        failures.push(failure(
          component.packages.map(
            (candidate) => candidate.providerPackage.providerShipmentId,
          ),
          "HISTORICAL_SPLIT_RESHAPE_FAILED",
          error,
        ));
        continue;
      }

      const packagePlans = new Map(
        component.packages.map((candidate) => [
          candidate.providerPackage.providerShipmentId,
          candidate,
        ]),
      );
      for (const applied of appliedPackages) {
        const packagePlan = packagePlans.get(applied.providerShipmentId);
        if (!packagePlan) {
          failures.push(failure(
            [applied.providerShipmentId],
            "APPLIED_PACKAGE_PLAN_MISSING",
            new Error(
              `Applied package ${applied.providerShipmentId} was not in component ${component.componentKey}`,
            ),
          ));
          continue;
        }
        try {
          const reconciliation = await dependencies.reconcileProviderPackage(
            applied,
            packagePlan.providerPackage,
          );
          if (reconciliation.providerLabelLinkCount <= 0) {
            throw Object.assign(
              new Error(`Provider shipment ${applied.providerShipmentId} did not link to a repaired WMS package`),
              { code: "PROVIDER_LABEL_LINKAGE_NOT_PROVEN" },
            );
          }
          providerLabelsLinked += 1;
          if (reconciliation.dispatchEvidence === "confirmed") dispatchConfirmed += 1;
          if (reconciliation.dispatchCommandCreated) dispatchCommandsCreated += 1;
          if (reconciliation.trackingHydrationError !== null) trackingDeferred += 1;
          await dependencies.finalizeMappedPackage(
            applied,
            packagePlan,
            reconciliation,
            audit,
          );
          repaired += 1;
        } catch (error) {
          failures.push(failure(
            [applied.providerShipmentId],
            "HISTORICAL_SPLIT_PROVIDER_RECONCILIATION_FAILED",
            error,
          ));
        }
      }
    }
  }

  const repairable = inspection.repairableComponents.reduce(
    (count, component) => count + component.packages.length,
    0,
  );
  return Object.freeze({
    mode: flags.mode,
    runId,
    candidates: candidates.length,
    providerLookupsProcessed,
    providerPackagesLoaded,
    alreadyCanonical: inspection.alreadyCanonical.length,
    repairable,
    reshaped,
    repaired,
    providerLabelsLinked,
    dispatchConfirmed,
    dispatchCommandsCreated,
    trackingDeferred,
    voided,
    returnLabels,
    providerMissing,
    invalidProviderEvidence,
    rateLimitResponses: providerLookupState.rateLimitResponses,
    stoppedEarlyReason: providerLookupState.stoppedEarlyReason,
    unsafe: inspection.unsafe.length,
    failures: Object.freeze(failures),
  });
}
