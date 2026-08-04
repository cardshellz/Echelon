import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Canonical } from "../../domain/canonical-hash";
import { MarketplaceListingReplacementError } from "../../domain/errors";
import {
  buildListingReplacementPlan,
  type BuildListingReplacementPlanInput,
} from "../../domain/listing-replacement-plan";
import {
  LISTING_PUBLICATION_STATUSES,
  LISTING_REPLACEMENT_OPERATION_STATUSES,
  LISTING_REPLACEMENT_PHASES,
  LISTING_REPLACEMENT_STEP_STATUSES,
  assertLocalListingPublicationStatusEdgeAllowed,
  assertLocalListingReplacementOperationStatusEdgeAllowed,
  assertLocalListingReplacementPhaseEdgeAllowed,
  assertLocalListingReplacementStepStatusEdgeAllowed,
  isLocalListingPublicationStatusEdgeAllowed,
  isLocalListingReplacementOperationStatusEdgeAllowed,
  isLocalListingReplacementPhaseEdgeAllowed,
  isLocalListingReplacementStepStatusEdgeAllowed,
  type ListingPublicationStatus,
  type ListingReplacementOperationStatus,
  type ListingReplacementPhase,
  type ListingReplacementStepStatus,
} from "../../domain/lifecycle";

describe("marketplace listing replacement canonical plan", () => {
  it("uses stable key ordering and a lowercase SHA-256 digest", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("rejects non-integer canonical values rather than hashing ambiguous numbers", () => {
    expect(() => sha256Canonical({ amount: 1.5 })).toThrowError(
      MarketplaceListingReplacementError,
    );
  });

  it("sorts members and separates forward and compensation steps before hashing", () => {
    const first = buildListingReplacementPlan(
      planInput([
        { productVariantId: 438, disposition: "included", reasonCode: null },
        {
          productVariantId: 67,
          disposition: "excluded",
          reasonCode: "variant_inactive",
        },
        { productVariantId: 66, disposition: "included", reasonCode: null },
      ]),
    );
    const second = buildListingReplacementPlan(
      planInput([
        { productVariantId: 66, disposition: "included", reasonCode: null },
        { productVariantId: 438, disposition: "included", reasonCode: null },
        {
          productVariantId: 67,
          disposition: "excluded",
          reasonCode: "variant_inactive",
        },
      ]),
    );

    expect(
      first.targetMembers.map((member) => member.productVariantId),
    ).toEqual([66, 67, 438]);
    expect(
      first.steps.map(
        (step) => `${step.executionPath}:${step.sequence}:${step.stepKey}`,
      ),
    ).toEqual([
      "forward:1:preflight.validate_plan",
      "forward:2:cutover.quiesce_source",
      "forward:3:publish.create_target",
      "forward:4:verify.target_publication",
      "forward:5:switch_mapping.activate_target",
      "compensation:1:compensate.ensure_target_not_sellable",
      "compensation:2:compensate.ensure_source_live",
    ]);
    expect(first.steps.every((step) => step.phase !== "complete")).toBe(true);
    expect(
      first.steps.every((step) =>
        step.executionPath === "forward"
          ? step.phase !== "compensate"
          : step.phase === "compensate",
      ),
    ).toBe(true);
    expect(first.desiredStateHash).toBe(second.desiredStateHash);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.steps.map((step) => step.requestHash)).toEqual(
      second.steps.map((step) => step.requestHash),
    );
  });

  it("rejects duplicate SKU snapshots after normalization", () => {
    const input = planInput([
      { productVariantId: 66, disposition: "included", reasonCode: null },
      {
        productVariantId: 67,
        disposition: "excluded",
        reasonCode: "variant_inactive",
      },
      { productVariantId: 438, disposition: "included", reasonCode: null },
    ]);
    const [first, second, third] = input.snapshot.memberCandidates;
    const duplicateSkuInput: BuildListingReplacementPlanInput = {
      ...input,
      snapshot: {
        ...input.snapshot,
        memberCandidates: [
          { ...first!, sku: " ARM-ENV-SGL-DUPLICATE " },
          { ...second!, sku: "ARM-ENV-SGL-DUPLICATE " },
          { ...third!, sku: "ARM-ENV-SGL-DUPLICATE" },
        ],
      },
    };

    expect(() => buildListingReplacementPlan(duplicateSkuInput)).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_DUPLICATE_SKU",
        context: {
          skuSnapshot: "ARM-ENV-SGL-DUPLICATE",
          productVariantIds: [66, 67, 438],
        },
      }),
    );
  });

  it("requires an explicit disposition for every owner-snapshot member", () => {
    const input = planInput([
      { productVariantId: 66, disposition: "included", reasonCode: null },
      { productVariantId: 438, disposition: "included", reasonCode: null },
    ]);
    expect(() => buildListingReplacementPlan(input)).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REPLACEMENT_MEMBER_PLAN_INCOMPLETE",
      }),
    );
  });
});

