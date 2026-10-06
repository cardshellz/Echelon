import { describe, expect, it, vi } from "vitest";
import { ListingUpdateService } from "../../application/listing-update.service";
import type {
  ListingUpdateProvider,
  ListingUpdateStore,
  StoredListingUpdate,
} from "../../application/listing-update-ports";
import { ListingSubmissionError } from "../../application/listing-publication-provider.port";
import { ListingPublicationError, listingHash } from "../../domain/listing-publication";
import {
  fixedNow,
  testAccount,
  testId,
} from "../fixtures/listing-publication.fixture";
import {
  listingUpdateRecord,
  updateSource,
} from "../fixtures/listing-update.fixture";

function setup() {
  let current = listingUpdateRecord();
  let clock = fixedNow;
  const store = {
    insert: vi.fn<ListingUpdateStore["insert"]>(async (record) => {
      current = structuredClone(record);
    }),
    get: vi.fn<ListingUpdateStore["get"]>(async () => structuredClone(current)),
    list: vi.fn<ListingUpdateStore["list"]>().mockResolvedValue([]),
    lastSubmitted: vi
      .fn<ListingUpdateStore["lastSubmitted"]>()
      .mockResolvedValue(null),
    acceptedPrice: vi
      .fn<ListingUpdateStore["acceptedPrice"]>()
      .mockResolvedValue(null),
    queue: vi.fn<ListingUpdateStore["queue"]>(async (record, commandKey) => {
      current = {
        ...record,
        commandKey,
        version: record.version + 1,
        view: { ...record.view, state: "queued" },
      };
      return structuredClone(current);
    }),
    claim: vi.fn<ListingUpdateStore["claim"]>().mockResolvedValue(null),
    renew: vi.fn<ListingUpdateStore["renew"]>().mockResolvedValue(undefined),
    progress: vi.fn<ListingUpdateStore["progress"]>(
      async (record, state, submissionId, message) => {
        current = {
          ...record,
          version: record.version + 1,
          view: { ...record.view, state, submissionId, message },
        };
        return structuredClone(current);
      },
    ),
    refresh: vi.fn<ListingUpdateStore["refresh"]>(async () =>
      structuredClone(current),
    ),
  } satisfies ListingUpdateStore;
  const provider = {
    account: vi
      .fn<ListingUpdateProvider["account"]>()
      .mockResolvedValue(testAccount),
    observe: vi
      .fn<ListingUpdateProvider["observe"]>()
      .mockResolvedValue(updateSource),
    taxonomy: vi.fn<ListingUpdateProvider["taxonomy"]>(),
    requirements: vi
      .fn<ListingUpdateProvider["requirements"]>()
      .mockResolvedValue({}),
    prepare: vi
      .fn<ListingUpdateProvider["prepare"]>()
      .mockResolvedValue(current.intent.prepared),
    send: vi.fn<ListingUpdateProvider["send"]>(
      async (_intent, _id, beforeSend) => {
        await beforeSend();
        return "feed@US";
      },
    ),
    status: vi
      .fn<ListingUpdateProvider["status"]>()
      .mockResolvedValue({ state: "accepted", message: "Walmart accepted" }),
  } satisfies ListingUpdateProvider;
  const service = new ListingUpdateService({
    store,
    provider,
    now: () => clock,
    uuid: () => testId(1),
  });
  return {
    service,
    store,
    provider,
    get: () => current,
    set: (record: StoredListingUpdate) => {
      current = structuredClone(record);
    },
    clock: (now: Date) => {
      clock = now;
    },
    claim: () =>
      store.claim.mockResolvedValueOnce({
        ...structuredClone(current),
        leaseToken: testId(8),
      }),
    submit: () =>
      service.submit(
        104,
        current.view.id,
        { reviewHash: current.view.reviewHash, commandKey: testId(2) },
        "operator",
      ),
  };
}

