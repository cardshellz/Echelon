import { describe, expect, it, vi } from "vitest";
import {
  ListingPublicationService,
  type ListingPublicationDependencies,
} from "../../application/listing-publication.service";
import type { ListingPublicationProvider } from "../../application/listing-publication-provider.port";
import { ListingSubmissionError } from "../../application/listing-publication-provider.port";
import { ChannelProviderError } from "../../../channels/channel-provider.error";
import type { ListingPublicationStore } from "../../application/listing-publication-store.port";
import {
  ListingPublicationError,
  summarizeListingProgress,
  type ListingSnapshot,
} from "../../domain/listing-publication";
import {
  fixedNow,
  publicationOperation,
  publicationSnapshot,
  testId,
} from "../fixtures/listing-publication.fixture";

function setup(snapshot = publicationSnapshot()) {
  let operation = publicationOperation(snapshot);
  let clock = fixedNow;
  let uuid = 100;
  const provider = {
    account: vi.fn<ListingPublicationProvider["account"]>(async () =>
      structuredClone(snapshot.account),
    ),
    taxonomy: vi.fn<ListingPublicationProvider["taxonomy"]>(async () => ({ productTypes: [], entries: [] })),
    requirements: vi.fn(),
    prepare: vi.fn<ListingPublicationProvider["prepare"]>(
      async (_account, input) =>
        structuredClone(
          snapshot.prepared.find(
            (item) => item.variantId === input.catalog.variantId,
          )!,
        ),
    ),
    submit: vi.fn<ListingPublicationProvider["submit"]>(async () => ({
      submissionId: "feed-1",
    })),
    status: vi.fn<ListingPublicationProvider["status"]>(async () => ({
      state: "processing",
      items: [],
    })),
    observe: vi.fn<ListingPublicationProvider["observe"]>(
      async (_account, sku) => ({
        item: {
          sku,
          title: "Card sleeves",
          externalProductId: `WPID-${sku}`,
          externalVariantId: sku,
          externalInventoryItemId: sku,
          lifecycleStatus: "ACTIVE",
          publishedStatus: "PUBLISHED",
        },
        priceCents: 1299,
      }),
    ),
  } satisfies ListingPublicationProvider;
  const journals: string[] = [];
  const store = {
    draft: vi.fn(async () => structuredClone(snapshot.draft)),
    saveDraft: vi.fn(),
    saveReview: vi.fn<ListingPublicationStore["saveReview"]>(async () => {}),
    review: vi.fn(async () => structuredClone(snapshot)),
    replay: vi.fn<ListingPublicationStore["replay"]>(async () => null),
    createOperation: vi.fn<ListingPublicationStore["createOperation"]>(
      async (input) => ({
        ...operation,
        id: input.id,
        snapshot: input.snapshot,
        progress: input.progress,
      }),
    ),
    operations: vi.fn(async () => [operation]),
    operation: vi.fn(async () => operation),
    claim: vi.fn<ListingPublicationStore["claim"]>(async () => null),
    renewLease: vi.fn<ListingPublicationStore["renewLease"]>(async () => {}),
    saveProgress: vi.fn<ListingPublicationStore["saveProgress"]>(
      async (prior, progress, options) => {
        journals.push(progress.batches[0].state);
        operation = {
          ...prior,
          progress: structuredClone(progress),
          state: summarizeListingProgress(progress),
          version: prior.version + 1,
          leaseToken: options.releaseLease ? null : prior.leaseToken,
        };
        return structuredClone(operation);
      },
    ),
    requestReconciliation: vi.fn(),
  } satisfies ListingPublicationStore;
  const link = vi.fn(async () => ({ linked: snapshot.catalog.length }));
  const inventory = {
    inspect: vi.fn<ListingPublicationDependencies["inventory"]["inspect"]>(
      async () => structuredClone(snapshot.review.inventory),
    ),
    submitZero: vi.fn<
      ListingPublicationDependencies["inventory"]["submitZero"]
    >(async (account, operationId, items, _review, submit) =>
      submit({
        operationId,
        publicationTargetId: 7,
        expectedTargetRevision: "2",
        channelId: account.channelId,
        channelConnectionId: account.connectionId,
        partnerId: account.accountId,
        environment: account.environment,
        shipNodeId: account.scopeId,
        items: items.map((item) => ({
          productVariantId: item.variantId,
          sku: item.sku,
          quantity: 0,
        })),
      }),
    ),
  };
  const catalog = {
    catalog: vi.fn<ListingPublicationDependencies["catalog"]["catalog"]>(
      async (_channelId, query) => {
        const selected = (query as { variantIds?: string }).variantIds
          ?.split(",")
          .map(Number);
        const items = structuredClone(
          snapshot.catalog.filter(
            (item) => !selected || selected.includes(item.variantId),
          ),
        );
        return { items, total: items.length, offset: 0, limit: 25 };
      },
    ),
    pricingRule: vi.fn(async () => null),
    savePricingRule: vi.fn(),
  };
  const dependencies = {
    store,
    provider: vi.fn(async () => provider),
    catalog,
    identities: vi.fn(async () => ({ link })),
    inventory,
    now: () => new Date(clock),
    uuid: () => testId(uuid++),
  } satisfies ListingPublicationDependencies;
  const service = new ListingPublicationService(dependencies);
  return {
    service,
    provider,
    store,
    catalog,
    inventory,
    dependencies,
    link,
    journals,
    get operation() {
      return operation;
    },
    setClock: (value: Date) => {
      clock = value;
    },
    run: async () => {
      store.claim.mockResolvedValueOnce(structuredClone(operation));
      return service.processDue(1);
    },
  };
}
const command = (snapshot: ListingSnapshot) => ({
  reviewId: snapshot.review.id,
  reviewHash: snapshot.review.reviewHash,
  commandKey: testId(50),
});
const result = (
  sku: string,
  state: "accepted" | "processing" | "needs_attention",
  retryable = false,
) => ({
  sku,
  state,
  retryable,
  externalProductId: null,
  issues:
    state === "needs_attention"
      ? [{ code: "DATA_ERROR", message: "Missing attribute", field: null }]
      : [],
});