describe("marketplace listing replacement local lifecycle edges", () => {
  it("exhaustively models local publication status edges", () => {
    const allowed = {
      planned: ["staged", "failed"],
      staged: ["active", "failed"],
      active: ["superseded", "withdrawn"],
      superseded: [],
      withdrawn: [],
      failed: [],
    } satisfies Record<
      ListingPublicationStatus,
      readonly ListingPublicationStatus[]
    >;
    assertTransitionMatrix(
      LISTING_PUBLICATION_STATUSES,
      allowed,
      isLocalListingPublicationStatusEdgeAllowed,
      assertLocalListingPublicationStatusEdgeAllowed,
    );
  });

  it("exhaustively models local operation status edges", () => {
    const allowed = {
      planned: ["running", "cancelled"],
      running: [
        "compensating",
        "completed",
        "failed",
        "manual_recovery_required",
      ],
      compensating: ["failed", "manual_recovery_required"],
      completed: [],
      failed: [],
      manual_recovery_required: ["running", "compensating"],
      cancelled: [],
    } satisfies Record<
      ListingReplacementOperationStatus,
      readonly ListingReplacementOperationStatus[]
    >;
    assertTransitionMatrix(
      LISTING_REPLACEMENT_OPERATION_STATUSES,
      allowed,
      isLocalListingReplacementOperationStatusEdgeAllowed,
      assertLocalListingReplacementOperationStatusEdgeAllowed,
    );
  });

  it("exhaustively models local phase edges", () => {
    const allowed = {
      preflight: ["cutover", "compensate"],
      cutover: ["publish", "compensate"],
      publish: ["verify", "compensate"],
      verify: ["switch_mapping", "compensate"],
      switch_mapping: ["complete", "compensate"],
      compensate: [],
      complete: [],
    } satisfies Record<
      ListingReplacementPhase,
      readonly ListingReplacementPhase[]
    >;
    assertTransitionMatrix(
      LISTING_REPLACEMENT_PHASES,
      allowed,
      isLocalListingReplacementPhaseEdgeAllowed,
      assertLocalListingReplacementPhaseEdgeAllowed,
    );
  });

  it("exhaustively models local step status edges, including retry", () => {
    const allowed = {
      pending: ["running"],
      running: ["succeeded", "failed"],
      succeeded: [],
      failed: ["running"],
    } satisfies Record<
      ListingReplacementStepStatus,
      readonly ListingReplacementStepStatus[]
    >;
    assertTransitionMatrix(
      LISTING_REPLACEMENT_STEP_STATUSES,
      allowed,
      isLocalListingReplacementStepStatusEdgeAllowed,
      assertLocalListingReplacementStepStatusEdgeAllowed,
    );
  });
});

function planInput(
  requestedMembers: BuildListingReplacementPlanInput["requestedMembers"],
): BuildListingReplacementPlanInput {
  return {
    snapshot: {
      owner: {
        kind: "channel",
        channelId: 7,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      scopeId: 51,
      sourcePublication: {
        publicationId: 1001,
        generation: 1,
        status: "active",
        desiredStateHash: "a".repeat(64),
        providerPublicationKey: "ARM-ENV-SGL",
        externalListingId: "298148438778",
      },
      nextGeneration: 2,
      memberCandidates: [
        {
          productVariantId: 438,
          sku: "ARM-ENV-SGL-C750",
          currentlyPublished: false,
        },
        {
          productVariantId: 67,
          sku: "ARM-ENV-SGL-C700",
          currentlyPublished: true,
        },
        {
          productVariantId: 66,
          sku: "ARM-ENV-SGL-P50",
          currentlyPublished: true,
        },
      ],
    },
    requestedMembers,
    idempotencyKey: "replace-arm-env-sgl-2026-08-04",
    requestedBy: { type: "user", id: "owner@example.test" },
    correlationId: "replacement-test",
    requestedAt: new Date("2026-08-04T12:00:00.000Z"),
  };
}

function assertTransitionMatrix<T extends string>(
  statuses: readonly T[],
  allowed: Readonly<Record<T, readonly T[]>>,
  isLocalEdgeAllowed: (from: T, to: T) => boolean,
  assertLocalEdgeAllowed: (from: T, to: T) => void,
): void {
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = allowed[from].includes(to);
      expect(isLocalEdgeAllowed(from, to), `${from} -> ${to}`).toBe(expected);
      if (expected) {
        expect(() => assertLocalEdgeAllowed(from, to)).not.toThrow();
      } else {
        expect(() => assertLocalEdgeAllowed(from, to)).toThrowError(
          MarketplaceListingReplacementError,
        );
      }
    }
  }
}
