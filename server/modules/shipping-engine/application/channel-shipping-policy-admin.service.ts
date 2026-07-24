import {
  SHIPPING_CHANNEL_ELIGIBILITY_MODES,
  SHIPPING_CHANNEL_POLICY_PURPOSES,
  SHIPPING_CHANNEL_ROUTE_MODES,
  type ShippingChannelEligibilityMode,
  type ShippingChannelAdapterCapabilities,
  type ShippingChannelPolicyPurpose,
  type ShippingChannelPolicyResolutionView,
  type ShippingChannelPolicyRouteInput,
  type ShippingChannelPolicyShadowComparison,
  type ShippingChannelPolicyView,
  type ShippingChannelRouteMode,
  type ShippingChannelRoutingChannelSummary,
  type ShippingChannelRoutingOverview,
  type ShippingDestinationScopeMember,
  type ShippingDestinationScopeSummary,
  type ShippingLegacyProfileKey,
} from "@shared/types/shipping-channel-routing";
import type { AuditLogPayload } from "../../../infrastructure/auditLogger";
import type {
  ChannelShippingCapabilityResolver,
} from "../../channels/channel-shipping-capability.registry";
import { buildLegacyChannelShippingFallback } from "./legacy-channel-shipping-fallback";
import {
  resolveChannelShippingPolicyCandidate,
  validateChannelShippingPolicyForActivation,
  type ChannelShippingDecision,
  type ChannelShippingPolicyCandidate,
  type ChannelShippingPolicyResolutionInput,
} from "../domain/channel-shipping-policy";
import type { ShippingRateContext } from "../domain/shipping-channel";

export interface CreateDestinationScopeInput {
  code: string;
  name: string;
  members: ShippingDestinationScopeMember[];
}

export interface UpdateDestinationScopeInput extends CreateDestinationScopeInput {
  scopeId: number;
  expectedLockVersion: number;
}

export interface CreatePolicyDraftInput {
  channelId: number;
  purpose: ShippingChannelPolicyPurpose;
  cloneActive: boolean;
  notes: string | null;
}

export interface SavePolicyDraftInput {
  policyId: number;
  expectedLockVersion: number;
  notes: string | null;
  routes: ShippingChannelPolicyRouteInput[];
}

export interface PolicyLifecycleInput {
  policyId: number;
  expectedLockVersion: number;
}

export interface PolicyResolutionPreviewInput {
  policyId: number;
  originWarehouseId: number;
  destination: {
    country: string;
    region: string | null;
    postalCode: string | null;
  };
}

export interface PolicyShadowComparisonInput extends PolicyResolutionPreviewInput {
  legacyProfile: ShippingLegacyProfileKey;
  actor: string;
}

interface ChannelRecord {
  id: number;
  name: string;
  provider: string;
}

interface RateBookReference {
  id: number;
  name: string;
  status: string;
  activeRateTableCount: number;
}

interface WarehouseReference {
  id: number;
  name: string;
  isActive: boolean;
}

export interface PreparedPolicyRoute {
  originWarehouseId: number | null;
  destinationScopeId: number | null;
  destinationMembers: ShippingDestinationScopeMember[];
  mode: ShippingChannelRouteMode;
  eligibilityMode: ShippingChannelEligibilityMode;
  rateBookId: number | null;
}

export interface ChannelShippingPolicyAdminTransaction {
  getChannelForUpdate(channelId: number): Promise<ChannelRecord | null>;
  getPolicyForUpdate(policyId: number): Promise<ShippingChannelPolicyView | null>;
  findDraftPolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ShippingChannelPolicyView | null>;
  findActivePolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ShippingChannelPolicyView | null>;
  nextPolicyVersion(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<number>;
  insertPolicyDraft(input: {
    channelId: number;
    purpose: ShippingChannelPolicyPurpose;
    version: number;
    notes: string | null;
    actor: string;
    now: Date;
  }): Promise<number>;
  replacePolicyRoutes(
    policyId: number,
    routes: readonly PreparedPolicyRoute[],
    now: Date,
  ): Promise<void>;
  updatePolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    notes: string | null;
    now: Date;
  }): Promise<boolean>;
  activatePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    actor: string;
    now: Date;
  }): Promise<boolean>;
  discardPolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean>;
  retirePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean>;
  getDestinationScopesByIds(
    ids: readonly number[],
  ): Promise<ShippingDestinationScopeSummary[]>;
  getRateBooksByIds(ids: readonly number[]): Promise<RateBookReference[]>;
  getWarehousesByIds(ids: readonly number[]): Promise<WarehouseReference[]>;
  insertDestinationScope(input: {
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    actor: string;
    now: Date;
  }): Promise<number>;
  getDestinationScopeForUpdate(
    scopeId: number,
  ): Promise<ShippingDestinationScopeSummary | null>;
  updateDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    now: Date;
  }): Promise<boolean>;
  retireDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    now: Date;
  }): Promise<boolean>;
  persistAudit(payload: AuditLogPayload, now: Date): Promise<void>;
}

