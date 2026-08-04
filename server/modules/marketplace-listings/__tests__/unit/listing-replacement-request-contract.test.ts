import { describe, expect, it } from "vitest";

import {
  listingOwnerSnapshotSchema,
  listingReplacementOperationSchema,
  planListingReplacementInputSchema,
} from "../../application/dtos";
import {
  buildListingReplacementPlan,
  type ListingOwnerSnapshot,
} from "../../domain/listing-replacement-plan";
import {
  LISTING_REPLACEMENT_OPERATION_STATUSES,
  LISTING_REPLACEMENT_PHASES,
  type ListingReplacementOperationStatus,
  type ListingReplacementPhase,
} from "../../domain/lifecycle";

const ALLOWED_OPERATION_PHASES: Readonly<
  Record<ListingReplacementOperationStatus, readonly ListingReplacementPhase[]>
> = {
  planned: ["preflight"],
  running: ["preflight", "cutover", "publish", "verify", "switch_mapping"],
  compensating: ["compensate"],
  completed: ["complete"],
  failed: ["preflight", "compensate"],
  manual_recovery_required: [
    "preflight",
    "cutover",
    "publish",
    "verify",
    "switch_mapping",
    "compensate",
  ],
  cancelled: ["preflight"],
};

describe("listing replacement request identity", () => {
  it("stays stable across mutable publication context while execution identity changes", () => {
    const first = buildPlan(baseSnapshot(), {
      idempotencyKey: "replacement-request-1",
      correlationId: "correlation-a",
      requestedAt: new Date("2026-08-04T12:00:00.000Z"),
    });
    const advanced = baseSnapshot();
    const second = buildPlan(
      {
        ...advanced,
        sourcePublication: {
          ...advanced.sourcePublication,
          publicationId: 1002,
          generation: 2,
          desiredStateHash: "b".repeat(64),
          providerPublicationKey: "ARM-ENV-SGL-V2",
          externalListingId: "398148438779",
        },
        nextGeneration: 3,
        memberCandidates: [
          {
            productVariantId: 438,
            sku: "ARM-ENV-SGL-C750-REV2",
            currentlyPublished: true,
          },
        ],
      },
      {
        idempotencyKey: "replacement-request-1",
        correlationId: "correlation-b",
        requestedAt: new Date("2026-08-05T12:00:00.000Z"),
      },
    );

    expect(second.requestHash).toBe(first.requestHash);
    expect(second.desiredStateHash).not.toBe(first.desiredStateHash);
    expect(second.steps.map((step) => step.idempotencyKey)).not.toEqual(
      first.steps.map((step) => step.idempotencyKey),
    );
  });

  it("keeps command hashes stable but separates step keys for distinct operation keys", () => {
    const first = buildPlan(baseSnapshot(), { idempotencyKey: "operation-a" });
    const second = buildPlan(baseSnapshot(), { idempotencyKey: "operation-b" });

    expect(second.requestHash).toBe(first.requestHash);
    expect(second.steps.map((step) => step.requestHash)).toEqual(
      first.steps.map((step) => step.requestHash),
    );
    expect(second.steps.map((step) => step.idempotencyKey)).not.toEqual(
      first.steps.map((step) => step.idempotencyKey),
    );
  });
});

