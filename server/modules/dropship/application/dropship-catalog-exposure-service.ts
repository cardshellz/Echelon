import { createHash } from "crypto";
import {
  assertDropshipCatalogExposureRuleTarget,
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "../domain/catalog-exposure";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import {
  listDropshipCatalogExposureRulesInputSchema,
  previewDropshipCatalogExposureInputSchema,
  replaceDropshipCatalogExposureRulesInputSchema,
  type ListDropshipCatalogExposureRulesInput,
  type PreviewDropshipCatalogExposureInput,
  type ReplaceDropshipCatalogExposureRule,
  type ReplaceDropshipCatalogExposureRulesInput,
} from "./dropship-catalog-dtos";

export interface DropshipCatalogExposureRuleRecord extends DropshipCatalogExposureRule {
  id: number;
  revisionId: number | null;
  priority: number;
  isActive: boolean;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipCatalogPreviewCandidate extends DropshipCatalogVariantCandidate {
  productSku: string | null;
  productName: string;
  variantSku: string | null;
  variantName: string;
  productLineNames: string[];
}

export interface DropshipCatalogExposurePreviewRow extends DropshipCatalogPreviewCandidate {
  decision: DropshipCatalogExposureDecision;
}

export interface ReplaceDropshipCatalogExposureRulesRepositoryInput {
  idempotencyKey: string;
  requestHash: string;
  actor: ReplaceDropshipCatalogExposureRulesInput["actor"];
  rules: NormalizedDropshipCatalogExposureRule[];
  now: Date;
}

export interface ReplaceDropshipCatalogExposureRulesRepositoryResult {
  revisionId: number;
  idempotentReplay: boolean;
  rules: DropshipCatalogExposureRuleRecord[];
}

export interface DropshipCatalogExposureRepository {
  listRules(input: ListDropshipCatalogExposureRulesInput): Promise<DropshipCatalogExposureRuleRecord[]>;
  replaceRules(
    input: ReplaceDropshipCatalogExposureRulesRepositoryInput,
  ): Promise<ReplaceDropshipCatalogExposureRulesRepositoryResult>;
  listPreviewCandidates(input: PreviewDropshipCatalogExposureInput): Promise<DropshipCatalogPreviewCandidate[]>;
}

export interface DropshipCatalogExposureServiceDependencies {
  clock: DropshipClock;
  logger: DropshipLogger;
  repository: DropshipCatalogExposureRepository;
}

export interface NormalizedDropshipCatalogExposureRule extends ReplaceDropshipCatalogExposureRule {
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  notes: string | null;
  metadata: Record<string, unknown>;
}

export class DropshipCatalogExposureService {
  constructor(private readonly deps: DropshipCatalogExposureServiceDependencies) {}

  async listRules(input: unknown = {}): Promise<{ rules: DropshipCatalogExposureRuleRecord[] }> {
    const parsed = listDropshipCatalogExposureRulesInputSchema.parse(input);
    const rules = await this.deps.repository.listRules(parsed);
    return { rules };
  }

  async replaceRules(input: unknown): Promise<ReplaceDropshipCatalogExposureRulesRepositoryResult> {
    const parsed = replaceDropshipCatalogExposureRulesInputSchema.parse(input);
    const normalizedRules = parsed.rules.map(normalizeCatalogExposureRule);
    for (const rule of normalizedRules) {
      assertDropshipCatalogExposureRuleTarget(rule);
    }

    const requestHash = hashCatalogExposureRules(normalizedRules);
    const result = await this.deps.repository.replaceRules({
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      actor: parsed.actor,
      rules: normalizedRules,
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_CATALOG_RULESET_REPLAYED"
        : "DROPSHIP_CATALOG_RULESET_REPLACED",
      message: result.idempotentReplay
        ? "Dropship catalog exposure ruleset replayed by idempotency key."
        : "Dropship catalog exposure ruleset replaced.",
      context: {
        revisionId: result.revisionId,
        ruleCount: result.rules.length,
      },
    });

    return result;
  }

  async preview(input: unknown): Promise<{
    rows: DropshipCatalogExposurePreviewRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    const parsed = previewDropshipCatalogExposureInputSchema.parse(input);
    const [rules, candidates] = await Promise.all([
      this.deps.repository.listRules({ includeInactive: false }),
      this.deps.repository.listPreviewCandidates(parsed),
    ]);
    const now = this.deps.clock.now();
    const evaluatedRows = candidates.map((candidate) => ({
      ...candidate,
      decision: evaluateDropshipCatalogExposure(candidate, rules, now),
    }));
    const filteredRows = parsed.exposedOnly
      ? evaluatedRows.filter((row) => row.decision.exposed)
      : evaluatedRows;
    const start = (parsed.page - 1) * parsed.limit;

    return {
      rows: filteredRows.slice(start, start + parsed.limit),
      total: filteredRows.length,
      page: parsed.page,
      limit: parsed.limit,
    };
  }
}

export function hashCatalogExposureRules(
  rules: readonly NormalizedDropshipCatalogExposureRule[],
): string {
  const canonicalRules = [...rules]
    .map((rule) => ({
      scopeType: rule.scopeType,
      action: rule.action,
      productLineId: rule.productLineId,
      productId: rule.productId,
      productVariantId: rule.productVariantId,
      category: rule.category,
      priority: rule.priority,
      startsAt: rule.startsAt?.toISOString() ?? null,
      endsAt: rule.endsAt?.toISOString() ?? null,
      notes: rule.notes,
      metadata: sortJsonValue(rule.metadata),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return createHash("sha256").update(JSON.stringify(canonicalRules)).digest("hex");
}

export function normalizeCatalogExposureRule(
  rule: ReplaceDropshipCatalogExposureRule,
): NormalizedDropshipCatalogExposureRule {
  return {
    ...rule,
    productLineId: rule.productLineId ?? null,
    productId: rule.productId ?? null,
    productVariantId: rule.productVariantId ?? null,
    category: rule.category?.trim() || null,
    startsAt: rule.startsAt ?? null,
    endsAt: rule.endsAt ?? null,
    notes: rule.notes?.trim() || null,
    metadata: rule.metadata ?? {},
  };
}

export function makeDropshipCatalogExposureLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipCatalogExposureEvent("info", event),
    warn: (event) => logDropshipCatalogExposureEvent("warn", event),
    error: (event) => logDropshipCatalogExposureEvent("error", event),
  };
}

export const systemDropshipCatalogExposureClock: DropshipClock = {
  now: () => new Date(),
};

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }

  return value;
}

function logDropshipCatalogExposureEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