export interface ChannelShippingPolicyAdminStore {
  listOverview(): Promise<ChannelShippingPolicyStoreOverview>;
  getChannel(channelId: number): Promise<ChannelRecord | null>;
  getPolicy(policyId: number): Promise<ShippingChannelPolicyView | null>;
  transaction<T>(
    work: (tx: ChannelShippingPolicyAdminTransaction) => Promise<T>,
  ): Promise<T>;
  resolveLegacyRateBook(
    context: ShippingRateContext,
    originWarehouseId: number,
  ): Promise<
    | { ok: true; rateBookId: number }
    | { ok: false; code: string; message: string }
  >;
  persistShadowComparison(input: {
    actor: string;
    policy: ShippingChannelPolicyView;
    resolutionInput: ChannelShippingPolicyResolutionInput;
    legacyProfile: ShippingLegacyProfileKey;
    canonical: ShippingChannelPolicyResolutionView;
    legacy: ShippingChannelPolicyResolutionView;
    matchesLegacy: boolean;
    differences: string[];
    now: Date;
  }): Promise<number>;
}

export type ChannelShippingPolicyStoreOverview =
  Omit<ShippingChannelRoutingOverview, "channels"> & {
    channels: Array<
      Omit<ShippingChannelRoutingChannelSummary, "shippingCapabilities">
    >;
  };

export interface ChannelShippingPolicyAdminClock {
  now(): Date;
}

const systemClock: ChannelShippingPolicyAdminClock = {
  now: () => new Date(),
};

export class ChannelShippingPolicyAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ChannelShippingPolicyAdminError";
  }
}

export class ChannelShippingPolicyAdminService {
  constructor(
    private readonly store: ChannelShippingPolicyAdminStore,
    private readonly capabilityResolver: ChannelShippingCapabilityResolver,
    private readonly clock: ChannelShippingPolicyAdminClock = systemClock,
  ) {}

  async listOverview(): Promise<ShippingChannelRoutingOverview> {
    const overview = await this.store.listOverview();
    return {
      ...overview,
      channels: overview.channels.map((channel) => ({
        ...channel,
        shippingCapabilities:
          this.capabilityResolver.resolve(channel.provider),
      })),
    };
  }

  async getPolicy(policyId: number): Promise<ShippingChannelPolicyView> {
    const policy = await this.store.getPolicy(requirePositiveId(policyId, "policyId"));
    if (!policy) throw policyNotFound();
    const channel = await this.store.getChannel(policy.channelId);
    if (!channel) {
      throw internalError("The policy's channel could not be loaded.");
    }
    return this.withActivationErrors(policy, channel);
  }

  async createDestinationScope(
    input: CreateDestinationScopeInput,
    actorInput: string,
  ): Promise<ShippingDestinationScopeSummary> {
    const actor = requireActor(actorInput);
    const normalized = normalizeDestinationScopeInput(input);
    const now = this.clock.now();
    return this.store.transaction(async (tx) => {
      const scopeId = await tx.insertDestinationScope({
        ...normalized,
        actor,
        now,
      });
      const created = await tx.getDestinationScopeForUpdate(scopeId);
      if (!created) {
        throw internalError("Created destination scope could not be reloaded.");
      }
      await tx.persistAudit({
        actor,
        action: "shipping.destination_scope.created",
        target: `shipping.destination_scope:${scopeId}`,
        changes: { before: null, after: auditScope(created) },
      }, now);
      return created;
    });
  }