function setupMixedFeeds() {
  const snapshot = publicationSnapshot([10, 11]);
  snapshot.prepared[1].feedType = "MP_ITEM_MATCH";
  snapshot.draft.items[1].method = "match";
  snapshot.review.items[1].method = "match";
  const h = setup(snapshot);
  h.operation.progress.batches = [
    { ...h.operation.progress.batches[0], variantIds: [10] },
    {
      ...h.operation.progress.batches[0],
      key: "match-batch",
      correlationId: testId(12),
      variantIds: [11],
    },
  ];
  h.provider.submit
    .mockResolvedValueOnce({ submissionId: "feed-create" })
    .mockResolvedValueOnce({ submissionId: "feed-match" });
  h.provider.status.mockImplementation(async (_account, submissionId) => ({
    state: "processed",
    items: [
      result(submissionId === "feed-create" ? "SKU-10" : "SKU-11", "accepted"),
    ],
  }));
  return h;
}

describe("ListingPublicationService exact reviewed intent", () => {
  it("returns provider taxonomy ancestry with the compatible flat product type list", async () => {
    const h = setup();
    const taxonomy = { productTypes: ["Exact Type"], entries: [{ productType: "Exact Type", path: ["Category", "Group"], description: null }] };
    h.provider.taxonomy.mockResolvedValue(taxonomy);
    await expect(h.service.taxonomy(104)).resolves.toEqual(taxonomy);
    expect(h.provider.taxonomy).toHaveBeenCalledWith(await h.provider.account(104));
    expect(h.provider.submit).not.toHaveBeenCalled();
  });
  it("rejects a provider taxonomy path whose leaf is absent from the allowed product type list", async () => {
    const h = setup();
    h.provider.taxonomy.mockResolvedValue({ productTypes: ["Allowed"], entries: [{ productType: "Unproven", path: ["Category"], description: null }] });
    await expect(h.service.taxonomy(104)).rejects.toThrow("Taxonomy paths must refer to a listed product type");
    expect(h.provider.submit).not.toHaveBeenCalled();
  });
  it("returns the original operation on a lost acknowledgement before reading changed provider state", async () => {
    const h = setup();
    h.store.replay.mockResolvedValueOnce(h.operation);
    expect(
      (await h.service.submit(104, command(h.operation.snapshot), "admin")).id,
    ).toBe(h.operation.id);
    expect(h.dependencies.provider).not.toHaveBeenCalled();
    expect(h.store.review).not.toHaveBeenCalled();
    expect(h.store.createOperation).not.toHaveBeenCalled();
  });
  it.each(["source", "account", "inventory-target", "inventory-revision"])(
    "rejects changed %s evidence before consuming the selection",
    async (change) => {
      const h = setup();
      if (change === "source")
        h.catalog.catalog.mockResolvedValueOnce({
          items: [
            {
              ...h.operation.snapshot.catalog[0],
              priceCents: 1300,
              sourceHash: "b".repeat(64),
            },
          ],
          total: 1,
          offset: 0,
          limit: 25,
        });
      if (change === "account")
        h.provider.account.mockResolvedValueOnce({
          ...h.operation.snapshot.account,
          revision: 2,
        });
      if (change === "inventory-target")
        h.inventory.inspect.mockResolvedValueOnce({
          ...h.operation.snapshot.review.inventory,
          targetId: "8",
        });
      if (change === "inventory-revision")
        h.inventory.inspect.mockResolvedValueOnce({
          ...h.operation.snapshot.review.inventory,
          targetRevision: "3",
        });
      await expect(
        h.service.submit(104, command(h.operation.snapshot), "admin"),
      ).rejects.toMatchObject({
        code:
          change === "account"
            ? "LISTING_ACCOUNT_CHANGED"
            : "LISTING_REVIEW_STALE",
      });
      expect(h.store.createOperation).not.toHaveBeenCalled();
      expect(h.provider.submit).not.toHaveBeenCalled();
    },
  );
  it("expires reviews at the exact boundary without contacting the provider", async () => {
    const h = setup();
    h.setClock(new Date(h.operation.snapshot.review.expiresAt));
    await expect(
      h.service.submit(104, command(h.operation.snapshot), "admin"),
    ).rejects.toMatchObject({ code: "LISTING_REVIEW_STALE" });
    expect(h.provider.account).not.toHaveBeenCalled();
  });
  it("records item blockers without preparing already linked or unpriced variants", async () => {
    const snapshot = publicationSnapshot([10, 11]);
    const h = setup(snapshot);
    snapshot.catalog[0].alreadyLinked = true;
    snapshot.catalog[1].priceCents = 0;
    const review = await h.service.review(
      104,
      { expectedRevision: 1 },
      "admin",
    );
    expect(review.canSubmit).toBe(false);
    expect(review.items.map((item) => item.issues[0].code)).toEqual([
      "LISTING_ALREADY_EXISTS",
      "LISTING_PRICE_REQUIRED",
    ]);
    expect(h.provider.prepare).not.toHaveBeenCalled();
    expect(h.store.saveReview).toHaveBeenCalledOnce();
  });
  it("requires canonical stock readiness for a publishable review", async () => {
    const h = setup();
    h.inventory.inspect.mockResolvedValue({
      ready: false,
      message: "Target needs review",
      targetId: "7",
      targetRevision: "2",
    });
    const review = await h.service.review(
      104,
      { expectedRevision: 1 },
      "admin",
    );
    expect(review.canSubmit).toBe(false);
    expect(review.issues[0].code).toBe("LISTING_STOCK_SETUP_REQUIRED");
    expect(h.provider.submit).not.toHaveBeenCalled();
  });
  it("loads offer-match requirements without requiring a new-item product type", async () => {
    const h = setup();
    await h.service.requirements(104, { method: "match", productType: "" });
    expect(h.provider.requirements).toHaveBeenCalledWith(
      h.operation.snapshot.account,
      "",
      "match",
    );
  });
});