describe("PostgreSQL INTEGER input boundaries", () => {
  const beyondInteger = 2_147_483_648;

  it.each([
    ["channelId", { owner: { ...command().owner, channelId: beyondInteger } }],
    ["productId", { owner: { ...command().owner, productId: beyondInteger } }],
    [
      "productVariantId",
      {
        targetMembers: [
          {
            productVariantId: beyondInteger,
            disposition: "included",
            reasonCode: null,
          },
        ],
      },
    ],
  ])(
    "rejects %s values beyond the PostgreSQL INTEGER range",
    (_field, override) => {
      expect(
        planListingReplacementInputSchema.safeParse({
          ...command(),
          ...override,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a dropship store connection beyond the PostgreSQL INTEGER range", () => {
    expect(
      planListingReplacementInputSchema.safeParse({
        ...command(),
        owner: {
          kind: "dropship",
          storeConnectionId: beyondInteger,
          productId: 33,
          provider: "ebay",
          marketplaceId: "EBAY_US",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects snapshot generations beyond the PostgreSQL INTEGER range", () => {
    const snapshot = baseSnapshot();
    expect(
      listingOwnerSnapshotSchema.safeParse({
        ...snapshot,
        nextGeneration: beyondInteger,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate SKU snapshots after input normalization", () => {
    const snapshot = baseSnapshot();
    const result = listingOwnerSnapshotSchema.safeParse({
      ...snapshot,
      memberCandidates: [
        {
          productVariantId: 438,
          sku: " ARM-ENV-SGL-C750 ",
          currentlyPublished: true,
        },
        {
          productVariantId: 439,
          sku: "ARM-ENV-SGL-C750",
          currentlyPublished: false,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success)
      throw new Error("Expected duplicate SKU validation to fail.");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["memberCandidates", 1, "sku"] }),
      ]),
    );
  });
});

describe("listing replacement operation output contract", () => {
  it("matches the PostgreSQL status and phase lifecycle matrix", () => {
    for (const status of LISTING_REPLACEMENT_OPERATION_STATUSES) {
      for (const currentPhase of LISTING_REPLACEMENT_PHASES) {
        const result = listingReplacementOperationSchema.safeParse(
          operationResult({ status, currentPhase }),
        );
        expect(result.success, `${status} -> ${currentPhase}`).toBe(
          ALLOWED_OPERATION_PHASES[status].includes(currentPhase),
        );
      }
    }
  });

  it("rejects an updated timestamp before the creation timestamp", () => {
    const result = listingReplacementOperationSchema.safeParse(
      operationResult({
        createdAt: new Date("2026-08-04T12:00:00.000Z"),
        updatedAt: new Date("2026-08-04T11:59:59.999Z"),
      }),
    );

    expect(result.success).toBe(false);
    if (result.success)
      throw new Error("Expected operation timestamp validation to fail.");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["updatedAt"] }),
      ]),
    );
  });
});

function operationResult(
  overrides: Partial<{
    status: ListingReplacementOperationStatus;
    currentPhase: ListingReplacementPhase;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
): Record<string, unknown> {
  return {
    operationId: 3001,
    scopeId: 51,
    sourcePublicationId: 1001,
    targetPublicationId: 2002,
    idempotencyKey: "replacement-request",
    requestHash: "a".repeat(64),
    desiredStateHash: "b".repeat(64),
    status: "planned",
    currentPhase: "preflight",
    stateVersion: 1,
    createdAt: new Date("2026-08-04T12:00:00.000Z"),
    updatedAt: new Date("2026-08-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildPlan(
  snapshot: ListingOwnerSnapshot,
  overrides: {
    readonly idempotencyKey?: string;
    readonly correlationId?: string;
    readonly requestedAt?: Date;
  } = {},
) {
  return buildListingReplacementPlan({
    snapshot,
    requestedMembers: [
      { productVariantId: 438, disposition: "included", reasonCode: null },
    ],
    idempotencyKey: overrides.idempotencyKey ?? "replacement-request",
    requestedBy: { type: "user", id: "owner@example.test" },
    correlationId: overrides.correlationId ?? "correlation",
    requestedAt: overrides.requestedAt ?? new Date("2026-08-04T12:00:00.000Z"),
  });
}

function baseSnapshot(): ListingOwnerSnapshot {
  return {
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
        currentlyPublished: true,
      },
    ],
  };
}

function command() {
  return {
    owner: {
      kind: "channel" as const,
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    targetMembers: [
      {
        productVariantId: 438,
        disposition: "included" as const,
        reasonCode: null,
      },
    ],
    idempotencyKey: "replacement-request",
    requestedBy: { type: "user" as const, id: "owner@example.test" },
    correlationId: "correlation",
  };
}