  async updateDestinationScope(
    input: UpdateDestinationScopeInput,
    actorInput: string,
  ): Promise<ShippingDestinationScopeSummary> {
    const actor = requireActor(actorInput);
    const scopeId = requirePositiveId(input.scopeId, "scopeId");
    const expectedLockVersion = requirePositiveId(
      input.expectedLockVersion,
      "expectedLockVersion",
    );
    const normalized = normalizeDestinationScopeInput(input);
    const now = this.clock.now();

    return this.store.transaction(async (tx) => {
      const before = await tx.getDestinationScopeForUpdate(scopeId);
      if (!before) throw scopeNotFound();
      if (before.status === "retired") {
        throw conflict(
          "SHIPPING_DESTINATION_SCOPE_RETIRED",
          "A retired destination group cannot be edited.",
        );
      }
      assertExpectedVersion(before.lockVersion, expectedLockVersion);
      const updated = await tx.updateDestinationScope({
        scopeId,
        expectedLockVersion,
        ...normalized,
        now,
      });
      if (!updated) throw concurrencyConflict();
      const after = await tx.getDestinationScopeForUpdate(scopeId);
      if (!after) throw internalError("Updated destination scope could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.destination_scope.updated",
        target: `shipping.destination_scope:${scopeId}`,
        changes: { before: auditScope(before), after: auditScope(after) },
      }, now);
      return after;
    });
  }

  async retireDestinationScope(
    scopeIdInput: number,
    expectedLockVersionInput: number,
    actorInput: string,
  ): Promise<ShippingDestinationScopeSummary> {
    const actor = requireActor(actorInput);
    const scopeId = requirePositiveId(scopeIdInput, "scopeId");
    const expectedLockVersion = requirePositiveId(
      expectedLockVersionInput,
      "expectedLockVersion",
    );
    const now = this.clock.now();
    return this.store.transaction(async (tx) => {
      const before = await tx.getDestinationScopeForUpdate(scopeId);
      if (!before) throw scopeNotFound();
      if (before.status === "retired") {
        throw conflict(
          "SHIPPING_DESTINATION_SCOPE_RETIRED",
          "This destination group is already retired.",
        );
      }
      assertExpectedVersion(before.lockVersion, expectedLockVersion);
      if (!await tx.retireDestinationScope({ scopeId, expectedLockVersion, now })) {
        throw concurrencyConflict();
      }
      const after = await tx.getDestinationScopeForUpdate(scopeId);
      if (!after) throw internalError("Retired destination scope could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.destination_scope.retired",
        target: `shipping.destination_scope:${scopeId}`,
        changes: { before: auditScope(before), after: auditScope(after) },
      }, now);
      return after;
    });
  }

  async createPolicyDraft(
    input: CreatePolicyDraftInput,
    actorInput: string,
  ): Promise<ShippingChannelPolicyView> {
    const actor = requireActor(actorInput);
    const channelId = requirePositiveId(input.channelId, "channelId");
    const purpose = requirePurpose(input.purpose);
    const notes = normalizeNotes(input.notes);
    const now = this.clock.now();

    return this.store.transaction(async (tx) => {
      const channel = await tx.getChannelForUpdate(channelId);
      if (!channel) {
        throw new ChannelShippingPolicyAdminError(
          404,
          "SHIPPING_CHANNEL_NOT_FOUND",
          "Channel not found.",
        );
      }
      const existingDraft = await tx.findDraftPolicy(channelId, purpose);
      if (existingDraft) {
        throw conflict(
          "SHIPPING_CHANNEL_POLICY_DRAFT_EXISTS",
          `Draft version ${existingDraft.version} already exists for ${channel.name}.`,
        );
      }

      const active = input.cloneActive
        ? await tx.findActivePolicy(channelId, purpose)
        : null;
      const version = await tx.nextPolicyVersion(channelId, purpose);
      const policyId = await tx.insertPolicyDraft({
        channelId,
        purpose,
        version,
        notes: notes ?? active?.notes ?? null,
        actor,
        now,
      });
      const routes = active
        ? active.routes.map(routeViewToPreparedRoute)
        : [disabledCatchAllRoute()];
      await tx.replacePolicyRoutes(policyId, routes, now);

      const created = await tx.getPolicyForUpdate(policyId);
      if (!created) throw internalError("Created policy draft could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.channel_policy.draft_created",
        target: `shipping.channel_policy:${policyId}`,
        changes: { before: null, after: auditPolicy(created) },
        context: {
          channelId,
          purpose,
          clonedFromPolicyId: active?.id ?? null,
        },
      }, now);
      return this.withActivationErrors(created, channel);
    });
  }

  async savePolicyDraft(
    input: SavePolicyDraftInput,
    actorInput: string,
  ): Promise<ShippingChannelPolicyView> {
    const actor = requireActor(actorInput);
    const policyId = requirePositiveId(input.policyId, "policyId");
    const expectedLockVersion = requirePositiveId(
      input.expectedLockVersion,
      "expectedLockVersion",
    );
    const notes = normalizeNotes(input.notes);
    const routes = normalizeRouteInputs(input.routes);
    const now = this.clock.now();

    return this.store.transaction(async (tx) => {
      const before = await tx.getPolicyForUpdate(policyId);
      if (!before) throw policyNotFound();
      assertDraft(before);
      assertExpectedVersion(before.lockVersion, expectedLockVersion);
      const channel = await tx.getChannelForUpdate(before.channelId);
      if (!channel) {
        throw internalError("The policy's channel could not be loaded.");
      }
      const preparedRoutes = await prepareRoutes(tx, routes);
      await tx.replacePolicyRoutes(policyId, preparedRoutes, now);
      const updated = await tx.updatePolicyDraft({
        policyId,
        expectedLockVersion,
        notes,
        now,
      });
      if (!updated) throw concurrencyConflict();
      const after = await tx.getPolicyForUpdate(policyId);
      if (!after) throw internalError("Saved policy draft could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.channel_policy.draft_saved",
        target: `shipping.channel_policy:${policyId}`,
        changes: { before: auditPolicy(before), after: auditPolicy(after) },
      }, now);
      return this.withActivationErrors(after, channel);
    });
  }

  async activatePolicyDraft(
    input: PolicyLifecycleInput,
    actorInput: string,
  ): Promise<ShippingChannelPolicyView> {
    const actor = requireActor(actorInput);
    const policyId = requirePositiveId(input.policyId, "policyId");
    const expectedLockVersion = requirePositiveId(
      input.expectedLockVersion,
      "expectedLockVersion",
    );
    const now = this.clock.now();

    return this.store.transaction(async (tx) => {
      const draft = await tx.getPolicyForUpdate(policyId);
      if (!draft) throw policyNotFound();
      assertDraft(draft);
      assertExpectedVersion(draft.lockVersion, expectedLockVersion);
      const channel = await tx.getChannelForUpdate(draft.channelId);
      if (!channel) {
        throw internalError("The policy's channel could not be loaded.");
      }
      const validationErrors = this.activationErrors(draft, channel);
      if (validationErrors.length > 0) {
        throw new ChannelShippingPolicyAdminError(
          409,
          "SHIPPING_CHANNEL_POLICY_NOT_READY",
          "Resolve the policy validation errors before activation.",
          validationErrors,
        );
      }

      const previousActive = await tx.findActivePolicy(draft.channelId, draft.purpose);
      if (previousActive && !await tx.retirePolicy({
        policyId: previousActive.id,
        expectedLockVersion: previousActive.lockVersion,
        now,
      })) {
        throw concurrencyConflict();
      }
      if (!await tx.activatePolicy({
        policyId,
        expectedLockVersion,
        actor,
        now,
      })) {
        throw concurrencyConflict();
      }

      const active = await tx.getPolicyForUpdate(policyId);
      if (!active) throw internalError("Activated policy could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.channel_policy.activated",
        target: `shipping.channel_policy:${policyId}`,
        changes: {
          before: {
            draft: auditPolicy(draft),
            previousActive: previousActive ? auditPolicy(previousActive) : null,
          },
          after: { active: auditPolicy(active) },
        },
        context: {
          channelId: active.channelId,
          purpose: active.purpose,
          supersededPolicyId: previousActive?.id ?? null,
        },
      }, now);
      return this.withActivationErrors(active, channel);
    });
  }

  async discardPolicyDraft(
    input: PolicyLifecycleInput,
    actorInput: string,
  ): Promise<ShippingChannelPolicyView> {
    const actor = requireActor(actorInput);
    const policyId = requirePositiveId(input.policyId, "policyId");
    const expectedLockVersion = requirePositiveId(
      input.expectedLockVersion,
      "expectedLockVersion",
    );
    const now = this.clock.now();

    return this.store.transaction(async (tx) => {
      const before = await tx.getPolicyForUpdate(policyId);
      if (!before) throw policyNotFound();
      assertDraft(before);
      assertExpectedVersion(before.lockVersion, expectedLockVersion);
      const channel = await tx.getChannelForUpdate(before.channelId);
      if (!channel) {
        throw internalError("The policy's channel could not be loaded.");
      }
      if (!await tx.discardPolicyDraft({ policyId, expectedLockVersion, now })) {
        throw concurrencyConflict();
      }
      const after = await tx.getPolicyForUpdate(policyId);
      if (!after) throw internalError("Discarded policy draft could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.channel_policy.draft_discarded",
        target: `shipping.channel_policy:${policyId}`,
        changes: { before: auditPolicy(before), after: auditPolicy(after) },
        context: {
          channelId: before.channelId,
          purpose: before.purpose,
        },
      }, now);
      return this.withActivationErrors(after, channel);
    });
  }

  async retireActivePolicy(
    input: PolicyLifecycleInput,
    actorInput: string,
  ): Promise<ShippingChannelPolicyView> {
    const actor = requireActor(actorInput);
    const policyId = requirePositiveId(input.policyId, "policyId");
    const expectedLockVersion = requirePositiveId(
      input.expectedLockVersion,
      "expectedLockVersion",
    );
    const now = this.clock.now();
    return this.store.transaction(async (tx) => {
      const before = await tx.getPolicyForUpdate(policyId);
      if (!before) throw policyNotFound();
      if (before.status !== "active") {
        throw conflict(
          "SHIPPING_CHANNEL_POLICY_NOT_ACTIVE",
          "Only an active policy can be retired.",
        );
      }
      assertExpectedVersion(before.lockVersion, expectedLockVersion);
      const channel = await tx.getChannelForUpdate(before.channelId);
      if (!channel) {
        throw internalError("The policy's channel could not be loaded.");
      }
      if (!await tx.retirePolicy({ policyId, expectedLockVersion, now })) {
        throw concurrencyConflict();
      }
      const after = await tx.getPolicyForUpdate(policyId);
      if (!after) throw internalError("Retired policy could not be reloaded.");
      await tx.persistAudit({
        actor,
        action: "shipping.channel_policy.retired",
        target: `shipping.channel_policy:${policyId}`,
        changes: { before: auditPolicy(before), after: auditPolicy(after) },
        context: {
          channelId: before.channelId,
          purpose: before.purpose,
          fallbackBehavior: "legacy_profile_when_available",
        },
      }, now);
      return this.withActivationErrors(after, channel);
    });
  }

  async previewPolicyResolution(
    input: PolicyResolutionPreviewInput,
  ): Promise<ShippingChannelPolicyResolutionView> {
    const policy = await this.getPolicy(input.policyId);
    return decisionToView(resolveChannelShippingPolicyCandidate(
      policyViewToCandidate(policy),
      resolutionInput(policy, input),
    ));
  }

  async comparePolicyToLegacy(
    input: PolicyShadowComparisonInput,
  ): Promise<ShippingChannelPolicyShadowComparison> {
    const actor = requireActor(input.actor);
    const policy = await this.getPolicy(input.policyId);
    const resolvedInput = resolutionInput(policy, input);
    const canonical = decisionToView(resolveChannelShippingPolicyCandidate(
      policyViewToCandidate(policy),
      resolvedInput,
    ));
    const legacyFallback = buildLegacyChannelShippingFallback(input.legacyProfile);
    if (legacyFallback.purpose !== policy.purpose) {
      throw new ChannelShippingPolicyAdminError(
        400,
        "SHIPPING_LEGACY_PROFILE_PURPOSE_MISMATCH",
        `${input.legacyProfile} currently serves ${legacyFallback.purpose}, not ${policy.purpose}.`,
      );
    }

    const legacy = await this.resolveLegacyDecision(
      legacyFallback,
      resolvedInput.originWarehouseId,
    );
    const differences = compareDecisionViews(canonical, legacy);
    const matchesLegacy = differences.length === 0;
    const now = this.clock.now();
    const snapshotId = await this.store.persistShadowComparison({
      actor,
      policy,
      resolutionInput: resolvedInput,
      legacyProfile: input.legacyProfile,
      canonical,
      legacy,
      matchesLegacy,
      differences,
      now,
    });

    return {
      matchesLegacy,
      differences,
      canonical,
      legacy,
      snapshotId,
    };
  }

  private async resolveLegacyDecision(
    legacyFallback: ReturnType<typeof buildLegacyChannelShippingFallback>,
    originWarehouseId: number,
  ): Promise<ShippingChannelPolicyResolutionView> {
    if (legacyFallback.mode === "channel_managed") {
      return {
        ok: true,
        source: "legacy_profile",
        policyId: null,
        policyVersion: null,
        routeId: null,
        mode: legacyFallback.mode,
        eligibilityMode: legacyFallback.eligibilityMode,
        rateBookId: null,
        code: null,
        message: null,
      };
    }
    if (!legacyFallback.rateContext) {
      return failedDecisionView(
        "INVALID_LEGACY_FALLBACK",
        "Legacy engine routing is missing its rate context.",
      );
    }
    const rateBook = await this.store.resolveLegacyRateBook(
      legacyFallback.rateContext,
      originWarehouseId,
    );
    if (!rateBook.ok) return failedDecisionView(rateBook.code, rateBook.message);
    return {
      ok: true,
      source: "legacy_profile",
      policyId: null,
      policyVersion: null,
      routeId: null,
      mode: legacyFallback.mode,
      eligibilityMode: legacyFallback.eligibilityMode,
      rateBookId: rateBook.rateBookId,
      code: null,
      message: null,
    };
  }

  private activationErrors(
    policy: ShippingChannelPolicyView,
    channel: ChannelRecord,
  ): string[] {
    return policyActivationErrors(
      policy,
      channel.provider,
      this.capabilityResolver.resolve(channel.provider),
    );
  }

  private withActivationErrors(
    policy: ShippingChannelPolicyView,
    channel: ChannelRecord,
  ): ShippingChannelPolicyView {
    return {
      ...policy,
      activationErrors: this.activationErrors(policy, channel),
    };
  }
}