describe("reviewed existing-listing updates", () => {
  it.each([{}, { attributes: {} }, { attributes: { Visible: {}, Orderable: {} } }])(
    "rejects empty category corrections before storing or sending a feed: %j",
    async (changes) => {
      const s = setup();
      const source = { ...updateSource, productType: "default" };
      s.provider.observe.mockResolvedValue(source);
      await expect(s.service.review(104, {
        ...s.get().intent.command,
        sourceHash: listingHash({ account: testAccount, current: source }),
        changes,
      }, "operator")).rejects.toMatchObject({ code: "LISTING_UPDATE_EMPTY" });
      expect(s.store.insert).not.toHaveBeenCalled();
      expect(s.provider.prepare).not.toHaveBeenCalled();
      expect(s.provider.send).not.toHaveBeenCalled();
    },
  );
  it("checks an accepted feed against the exact current item without writing or resubmitting", async () => {
    const s = setup();
    const record = s.get();
    record.view.state = "accepted";
    record.view.submissionId = "feed@US";
    s.set(record);
    s.provider.observe.mockResolvedValue({ ...updateSource, productType: "default" });
    const mismatch = await s.service.verify(104, record.view.id);
    expect(mismatch).toMatchObject({
      categoryMatches: false,
      requestedProductType: updateSource.productType,
      current: { productType: "default", publishedStatus: "SYSTEM_PROBLEM" },
      checkedAt: fixedNow.toISOString(),
    });
    s.provider.observe.mockResolvedValue(updateSource);
    const matched = await s.service.verify(104, record.view.id);
    expect(matched.categoryMatches).toBe(true);
    // Matching classification is not proof of a published listing.
    expect(matched.current.publishedStatus).toBe("SYSTEM_PROBLEM");
    expect(s.store.progress).not.toHaveBeenCalled();
    expect(s.store.refresh).not.toHaveBeenCalled();
    expect(s.provider.send).not.toHaveBeenCalled();
  });
  it.each(["sku", "externalProductId", "identifier"] as const)(
    "rejects %s drift during item verification", async (field) => {
      const s = setup();
      const record = s.get(); record.view.state = "accepted"; record.view.submissionId = "feed@US"; s.set(record);
      s.provider.observe.mockResolvedValue({ ...updateSource, [field]: field === "identifier" ? { type: "GTIN", value: "other" } : "other" });
      await expect(s.service.verify(104, record.view.id)).rejects.toMatchObject({ code: "LISTING_UPDATE_PRODUCT_CHANGED" });
    },
  );
  it("allows same-account credential rotation, but rejects another account and unaccepted updates", async () => {
    const s = setup();
    await expect(s.service.verify(104, s.get().view.id)).rejects.toMatchObject({ code: "LISTING_UPDATE_NOT_ACCEPTED" });
    expect(s.provider.observe).not.toHaveBeenCalled();
    const record = s.get(); record.view.state = "accepted"; record.view.submissionId = "feed@US"; s.set(record);
    s.provider.account.mockResolvedValue({ ...testAccount, revision: testAccount.revision + 1 });
    await expect(s.service.verify(104, record.view.id)).resolves.toMatchObject({ categoryMatches: true });
    s.provider.observe.mockClear();
    s.provider.account.mockResolvedValue({ ...testAccount, accountId: "other" });
    await expect(s.service.verify(104, record.view.id)).rejects.toMatchObject({ code: "LISTING_UPDATE_STALE" });
    expect(s.provider.observe).not.toHaveBeenCalled();
  });
  it("surfaces failed item readback without changing accepted evidence", async () => {
    const s = setup();
    const record = s.get(); record.view.state = "accepted"; record.view.submissionId = "feed@US"; s.set(record);
    s.provider.observe.mockRejectedValue(new Error("readback unavailable"));
    await expect(s.service.verify(104, record.view.id)).rejects.toThrow("readback unavailable");
    expect(s.get().view.state).toBe("accepted");
    expect(s.provider.send).not.toHaveBeenCalled();
  });
  it("reads current provider title/price while labeling other fields as last submitted", async () => {
    const { service, store, provider } = setup();
    provider.observe.mockResolvedValue({
      ...updateSource,
      productType: "default",
    });
    store.lastSubmitted.mockResolvedValue({
      productType: updateSource.productType,
      changes: { description: "Last submitted content" },
    });
    const result = await service.context(104, updateSource.sku);
    expect(result.current.productType).toBe("default");
    expect(result.suggestedProductType).toBe(updateSource.productType);
    expect(result.lastSubmitted?.description).toBe("Last submitted content");
    expect(result.current.title).toBe(updateSource.title);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("stores an immutable review without writing to Walmart and queues only that review", async () => {
    const s = setup();
    const result = await s.service.review(
      104,
      s.get().intent.command,
      "operator",
    );
    expect(s.store.insert).toHaveBeenCalledOnce();
    expect(s.provider.send).not.toHaveBeenCalled();
    expect(result.issues).toEqual([]);
    await expect(s.submit()).resolves.toMatchObject({ state: "queued" });
    expect(s.store.queue).toHaveBeenCalledWith(
      expect.objectContaining({ view: result }),
      testId(2),
      "operator",
      fixedNow,
    );
  });
  it("rejects stale source and empty changes before storing a review", async () => {
    const s = setup();
    await expect(
      s.service.review(
        104,
        { ...s.get().intent.command, sourceHash: "b".repeat(64) },
        "operator",
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_STALE" });
    await expect(
      s.service.review(
        104,
        { ...s.get().intent.command, changes: {} },
        "operator",
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_EMPTY" });
    expect(s.store.insert).not.toHaveBeenCalled();
  });
  it.each(["expired", "invalid", "mismatched", "account", "source"])(
    "blocks %s review submission",
    async (failure) => {
      const s = setup();
      if (failure === "expired")
        s.clock(new Date(fixedNow.getTime() + 900_001));
      if (failure === "invalid") {
        const record = s.get();
        record.view.issues = [
          { code: "INVALID", field: "price", message: "Invalid price" },
        ];
        s.set(record);
      }
      if (failure === "mismatched") {
        await expect(
          s.service.submit(
            104,
            testId(1),
            { reviewHash: "f".repeat(64), commandKey: testId(2) },
            "operator",
          ),
        ).rejects.toMatchObject({ code: "LISTING_UPDATE_REVIEW_CHANGED" });
      } else {
        if (failure === "account")
          s.provider.account.mockResolvedValue({ ...testAccount, revision: 2 });
        if (failure === "source")
          s.provider.observe.mockResolvedValue({
            ...updateSource,
            priceCents: 3099,
          });
        await expect(s.submit()).rejects.toBeInstanceOf(
          ListingPublicationError,
        );
      }
      expect(s.store.queue).not.toHaveBeenCalled();
      expect(s.provider.send).not.toHaveBeenCalled();
    },
  );
  it("returns the same durable update after a lost response even after the source changes", async () => {
    const s = setup();
    await s.submit();
    s.provider.account.mockRejectedValue(new Error("Now offline"));
    await expect(s.submit()).resolves.toMatchObject({
      state: "queued",
      id: testId(1),
    });
    expect(s.store.queue).toHaveBeenCalledOnce();
    await expect(
      s.service.submit(
        104,
        testId(1),
        { reviewHash: s.get().view.reviewHash, commandKey: testId(3) },
        "operator",
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_ALREADY_SENT" });
  });
  it("journals sending and renews the lease before the provider write, then records its receipt and status", async () => {
    const s = setup();
    await s.submit();
    s.claim();
    s.provider.send.mockImplementation(async (_intent, _id, beforeSend) => {
      expect(s.get().view.state).toBe("sending");
      await beforeSend();
      expect(s.store.renew).toHaveBeenCalledOnce();
      return "feed@US";
    });
    await expect(s.service.processDue()).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    expect(s.get().view).toMatchObject({
      state: "accepted",
      submissionId: "feed@US",
    });
    expect(s.provider.status).toHaveBeenCalledWith(
      testAccount,
      "feed@US",
      updateSource.sku,
      updateSource.externalProductId,
    );
  });
  it.each(["not_sent", "rejected", "uncertain"] as const)(
    "records %s without replay",
    async (effect) => {
      const s = setup();
      await s.submit();
      s.claim();
      s.provider.send.mockRejectedValue(
        new ListingSubmissionError("FAIL", "Failure", effect),
      );
      await s.service.processDue();
      await s.service.processDue();
      expect(s.get().view.state).toBe(
        effect === "uncertain" ? "uncertain" : "needs_attention",
      );
      expect(s.provider.send).toHaveBeenCalledOnce();
      expect(s.provider.status).not.toHaveBeenCalled();
    },
  );
  it("does not replay a sending attempt whose lease was recovered as uncertain", async () => {
    const s = setup();
    await s.submit();
    const record = s.get();
    record.view.state = "uncertain";
    s.set(record);
    s.claim();
    await s.service.processDue();
    expect(s.provider.send).not.toHaveBeenCalled();
  });
  it("status checks poll only the requested receipted update, never queued submissions", async () => {
    const s = setup();
    await s.submit();
    await s.service.refresh(104, testId(1), "operator");
    expect(s.store.claim).not.toHaveBeenCalled();
    const record = s.get();
    record.view.state = "processing";
    record.view.submissionId = "feed@US";
    s.set(record);
    s.claim();
    await expect(
      s.service.refresh(104, testId(1), "operator"),
    ).resolves.toMatchObject({ state: "accepted" });
    expect(s.store.claim).toHaveBeenCalledWith(testId(1), fixedNow, testId(1));
    expect(s.provider.send).not.toHaveBeenCalled();
  });
  it("retains the processing receipt through transient status failures", async () => {
    const s = setup();
    await s.submit();
    s.claim();
    s.provider.status.mockRejectedValue(new Error("Offline"));
    await s.service.processDue();
    expect(s.get().view).toMatchObject({
      state: "processing",
      submissionId: "feed@US",
    });
    s.provider.status.mockResolvedValue({
      state: "accepted",
      message: "Accepted",
    });
    s.claim();
    await s.service.processDue();
    expect(s.get().view.state).toBe("accepted");
    expect(s.provider.send).toHaveBeenCalledOnce();
  });
  it("cannot downgrade a failed receipt commit to queued or resend after lease loss", async () => {
    const s = setup();
    await s.submit();
    s.claim();
    const progress = s.store.progress.getMockImplementation()!;
    s.store.progress.mockImplementation(async (...args) => {
      if (args[1] === "processing")
        throw new ListingPublicationError(
          "LISTING_UPDATE_LEASE_LOST",
          "Lost lease",
        );
      return progress(...args);
    });
    await s.service.processDue();
    expect(s.get().view.state).toBe("sending");
    expect(s.provider.send).toHaveBeenCalledOnce();
    expect(s.store.progress.mock.calls.map((call) => call[1])).toEqual([
      "sending",
      "processing",
    ]);
  });
});