describe("ListingPublicationService asynchronous worker", () => {
  it("journals submitting before quantity admission and preserves the saved correlation", async () => {
    const h = setup();
    await h.run();
    expect(h.journals[0]).toBe("submitting");
    expect(h.store.saveProgress.mock.invocationCallOrder[0]).toBeLessThan(
      h.inventory.submitZero.mock.invocationCallOrder[0],
    );
    expect(h.provider.submit.mock.calls[0][1]).toMatchObject({
      operationId: testId(2),
      correlationId: testId(2),
      zeroStockAdmission: {
        items: [{ productVariantId: 10, sku: "SKU-10", quantity: 0 }],
      },
    });
    expect(h.operation.progress.batches[0].submissionId).toBe("feed-1");
    expect(h.operation.progress.items[0].state).toBe("processing");
  });
  it("uses a distinct immutable quantity command for each separately submitted feed batch", async () => {
    const snapshot = publicationSnapshot([10, 11]);
    snapshot.prepared[1].feedType = "MP_ITEM_MATCH";
    const h = setup(snapshot);
    h.operation.progress.batches = [
      { ...h.operation.progress.batches[0], variantIds: [10] },
      {
        ...h.operation.progress.batches[0],
        key: "match-batch",
        correlationId: testId(12),
        variantIds: [11],
      },
    ];
    h.provider.submit
      .mockResolvedValueOnce({ submissionId: "feed-create" })
      .mockResolvedValueOnce({ submissionId: "feed-match" });
    await h.run();
    expect(h.inventory.submitZero.mock.calls.map((call) => call[1])).toEqual([
      testId(2),
      testId(12),
    ]);
    expect(
      h.provider.submit.mock.calls.map((call) => [
        call[1].operationId,
        call[1].zeroStockAdmission.operationId,
      ]),
    ).toEqual([
      [testId(2), testId(2)],
      [testId(12), testId(12)],
    ]);
    expect(
      h.operation.progress.batches.map((batch) => batch.submissionId),
    ).toEqual(["feed-create", "feed-match"]);
  });
  it("retains the queued match feed after a first-feed polling 429 and continues next run without resubmitting", async () => {
    const h = setupMixedFeeds();
    h.provider.status.mockRejectedValueOnce(
      new ChannelProviderError(
        "WALMART_HTTP_429",
        "Polling was throttled",
        true,
        429,
      ),
    );

    await h.run();
    expect(h.operation.progress.batches.map((batch) => batch.state)).toEqual([
      "processing",
      "queued",
    ]);
    expect(
      h.operation.progress.items.map((item) => [item.state, item.canRetry]),
    ).toEqual([
      ["processing", false],
      ["queued", false],
    ]);
    expect(h.operation.progress.error).toBe("Polling was throttled");
    expect(h.provider.submit).toHaveBeenCalledOnce();
    expect(h.operation.leaseToken).toBeNull();

    await h.run();
    expect(h.operation.state).toBe("completed");
    expect(h.operation.progress.error).toBeNull();
    expect(
      h.provider.submit.mock.calls.map((call) => call[1].correlationId),
    ).toEqual([testId(2), testId(12)]);
    expect(h.provider.status.mock.calls.map((call) => call[1])).toEqual([
      "feed-create",
      "feed-create",
      "feed-match",
    ]);
    expect(h.link).toHaveBeenCalledTimes(2);
  });
  it.each(["account", "catalog", "inventory"] as const)(
    "retains both queued batches after a transient %s preflight read failure",
    async (stage) => {
      const h = setupMixedFeeds();
      const failure = new Error("Temporary read connection failure");
      if (stage === "account")
        h.provider.account
          .mockResolvedValueOnce(h.operation.snapshot.account)
          .mockRejectedValueOnce(failure);
      if (stage === "catalog") h.catalog.catalog.mockRejectedValueOnce(failure);
      if (stage === "inventory")
        h.inventory.inspect.mockRejectedValueOnce(failure);

      await h.run();
      expect(h.operation.progress.batches.map((batch) => batch.state)).toEqual([
        "queued",
        "queued",
      ]);
      expect(
        h.operation.progress.items.every(
          (item) => item.state === "queued" && !item.canRetry,
        ),
      ).toBe(true);
      expect(h.inventory.submitZero).not.toHaveBeenCalled();
      expect(h.provider.submit).not.toHaveBeenCalled();
      expect(h.operation.leaseToken).toBeNull();

      await h.run();
      expect(h.operation.state).toBe("completed");
      expect(h.provider.submit).toHaveBeenCalledTimes(2);
      expect(h.link).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["observe", "link"] as const)(
    "preserves the next queued feed after an accepted item's %s failure",
    async (stage) => {
      const h = setupMixedFeeds();
      const failure = new Error("Temporary owner read failure");
      if (stage === "observe")
        h.provider.observe.mockRejectedValueOnce(failure);
      else h.link.mockRejectedValueOnce(failure);

      await h.run();
      expect(h.operation.progress.batches.map((batch) => batch.state)).toEqual([
        "processed",
        "queued",
      ]);
      expect(
        h.operation.progress.items.map((item) => [item.state, item.canRetry]),
      ).toEqual([
        ["accepted", false],
        ["queued", false],
      ]);
      expect(h.provider.submit).toHaveBeenCalledOnce();

      await h.run();
      expect(h.operation.state).toBe("completed");
      expect(h.provider.submit).toHaveBeenCalledTimes(2);
      expect(h.provider.status).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["source", "account-revision", "inventory", "currency"] as const)(
    "requires a fresh review only for the unsent batch with changed %s evidence",
    async (change) => {
      const h = setupMixedFeeds();
      if (change === "source")
        h.catalog.catalog.mockResolvedValueOnce({
          items: [
            { ...h.operation.snapshot.catalog[0], sourceHash: "c".repeat(64) },
          ],
          total: 1,
          offset: 0,
          limit: 25,
        });
      if (change === "account-revision")
        h.provider.account
          .mockResolvedValueOnce(h.operation.snapshot.account)
          .mockResolvedValueOnce({
            ...h.operation.snapshot.account,
            revision: 2,
          });
      if (change === "inventory")
        h.inventory.inspect.mockResolvedValueOnce({
          ...h.operation.snapshot.review.inventory,
          ready: false,
          message: "This selected variant is no longer ready",
        });
      if (change === "currency")
        h.catalog.catalog.mockRejectedValueOnce(
          new ListingPublicationError(
            "LISTING_CURRENCY_UNSUPPORTED",
            "This SKU's price is not in USD",
          ),
        );
      h.provider.submit
        .mockReset()
        .mockResolvedValue({ submissionId: "feed-match" });

      await h.run();
      expect(h.operation.state).toBe("partially_completed");
      expect(
        h.operation.progress.items.map((item) => [item.state, item.canRetry]),
      ).toEqual([
        ["needs_attention", true],
        ["verified", false],
      ]);
      expect(h.provider.submit).toHaveBeenCalledOnce();
      expect(h.provider.submit.mock.calls[0][1]).toMatchObject({
        correlationId: testId(12),
        items: [{ variantId: 11 }],
      });
      expect(
        (await h.service.retryItems(104, h.operation.id)).items.map(
          (item) => item.variantId,
        ),
      ).toEqual([10]);
    },
  );
  it("invalidates every queued batch for a different account without changing submitted evidence", async () => {
    const h = setupMixedFeeds();
    h.operation.progress.batches[0].state = "processing";
    h.operation.progress.batches[0].submissionId = "feed-create";
    h.operation.progress.items[0].state = "processing";
    const submittedBatch = structuredClone(h.operation.progress.batches[0]);
    const submittedItem = structuredClone(h.operation.progress.items[0]);
    h.provider.account.mockResolvedValue({
      ...h.operation.snapshot.account,
      accountId: "different-seller",
    });

    await h.run();
    expect(h.operation.progress.batches[0]).toEqual(submittedBatch);
    expect(h.operation.progress.items[0]).toEqual(submittedItem);
    expect(h.operation.progress.batches[1].state).toBe("processed");
    expect(h.operation.progress.items[1]).toMatchObject({
      state: "needs_attention",
      canRetry: true,
    });
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(h.provider.status).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
  });
  it("continues polling a processed feed while an item is under review", async () => {
    const h = setup();
    h.provider.status
      .mockResolvedValueOnce({
        state: "processed",
        items: [result("SKU-10", "processing")],
      })
      .mockResolvedValueOnce({
        state: "processed",
        items: [result("SKU-10", "accepted")],
      });
    await h.run();
    expect(h.operation.state).toBe("processing");
    expect(h.operation.progress.batches[0].state).toBe("processing");
    expect(h.link).not.toHaveBeenCalled();
    await h.run();
    expect(h.provider.status).toHaveBeenCalledTimes(2);
    expect(h.provider.submit).toHaveBeenCalledOnce();
    expect(h.operation.state).toBe("completed");
    expect(h.link).toHaveBeenCalledOnce();
  });
  it("links successful observed items and returns only rejected items for a separately reviewed retry", async () => {
    const h = setup(publicationSnapshot([10, 11]));
    h.provider.status.mockResolvedValue({
      state: "processed",
      items: [
        result("SKU-10", "accepted"),
        result("SKU-11", "needs_attention", true),
      ],
    });
    await h.run();
    expect(h.operation.state).toBe("partially_completed");
    expect(
      h.operation.progress.items.map((item) => [item.state, item.canRetry]),
    ).toEqual([
      ["verified", false],
      ["needs_attention", true],
    ]);
    expect(h.link).toHaveBeenCalledExactlyOnceWith(
      104,
      {
        mappings: [
          {
            sku: "SKU-10",
            productVariantId: 10,
            expectedExternalProductId: "WPID-SKU-10",
          },
        ],
      },
      "listing-publication-worker",
    );
    expect(
      (await h.service.retryItems(104, h.operation.id)).items.map(
        (item) => item.variantId,
      ),
    ).toEqual([11]);
    expect(h.provider.submit).toHaveBeenCalledOnce();
  });
  it("does not retry or link an item missing from terminal feed results", async () => {
    const h = setup();
    h.provider.status.mockResolvedValue({ state: "processed", items: [] });
    await h.run();
    expect(h.operation.progress.items[0]).toMatchObject({
      state: "needs_attention",
      canRetry: false,
    });
    expect(h.link).not.toHaveBeenCalled();
    expect(await h.service.retryItems(104, h.operation.id)).toEqual({
      items: [],
    });
    expect(h.operation.progress.batches[0].state).toBe("processing");
    h.provider.status.mockResolvedValueOnce({
      state: "processed",
      items: [result("SKU-10", "accepted")],
    });
    await h.run();
    expect(h.operation.state).toBe("completed");
    expect(h.provider.submit).toHaveBeenCalledOnce();
  });
  it("requires accepted feed and catalog product identities to agree before linking", async () => {
    const h = setup();
    h.provider.status.mockResolvedValue({
      state: "processed",
      items: [
        {
          ...result("SKU-10", "accepted"),
          externalProductId: "DIFFERENT-WPID",
        },
      ],
    });
    await h.run();
    expect(h.operation.state).toBe("needs_reconciliation");
    expect(h.operation.progress.items[0].canRetry).toBe(false);
    expect(h.link).not.toHaveBeenCalled();
    expect(h.operation.progress.items[0].error).toContain(
      "differs from the accepted feed identity",
    );
  });
  it("allows readback after credential rotation without permitting a new write", async () => {
    const h = setup();
    await h.run();
    h.provider.account.mockResolvedValue({
      ...h.operation.snapshot.account,
      revision: 2,
    });
    h.provider.status.mockResolvedValue({
      state: "processed",
      items: [result("SKU-10", "accepted")],
    });
    await h.run();
    expect(h.operation.state).toBe("completed");
    expect(h.provider.submit).toHaveBeenCalledOnce();
    expect(h.link).toHaveBeenCalledOnce();
  });
  it("requires the exact observed price and active lifecycle before linking", async () => {
    const h = setup();
    h.provider.status.mockResolvedValue({
      state: "processed",
      items: [result("SKU-10", "accepted")],
    });
    const observation = await h.provider.observe(
      h.operation.snapshot.account,
      "SKU-10",
    );
    h.provider.observe.mockClear();
    h.provider.observe.mockResolvedValueOnce({
      ...observation,
      priceCents: 1300,
    });
    await h.run();
    expect(h.operation.progress.items[0].state).toBe("accepted");
    expect(h.link).not.toHaveBeenCalled();
    h.provider.observe.mockResolvedValueOnce({
      ...observation,
      item: { ...observation.item, lifecycleStatus: "ARCHIVED" },
    });
    await h.run();
    expect(h.link).not.toHaveBeenCalled();
    await h.run();
    expect(h.operation.state).toBe("completed");
    expect(h.provider.submit).toHaveBeenCalledOnce();
  });
  it("never replays or adopts an uncertain submission without its feed receipt even when the SKU exists", async () => {
    const h = setup();
    h.provider.submit.mockRejectedValueOnce(
      new Error("connection reset after request sent"),
    );
    await h.run();
    expect(h.operation.state).toBe("needs_reconciliation");
    expect(h.operation.progress.items[0].canRetry).toBe(false);
    await h.run();
    expect(h.provider.submit).toHaveBeenCalledOnce();
    expect(h.provider.observe).toHaveBeenCalledOnce();
    expect(h.link).not.toHaveBeenCalled();
    expect(h.operation.progress.items[0].error).toContain(
      "submission receipt is missing",
    );
    expect(h.operation.state).toBe("needs_reconciliation");
  });
  it.each(["not_sent", "rejected"] as const)(
    "requires a new review after a proven %s failure",
    async (effect) => {
      const h = setup();
      h.provider.submit.mockRejectedValueOnce(
        new ListingSubmissionError(
          "WALMART_HTTP_429",
          "Provider rejected request",
          effect,
        ),
      );
      await h.run();
      expect(h.operation.state).toBe("needs_attention");
      expect(h.operation.progress.items[0].canRetry).toBe(true);
      await h.run();
      expect(h.provider.submit).toHaveBeenCalledOnce();
      expect(h.operation.progress.batches[0].state).toBe("processed");
      expect(
        (await h.service.retryItems(104, h.operation.id)).items,
      ).toHaveLength(1);
    },
  );
  it("does not quarantine a quantity admission denial before the provider callback was entered", async () => {
    const h = setup();
    h.inventory.submitZero.mockRejectedValueOnce(
      new Error("Admission scope is paused"),
    );
    await h.run();
    expect(h.operation.state).toBe("needs_attention");
    expect(h.operation.progress.items[0].canRetry).toBe(true);
    expect(h.provider.submit).not.toHaveBeenCalled();
  });
  it("continues verifying other successful items while one accepted SKU is not yet readable", async () => {
    const h = setup(publicationSnapshot([10, 11]));
    h.provider.status.mockResolvedValue({
      state: "processed",
      items: [result("SKU-10", "accepted"), result("SKU-11", "accepted")],
    });
    h.provider.observe.mockRejectedValueOnce(
      new ChannelProviderError(
        "WALMART_HTTP_404",
        "Not visible yet",
        true,
        404,
      ),
    );
    await h.run();
    expect(h.operation.progress.items.map((item) => item.state)).toEqual([
      "accepted",
      "verified",
    ]);
    expect(h.link).toHaveBeenCalledExactlyOnceWith(
      104,
      {
        mappings: [
          {
            sku: "SKU-11",
            productVariantId: 11,
            expectedExternalProductId: "WPID-SKU-11",
          },
        ],
      },
      "listing-publication-worker",
    );
  });
  it("stops an unsent batch after catalog changes and allows a fresh review", async () => {
    const h = setup();
    h.catalog.catalog.mockResolvedValue({
      items: [
        { ...h.operation.snapshot.catalog[0], sourceHash: "c".repeat(64) },
      ],
      total: 1,
      offset: 0,
      limit: 25,
    });
    await h.run();
    expect(h.operation.state).toBe("needs_attention");
    expect(h.operation.progress.items[0].canRetry).toBe(true);
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(h.inventory.submitZero).not.toHaveBeenCalled();
  });
  it("does not overwrite progress after losing the worker lease", async () => {
    const h = setup();
    h.store.saveProgress.mockRejectedValueOnce(
      new ListingPublicationError("LISTING_LEASE_LOST", "Lost lease"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await h.run()).toEqual({ processed: 0, failed: 1 });
      expect(h.provider.submit).not.toHaveBeenCalled();
      expect(h.store.saveProgress).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