export function policyActivationErrors(
  policy: ShippingChannelPolicyView,
  provider: string,
  capabilities: ShippingChannelAdapterCapabilities | null,
): string[] {
  const errors = validateChannelShippingPolicyForActivation(
    policyViewToCandidate(policy).routes,
  );
  errors.push(...adapterCapabilityErrors(policy, provider, capabilities));
  for (const route of policy.routes) {
    if (
      route.originWarehouseId !== null
      && route.originWarehouseActive !== true
    ) {
      errors.push(
        `Route ${route.id}: warehouse "${route.originWarehouseName ?? route.originWarehouseId}" is inactive.`,
      );
    }
    if (
      route.mode === "engine_quoted"
      && route.rateBookStatus === "active"
      && route.activeRateTableCount < 1
    ) {
      errors.push(
        `Route ${route.id}: pricing program "${route.rateBookName ?? route.rateBookId}" has no live rates.`,
      );
    }
  }
  return [...new Set(errors)];
}

function adapterCapabilityErrors(
  policy: ShippingChannelPolicyView,
  providerInput: string,
  capabilities: ShippingChannelAdapterCapabilities | null,
): string[] {
  const provider = providerInput.trim().toLowerCase();
  const errors: string[] = [];
  for (const route of policy.routes) {
    if (route.mode === "disabled") continue;
    if (!capabilities) {
      errors.push(
        `Route ${route.id}: provider "${provider}" has no declared shipping adapter capabilities.`,
      );
      continue;
    }
    if (
      route.mode === "engine_quoted"
      && !capabilities.acceptsEngineQuotes
    ) {
      errors.push(
        `Route ${route.id}: provider "${provider}" cannot accept Echelon rate quotes.`,
      );
    }
    if (
      route.mode === "channel_managed"
      && !capabilities.managesOwnRates
    ) {
      errors.push(
        `Route ${route.id}: provider "${provider}" cannot manage checkout rates.`,
      );
    }
    const requiresChannelEligibility =
      route.mode === "channel_managed"
      || route.eligibilityMode === "channel"
      || route.eligibilityMode === "intersection";
    if (
      requiresChannelEligibility
      && !capabilities.enforcesDestinationEligibility
    ) {
      errors.push(
        `Route ${route.id}: provider "${provider}" cannot enforce the selected destination eligibility.`,
      );
    }
  }
  return errors;
}

