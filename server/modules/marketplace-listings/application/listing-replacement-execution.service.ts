import { MarketplaceListingReplacementError } from "../domain/errors";
import type { ListingActor } from "../domain/listing-replacement-plan";
import type { CanonicalJsonValue } from "../domain/canonical-hash";
import type {
  ClaimedListingReplacementStep,
  ListingReplacementStepSuccess,
  MarketplaceListingReplacementExecutionClock,
  MarketplaceListingReplacementExecutionRepository,
  MarketplaceListingReplacementProviderResolver,
} from "./execution-ports";

export interface ExecuteListingReplacementInput {
  readonly operationId: number;
  readonly actor: ListingActor;
  readonly leaseDurationMs?: number;
}
export type ExecuteListingReplacementResult =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "completed"; stepKey: string }>
  | Readonly<{ kind: "failed"; stepKey: string }>
  | Readonly<{ kind: "manual_recovery_required"; stepKey: string }>;

export class ListingReplacementExecutionService {
  constructor(
    private readonly dependencies: {
      repository: MarketplaceListingReplacementExecutionRepository;
      providers: MarketplaceListingReplacementProviderResolver;
      clock: MarketplaceListingReplacementExecutionClock;
    },
  ) {}

  async execute(
    input: ExecuteListingReplacementInput,
  ): Promise<ExecuteListingReplacementResult> {
    assertInput(input);
    let leaseToken: string | null = null;
    for (let stepCount = 0; stepCount < 7; stepCount += 1) {
      const claim = await this.dependencies.repository.claimNextStep({
        operationId: input.operationId,
        actor: input.actor,
        now: this.dependencies.clock.now(),
        leaseDurationMs: input.leaseDurationMs ?? 300_000,
        leaseToken,
      });
      if (!claim) return { kind: "idle" };
      if (leaseToken !== null && claim.leaseToken !== leaseToken) {
        throw new MarketplaceListingReplacementError(
          "MARKETPLACE_LISTING_REPLACEMENT_LEASE_CHANGED",
          "The replacement operation lease changed during execution.",
          { operationId: input.operationId },
        );
      }
      leaseToken = claim.leaseToken;
      const terminal = await this.executeClaim(claim);
      if (terminal?.kind === "compensation_started") {
        continue;
      }
      if (terminal) return terminal;
    }
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_STEP_LIMIT_EXCEEDED",
      "Replacement execution exceeded its deterministic seven-step plan.",
      { operationId: input.operationId },
    );
  }

  private async executeClaim(
    claim: ClaimedListingReplacementStep,
  ): Promise<
    | ExecuteListingReplacementResult
    | Readonly<{ kind: "compensation_started"; stepKey: string }>
    | null
  > {
    try {
      if (claim.stepKey === "switch_mapping.activate_target") {
        await this.dependencies.repository.activateTargetAndCompleteOperation({
          claim,
          result: { evidence: { mappingActivated: true } },
          completedAt: this.dependencies.clock.now(),
        });
        return { kind: "completed", stepKey: claim.stepKey };
      }
      const provider = this.dependencies.providers.forOwner(
        claim.operation.owner,
      );
      const result = await dispatchProviderStep(claim, provider);
      if (claim.stepKey === "compensate.ensure_source_live") {
        await this.dependencies.repository.completeCompensationAndFailOperation(
          {
            claim,
            result,
            completedAt: this.dependencies.clock.now(),
          },
        );
        return { kind: "failed", stepKey: claim.stepKey };
      }
      await this.dependencies.repository.completeStep({
        claim,
        result,
        completedAt: this.dependencies.clock.now(),
      });
      return null;
    } catch (error) {
      return this.handleFailure(claim, error);
    }
  }

  private async handleFailure(
    claim: ClaimedListingReplacementStep,
    error: unknown,
  ): Promise<
    | ExecuteListingReplacementResult
    | Readonly<{ kind: "compensation_started"; stepKey: string }>
  > {
    const failure = normalizeFailure(error);
    const input = {
      claim,
      errorCode: failure.code,
      errorMessage: failure.message,
      evidence: failure.evidence,
      failedAt: this.dependencies.clock.now(),
    };
    if (claim.stepKey === "preflight.validate_plan") {
      await this.dependencies.repository.failPreflight(input);
      return { kind: "failed", stepKey: claim.stepKey };
    }
    if (claim.stepKey.startsWith("compensate.")) {
      await this.dependencies.repository.requireManualRecovery(input);
      return { kind: "manual_recovery_required", stepKey: claim.stepKey };
    }
    await this.dependencies.repository.beginCompensation(input);
    return { kind: "compensation_started", stepKey: claim.stepKey };
  }
}

async function dispatchProviderStep(
  claim: ClaimedListingReplacementStep,
  provider: ReturnType<
    MarketplaceListingReplacementProviderResolver["forOwner"]
  >,
): Promise<ListingReplacementStepSuccess> {
  const context = claim.operation;
  switch (claim.stepKey) {
    case "preflight.validate_plan":
      return provider.preflight(context, claim.idempotencyKey);
    case "cutover.quiesce_source":
      return provider.quiesceSource(context, claim.idempotencyKey);
    case "publish.create_target":
      return provider.createTarget(context, claim.idempotencyKey);
    case "verify.target_publication":
      return provider.verifyTarget(context, claim.idempotencyKey);
    case "compensate.ensure_target_not_sellable":
      return provider.ensureTargetNotSellable(context, claim.idempotencyKey);
    case "compensate.ensure_source_live":
      return provider.ensureSourceLive(context, claim.idempotencyKey);
    case "switch_mapping.activate_target":
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_EXECUTOR_INTERNAL_ERROR",
        "Mapping activation is a repository-owned step.",
      );
  }
}

function assertInput(input: ExecuteListingReplacementInput): void {
  if (
    !Number.isSafeInteger(input.operationId) ||
    input.operationId <= 0 ||
    !input.actor?.id?.trim() ||
    !["user", "service", "system"].includes(input.actor.type) ||
    (input.leaseDurationMs !== undefined &&
      (!Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs < 1_000 ||
        input.leaseDurationMs > 300_000))
  )
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_INPUT_INVALID",
      "Listing replacement execution input is invalid.",
    );
}
function normalizeFailure(error: unknown): {
  code: string;
  message: string;
  evidence: Readonly<Record<string, CanonicalJsonValue>>;
} {
  if (error instanceof MarketplaceListingReplacementError)
    return {
      code: error.code,
      message: error.message,
      evidence: { context: error.context as CanonicalJsonValue },
    };
  return {
    code: "MARKETPLACE_LISTING_REPLACEMENT_PROVIDER_FAILED",
    message:
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 2_000)
        : "Marketplace listing provider step failed.",
    evidence: {},
  };
}