async function prepareRoutes(
  tx: ChannelShippingPolicyAdminTransaction,
  routes: readonly ShippingChannelPolicyRouteInput[],
): Promise<PreparedPolicyRoute[]> {
  const scopeIds = uniquePositiveIds(routes.flatMap((route) =>
    route.destinationScopeId === null ? [] : [route.destinationScopeId]));
  const warehouseIds = uniquePositiveIds(routes.flatMap((route) =>
    route.originWarehouseId === null ? [] : [route.originWarehouseId]));
  const rateBookIds = uniquePositiveIds(routes.flatMap((route) =>
    route.rateBookId === null ? [] : [route.rateBookId]));

  // Keep transaction reads sequential. node-postgres transactions share one
  // client, and concurrent statements add no throughput while obscuring the
  // lock/query order during policy saves.
  const scopes = await tx.getDestinationScopesByIds(scopeIds);
  const warehouses = await tx.getWarehousesByIds(warehouseIds);
  const rateBooks = await tx.getRateBooksByIds(rateBookIds);
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  const warehouseById = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const rateBookById = new Map(rateBooks.map((book) => [book.id, book]));

  for (const id of scopeIds) {
    const scope = scopeById.get(id);
    if (!scope || scope.status !== "active") {
      throw new ChannelShippingPolicyAdminError(
        400,
        "SHIPPING_DESTINATION_SCOPE_UNAVAILABLE",
        `Destination group ${id} is missing or not active.`,
      );
    }
  }
  for (const id of warehouseIds) {
    const warehouse = warehouseById.get(id);
    if (!warehouse || !warehouse.isActive) {
      throw new ChannelShippingPolicyAdminError(
        400,
        "SHIPPING_WAREHOUSE_UNAVAILABLE",
        `Warehouse ${id} is missing or inactive.`,
      );
    }
  }
  for (const id of rateBookIds) {
    if (!rateBookById.has(id)) {
      throw new ChannelShippingPolicyAdminError(
        400,
        "SHIPPING_RATE_BOOK_NOT_FOUND",
        `Pricing program ${id} does not exist.`,
      );
    }
  }

  return routes.map((route) => ({
    originWarehouseId: route.originWarehouseId,
    destinationScopeId: route.destinationScopeId,
    destinationMembers: route.destinationScopeId === null
      ? []
      : scopeById.get(route.destinationScopeId)?.members.map((member) => ({ ...member })) ?? [],
    mode: route.mode,
    eligibilityMode: route.eligibilityMode,
    rateBookId: route.rateBookId,
  }));
}

function normalizeRouteInputs(
  routes: readonly ShippingChannelPolicyRouteInput[],
): ShippingChannelPolicyRouteInput[] {
  if (routes.length < 1 || routes.length > 200) {
    throw invalidInput("A policy requires between 1 and 200 routes.");
  }
  const normalized = routes.map((route, index) => {
    const originWarehouseId = nullablePositiveId(
      route.originWarehouseId,
      `routes[${index}].originWarehouseId`,
    );
    const destinationScopeId = nullablePositiveId(
      route.destinationScopeId,
      `routes[${index}].destinationScopeId`,
    );
    const rateBookId = nullablePositiveId(
      route.rateBookId,
      `routes[${index}].rateBookId`,
    );
    if (!SHIPPING_CHANNEL_ROUTE_MODES.includes(route.mode)) {
      throw invalidInput(`Route ${index + 1} has an unsupported mode.`);
    }
    if (!SHIPPING_CHANNEL_ELIGIBILITY_MODES.includes(route.eligibilityMode)) {
      throw invalidInput(`Route ${index + 1} has an unsupported eligibility mode.`);
    }
    assertRouteModeContract(route.mode, route.eligibilityMode, rateBookId, index);
    return {
      originWarehouseId,
      destinationScopeId,
      mode: route.mode,
      eligibilityMode: route.eligibilityMode,
      rateBookId,
    };
  });
  const keys = new Set<string>();
  for (const route of normalized) {
    const key = `${route.originWarehouseId ?? "*"}:${route.destinationScopeId ?? "*"}`;
    if (keys.has(key)) {
      throw invalidInput(
        "The same warehouse and destination group can appear only once in a policy.",
      );
    }
    keys.add(key);
  }
  return normalized;
}

function assertRouteModeContract(
  mode: ShippingChannelRouteMode,
  eligibilityMode: ShippingChannelEligibilityMode,
  rateBookId: number | null,
  index: number,
): void {
  const label = `Route ${index + 1}`;
  if (mode === "engine_quoted" && (rateBookId === null || eligibilityMode === "none")) {
    throw invalidInput(`${label}: Echelon rates require a pricing program and eligibility owner.`);
  }
  if (mode === "channel_managed" && (rateBookId !== null || eligibilityMode === "none")) {
    throw invalidInput(`${label}: channel-managed rates cannot reference a pricing program.`);
  }
  if (mode === "disabled" && (rateBookId !== null || eligibilityMode !== "none")) {
    throw invalidInput(`${label}: disabled routes cannot price or authorize destinations.`);
  }
}

function normalizeDestinationScopeInput(
  input: CreateDestinationScopeInput,
): CreateDestinationScopeInput {
  const code = input.code.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(code)) {
    throw invalidInput(
      "Destination group code must use lowercase letters, numbers, and hyphens.",
    );
  }
  if (name.length < 1 || name.length > 160) {
    throw invalidInput("Destination group name is required and must be 160 characters or fewer.");
  }
  if (input.members.length < 1 || input.members.length > 2_000) {
    throw invalidInput("A destination group requires between 1 and 2,000 destinations.");
  }
  const members = input.members.map(normalizeDestinationMember);
  const seen = new Set<string>();
  for (const member of members) {
    const key = `${member.country}:${member.region ?? ""}:${member.postalPrefix ?? ""}`;
    if (seen.has(key)) {
      throw invalidInput(`Destination ${key} appears more than once.`);
    }
    seen.add(key);
  }
  return { code, name, members };
}

function normalizeDestinationMember(
  member: ShippingDestinationScopeMember,
): ShippingDestinationScopeMember {
  const country = member.country.trim().toUpperCase();
  const region = normalizeOptionalCode(member.region);
  const postalPrefix = normalizeOptionalPostal(member.postalPrefix);
  if (!/^[A-Z]{2}$/.test(country)) {
    throw invalidInput("Destination country must be a two-letter code.");
  }
  if (region !== null && !/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(region)) {
    throw invalidInput(`Destination region "${region}" is invalid.`);
  }
  if (postalPrefix !== null && !/^[A-Z0-9][A-Z0-9 -]{0,19}$/.test(postalPrefix)) {
    throw invalidInput(`Postal prefix "${postalPrefix}" is invalid.`);
  }
  return { country, region, postalPrefix };
}

function policyViewToCandidate(
  policy: ShippingChannelPolicyView,
): ChannelShippingPolicyCandidate {
  return {
    policyId: policy.id,
    channelId: policy.channelId,
    purpose: policy.purpose,
    version: policy.version,
    status: policy.status,
    routes: policy.routes.map((route) => ({
      routeId: route.id,
      originWarehouseId: route.originWarehouseId,
      sourceDestinationScopeId: route.destinationScopeId,
      destinationMembers: route.destinationMembers.map((member) => ({
        country: member.country,
        region: member.region,
        postalPrefix: member.postalPrefix,
      })),
      mode: route.mode,
      eligibilityMode: route.eligibilityMode,
      rateBookId: route.rateBookId,
      rateBookStatus: normalizeRateBookStatus(route.rateBookStatus),
    })),
  };
}

function normalizeRateBookStatus(
  status: string | null,
): "draft" | "active" | "retired" | null {
  return status === "active" || status === "draft" || status === "retired"
    ? status
    : status === null
      ? null
      : "retired";
}

function routeViewToPreparedRoute(
  route: ShippingChannelPolicyView["routes"][number],
): PreparedPolicyRoute {
  return {
    originWarehouseId: route.originWarehouseId,
    destinationScopeId: route.destinationScopeId,
    destinationMembers: route.destinationMembers.map((member) => ({ ...member })),
    mode: route.mode,
    eligibilityMode: route.eligibilityMode,
    rateBookId: route.rateBookId,
  };
}

function disabledCatchAllRoute(): PreparedPolicyRoute {
  return {
    originWarehouseId: null,
    destinationScopeId: null,
    destinationMembers: [],
    mode: "disabled",
    eligibilityMode: "none",
    rateBookId: null,
  };
}

function resolutionInput(
  policy: ShippingChannelPolicyView,
  input: PolicyResolutionPreviewInput,
): ChannelShippingPolicyResolutionInput {
  return {
    channelId: policy.channelId,
    purpose: policy.purpose,
    originWarehouseId: requirePositiveId(
      input.originWarehouseId,
      "originWarehouseId",
    ),
    destination: {
      country: input.destination.country,
      region: input.destination.region,
      postalCode: input.destination.postalCode,
    },
  };
}

function decisionToView(
  decision: ChannelShippingDecision,
): ShippingChannelPolicyResolutionView {
  if (!decision.ok) return failedDecisionView(decision.code, decision.message);
  return {
    ok: true,
    source: decision.source,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    routeId: decision.routeId,
    mode: decision.mode,
    eligibilityMode: decision.eligibilityMode,
    rateBookId: decision.rateBookId,
    code: null,
    message: null,
  };
}

function failedDecisionView(
  code: string,
  message: string,
): ShippingChannelPolicyResolutionView {
  return {
    ok: false,
    source: null,
    policyId: null,
    policyVersion: null,
    routeId: null,
    mode: null,
    eligibilityMode: null,
    rateBookId: null,
    code,
    message,
  };
}

function compareDecisionViews(
  canonical: ShippingChannelPolicyResolutionView,
  legacy: ShippingChannelPolicyResolutionView,
): string[] {
  const differences: string[] = [];
  if (!canonical.ok) differences.push(`Canonical policy failed: ${canonical.code}.`);
  if (!legacy.ok) differences.push(`Legacy routing failed: ${legacy.code}.`);
  if (!canonical.ok || !legacy.ok) return differences;
  if (canonical.mode !== legacy.mode) {
    differences.push(`Rate owner differs: ${canonical.mode} vs ${legacy.mode}.`);
  }
  if (canonical.eligibilityMode !== legacy.eligibilityMode) {
    differences.push(
      `Eligibility owner differs: ${canonical.eligibilityMode} vs ${legacy.eligibilityMode}.`,
    );
  }
  if (canonical.rateBookId !== legacy.rateBookId) {
    differences.push(
      `Pricing program differs: ${canonical.rateBookId ?? "none"} vs ${legacy.rateBookId ?? "none"}.`,
    );
  }
  return differences;
}

function auditPolicy(policy: ShippingChannelPolicyView): Record<string, unknown> {
  return {
    id: policy.id,
    channelId: policy.channelId,
    purpose: policy.purpose,
    version: policy.version,
    status: policy.status,
    lockVersion: policy.lockVersion,
    notes: policy.notes,
    routes: policy.routes.map((route) => ({
      id: route.id,
      originWarehouseId: route.originWarehouseId,
      destinationScopeId: route.destinationScopeId,
      destinationMembers: route.destinationMembers,
      mode: route.mode,
      eligibilityMode: route.eligibilityMode,
      rateBookId: route.rateBookId,
    })),
  };
}

function auditScope(scope: ShippingDestinationScopeSummary): Record<string, unknown> {
  return {
    id: scope.id,
    code: scope.code,
    name: scope.name,
    status: scope.status,
    lockVersion: scope.lockVersion,
    members: scope.members,
  };
}

function assertDraft(policy: ShippingChannelPolicyView): void {
  if (policy.status !== "draft") {
    throw conflict(
      "SHIPPING_CHANNEL_POLICY_NOT_DRAFT",
      "Only a draft policy can be edited or activated.",
    );
  }
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) throw concurrencyConflict();
}

function requirePurpose(value: ShippingChannelPolicyPurpose): ShippingChannelPolicyPurpose {
  if (!SHIPPING_CHANNEL_POLICY_PURPOSES.includes(value)) {
    throw invalidInput("Unsupported shipping policy purpose.");
  }
  return value;
}

function requireActor(value: string): string {
  const actor = value.trim();
  if (actor.length < 1 || actor.length > 200) {
    throw new ChannelShippingPolicyAdminError(
      401,
      "SHIPPING_CHANNEL_POLICY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return actor;
}

function requirePositiveId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidInput(`${field} must be a positive integer.`);
  }
  return value;
}

function nullablePositiveId(value: number | null, field: string): number | null {
  return value === null ? null : requirePositiveId(value, field);
}

function uniquePositiveIds(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => requirePositiveId(value, "referenceId")))];
}

function normalizeNotes(value: string | null): string | null {
  if (value === null) return null;
  const notes = value.trim();
  if (notes.length > 1_000) throw invalidInput("Notes must be 1,000 characters or fewer.");
  return notes === "" ? null : notes;
}

function normalizeOptionalCode(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

function normalizeOptionalPostal(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "") return null;
  const compact = normalized.replace(/[\s-]+/g, "");
  return compact === "" ? null : compact;
}

function policyNotFound(): ChannelShippingPolicyAdminError {
  return new ChannelShippingPolicyAdminError(
    404,
    "SHIPPING_CHANNEL_POLICY_NOT_FOUND",
    "Shipping channel policy not found.",
  );
}

function scopeNotFound(): ChannelShippingPolicyAdminError {
  return new ChannelShippingPolicyAdminError(
    404,
    "SHIPPING_DESTINATION_SCOPE_NOT_FOUND",
    "Destination group not found.",
  );
}

function concurrencyConflict(): ChannelShippingPolicyAdminError {
  return conflict(
    "SHIPPING_CHANNEL_POLICY_CHANGED",
    "This configuration changed in another session. Refresh before trying again.",
  );
}

function invalidInput(message: string): ChannelShippingPolicyAdminError {
  return new ChannelShippingPolicyAdminError(
    400,
    "SHIPPING_CHANNEL_POLICY_INVALID_INPUT",
    message,
  );
}

function conflict(code: string, message: string): ChannelShippingPolicyAdminError {
  return new ChannelShippingPolicyAdminError(409, code, message);
}

function internalError(message: string): ChannelShippingPolicyAdminError {
  return new ChannelShippingPolicyAdminError(
    500,
    "SHIPPING_CHANNEL_POLICY_INTERNAL_ERROR",
    message,
  );
}
