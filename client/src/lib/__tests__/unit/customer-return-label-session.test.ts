import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_RETURN_LABEL_API,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import {
  CustomerReturnLabelSession,
  type ReturnLabelSessionRecord,
} from "../../customer-return-label-session";
import {
  ReturnLabelRequestError,
  type CustomerReturnLabelTransport,
} from "../../customer-return-labels";
import { PreviewAccessError } from "../../customer-return-preview";

const channelId = 7;
const authorizationId = 123;
const commandKey = "dc9b329b-b250-46a1-9b20-3d3149a2846d";
const adminId = "admin/a@example.test";
const storageKey = `return-label-session:${encodeURIComponent(adminId)}`;
type SubmitIntent = Omit<CustomerReturnLabelSubmitInput, "idempotencyKey">;
type ParcelStatus = CustomerReturnLabelStatus["parcels"][number]["status"];

function intent(): SubmitIntent {
  return {
    channelId,
    settingsVersion: 2,
    sourceRevision: "a".repeat(64),
    orderReference: "#PRIVATE-ORDER-1001",
    selections: [
      { lineId: "private-line-a", quantity: 3, reasonCode: "damaged" },
    ],
    parcels: [1, 2, 3].map(() => ({
      dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 },
      originalBoxId: "private-original-box",
      items: [{ lineId: "private-line-a", quantity: 1 }],
    })),
  };
}

function status(
  states: ParcelStatus[],
  canProgress = true,
): CustomerReturnLabelStatus {
  return {
    channelId,
    authorizationId,
    authorizationNumber: "RMA-PRIVATE-123",
    canProgress,
    parcels: states.map((state, index) => ({
      parcelId: 31 + index,
      number: index + 1,
      status: state,
      trackingNumber: state === "ready" ? `PRIVATE-TRACK-${index}` : null,
      downloadPath:
        state === "ready"
          ? `${CUSTOMER_RETURN_LABEL_API}/labels/7/123/parcels/${31 + index}/download`
          : null,
    })),
  };
}

function record(
  knownAuthorization: number | null = null,
): ReturnLabelSessionRecord {
  return {
    channelId,
    idempotencyKey: commandKey,
    authorizationId: knownAuthorization,
  };
}

function storageFixture(saved?: ReturnLabelSessionRecord) {
  const values = new Map<string, string>();
  if (saved) values.set(storageKey, JSON.stringify(saved));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  return { values, storage };
}

function fixture(saved?: ReturnLabelSessionRecord) {
  const { storage, values } = storageFixture(saved);
  const api = {
    submit: vi.fn<CustomerReturnLabelTransport["submit"]>(),
    status: vi.fn<CustomerReturnLabelTransport["status"]>(),
    byCommand: vi.fn<CustomerReturnLabelTransport["byCommand"]>(),
    resume: vi.fn<CustomerReturnLabelTransport["resume"]>(),
    progress: vi.fn<CustomerReturnLabelTransport["progress"]>(),
  };
  const transport = vi.fn(
    (_channelId: number): CustomerReturnLabelTransport => api,
  );
  const denied = vi.fn<(message: string) => void>();
  const newKey = vi.fn(() => commandKey);
  const session = new CustomerReturnLabelSession(
    adminId,
    storage,
    transport,
    denied,
    newKey,
  );
  return { session, storage, values, api, transport, denied, newKey };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("return label session persistence and identity", () => {
  it("persists only admin-scoped recovery metadata before submitting and after acceptance", async () => {
    const f = fixture();
    const accepted = status(["ready", "ready", "ready"], false);
    f.api.submit.mockImplementation(async () => {
      expect(f.values.get(storageKey)).toBe(JSON.stringify(record()));
      return accepted;
    });
    await f.session.begin(intent());

    expect(f.storage.getItem).toHaveBeenCalledWith(storageKey);
    expect(f.storage.setItem.mock.calls).toEqual([
      [storageKey, JSON.stringify(record())],
      [storageKey, JSON.stringify(record(authorizationId))],
    ]);
    expect(f.transport).toHaveBeenCalledWith(channelId);
    expect(f.session.getSnapshot()).toMatchObject({
      record: record(authorizationId),
      status: accepted,
      busy: false,
      error: null,
    });
    const otherAdmin = new CustomerReturnLabelSession(
      "another-admin",
      f.storage,
      f.transport,
      f.denied,
      f.newKey,
    );
    expect(otherAdmin.getSnapshot().record).toBeNull();
    expect(f.values.size).toBe(1);
  });

  it("retries the identical immutable intent and key after an unconfirmed network loss", async () => {
    const f = fixture();
    f.api.submit
      .mockRejectedValueOnce(new TypeError("Network lost"))
      .mockResolvedValueOnce(status(["ready", "ready", "ready"], false));
    const draft = intent();
    const original = structuredClone(draft);
    await f.session.begin(draft);
    expect(f.session.getSnapshot()).toMatchObject({
      record: record(),
      status: null,
      busy: false,
      error: "Network lost",
    });

    draft.orderReference = "#DIFFERENT";
    draft.parcels[0].items[0].quantity = 99;
    await f.session.begin(intent());
    expect(f.api.submit).toHaveBeenCalledTimes(1);
    await f.session.check();

    expect(f.newKey).toHaveBeenCalledTimes(1);
    expect(f.api.submit).toHaveBeenCalledTimes(2);
    expect(f.api.submit.mock.calls[0][0]).toEqual({
      ...original,
      idempotencyKey: commandKey,
    });
    expect(f.api.submit.mock.calls[1][0]).toBe(f.api.submit.mock.calls[0][0]);
    expect(f.api.submit.mock.calls[1][1]).not.toBe(
      f.api.submit.mock.calls[0][1],
    );
    expect(f.api.resume).not.toHaveBeenCalled();
  });

  it("coalesces begin/check/restore while a request is in flight", async () => {
    const f = fixture();
    const pending = deferred<CustomerReturnLabelStatus>();
    f.api.submit.mockReturnValue(pending.promise);
    const first = f.session.begin(intent());
    expect(f.session.getSnapshot().busy).toBe(true);
    await Promise.all([
      f.session.begin(intent()),
      f.session.check(),
      f.session.restore(),
    ]);
    expect(f.api.submit).toHaveBeenCalledTimes(1);
    expect(f.api.byCommand).not.toHaveBeenCalled();
    pending.resolve(status(["ready", "ready", "ready"], false));
    await first;
    expect(f.session.getSnapshot().busy).toBe(false);
  });

  it("blocks submission when the recovery key cannot be stored", async () => {
    const f = fixture();
    f.storage.setItem.mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    await f.session.begin(intent());
    expect(f.session.getSnapshot()).toMatchObject({
      record: null,
      status: null,
      storageBlocked: true,
      busy: false,
    });
    expect(f.session.getSnapshot().error).toContain(
      "cannot save a recovery key",
    );
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
  });

  it.each([
    "{bad json",
    JSON.stringify({ ...record(), orderReference: "private-order" }),
    JSON.stringify({ ...record(), channelId: 0 }),
  ])(
    "freezes an invalid saved session without replacing its recovery record",
    async (saved) => {
      const f = fixture();
      f.values.set(storageKey, saved);
      const session = new CustomerReturnLabelSession(
        adminId,
        f.storage,
        f.transport,
        f.denied,
        f.newKey,
      );
      await session.begin(intent());
      expect(session.getSnapshot().storageBlocked).toBe(true);
      expect(f.values.get(storageKey)).toBe(saved);
      expect(f.api.submit).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it("fails closed when session storage is unavailable or unreadable", async () => {
    const f = fixture();
    f.storage.getItem.mockImplementation(() => {
      throw new Error("Access denied");
    });
    for (const storage of [null, f.storage]) {
      const session = new CustomerReturnLabelSession(
        adminId,
        storage,
        f.transport,
        f.denied,
        f.newKey,
      );
      await session.begin(intent());
      expect(session.getSnapshot().storageBlocked).toBe(true);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects invalid drafts and key generation failures before storage or HTTP effects", async () => {
    const f = fixture();
    await f.session.begin({ ...intent(), parcels: [] });
    f.newKey.mockImplementation(() => {
      throw new Error("Random source unavailable");
    });
    await f.session.begin(intent());
    expect(f.session.getSnapshot().error).toContain("could not be verified");
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("retains the original persisted command if saving accepted metadata fails", async () => {
    const f = fixture();
    f.api.submit.mockResolvedValue(status(["ready", "ready", "ready"], false));
    f.storage.setItem
      .mockImplementationOnce((key, value) => {
        f.values.set(key, value);
      })
      .mockImplementationOnce(() => {
        throw new Error("Quota exceeded");
      });
    await f.session.begin(intent());
    expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
    expect(f.session.getSnapshot().error).toContain(
      "could not save the latest",
    );
    expect(f.values.get(storageKey)).toBe(JSON.stringify(record()));
  });
});

describe("bounded return label progression", () => {
  it("preserves successful labels and advances pending parcels sequentially once", async () => {
    const f = fixture();
    const firstProgress = deferred<CustomerReturnLabelStatus>();
    f.api.submit.mockResolvedValue(status(["ready", "pending", "pending"]));
    f.api.progress
      .mockReturnValueOnce(firstProgress.promise)
      .mockResolvedValueOnce(status(["ready", "ready", "ready"], false));
    const begin = f.session.begin(intent());
    await vi.waitFor(() => expect(f.api.progress).toHaveBeenCalledTimes(1));
    expect(f.session.getSnapshot().status?.parcels[0].trackingNumber).toBe(
      "PRIVATE-TRACK-0",
    );
    expect(f.session.getSnapshot().busy).toBe(true);

    firstProgress.resolve(status(["ready", "ready", "pending"]));
    await begin;
    expect(f.api.progress).toHaveBeenCalledTimes(2);
    expect(f.api.progress.mock.calls.map(([id]) => id)).toEqual([
      authorizationId,
      authorizationId,
    ]);
    expect(
      f.api.progress.mock.calls.every(
        ([, signal]) => signal === f.api.submit.mock.calls[0][1],
      ),
    ).toBe(true);
    expect(f.api.submit).toHaveBeenCalledTimes(1);
    expect(
      f.session
        .getSnapshot()
        .status?.parcels.every((parcel) => parcel.status === "ready"),
    ).toBe(true);
  });

  it("stops after one attempt when the same parcel remains pending", async () => {
    const f = fixture();
    f.api.submit.mockResolvedValue(status(["ready", "pending", "pending"]));
    f.api.progress.mockResolvedValue(status(["ready", "pending", "pending"]));
    await f.session.begin(intent());
    expect(f.api.progress).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot().busy).toBe(false);
  });

  it.each<ParcelStatus>(["processing", "needs_review"])(
    "stops automatic progression at %s and keeps remaining parcels pending",
    async (unknown) => {
      const f = fixture();
      f.api.submit.mockResolvedValue(status(["ready", "pending", "pending"]));
      f.api.progress.mockResolvedValue(status(["ready", unknown, "pending"]));
      await f.session.begin(intent());
      expect(f.api.progress).toHaveBeenCalledTimes(1);
      expect(
        f.session.getSnapshot().status?.parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", unknown, "pending"]);
      expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
    },
  );

  it.each<ParcelStatus>(["processing", "needs_review"])(
    "never automatically retries an initially accepted %s purchase",
    async (unknown) => {
      const f = fixture();
      f.api.submit.mockResolvedValue(status(["ready", unknown, "pending"]));
      await f.session.begin(intent());
      expect(f.api.progress).not.toHaveBeenCalled();
    },
  );

  it("honors a disabled progress capability even with pending parcels", async () => {
    const f = fixture();
    f.api.submit.mockResolvedValue(
      status(["ready", "pending", "pending"], false),
    );
    await f.session.begin(intent());
    f.api.status.mockResolvedValue(
      status(["ready", "needs_review", "pending"], false),
    );
    await f.session.check();
    expect(f.api.progress).not.toHaveBeenCalled();
  });

  it("makes exactly one explicit recovery attempt if an unknown outcome stays unknown", async () => {
    const f = fixture(record(authorizationId));
    f.api.status.mockResolvedValue(
      status(["ready", "needs_review", "pending"]),
    );
    f.api.progress.mockResolvedValue(
      status(["ready", "processing", "pending"]),
    );
    await f.session.check();
    expect(f.api.status).toHaveBeenCalledTimes(1);
    expect(f.api.progress).toHaveBeenCalledTimes(1);
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().status?.parcels[1].status).toBe(
      "processing",
    );
  });

  it("continues remaining pending parcels only after explicit recovery confirms the uncertain label", async () => {
    const f = fixture(record(authorizationId));
    f.api.status.mockResolvedValue(
      status(["ready", "needs_review", "pending"]),
    );
    f.api.progress
      .mockResolvedValueOnce(status(["ready", "ready", "pending"]))
      .mockResolvedValueOnce(status(["ready", "ready", "ready"], false));
    await f.session.check();
    expect(f.api.progress).toHaveBeenCalledTimes(2);
    expect(
      f.session
        .getSnapshot()
        .status?.parcels.every((parcel) => parcel.status === "ready"),
    ).toBe(true);
  });

  it("retains accepted labels and the recovery record when progression loses its response", async () => {
    const f = fixture();
    const accepted = status(["ready", "pending", "pending"]);
    f.api.submit.mockResolvedValue(accepted);
    f.api.progress.mockRejectedValue(
      new TypeError("Connection lost after purchase"),
    );
    await f.session.begin(intent());
    expect(f.session.getSnapshot()).toMatchObject({
      record: record(authorizationId),
      status: accepted,
      busy: false,
      error: "Connection lost after purchase",
    });
    expect(f.api.progress).toHaveBeenCalledTimes(1);
    expect(f.values.get(storageKey)).toBe(
      JSON.stringify(record(authorizationId)),
    );
  });
});

describe("return session reload and recovery", () => {
  it("looks up a saved command read-only on reload and uses resume only on explicit Check", async () => {
    const f = fixture(record());
    f.api.byCommand.mockRejectedValue(
      new ReturnLabelRequestError(
        "RETURN_LABEL_SUBMISSION_NOT_FOUND",
        "Not confirmed",
      ),
    );
    f.api.resume.mockResolvedValue(status(["ready", "ready", "ready"], false));
    await f.session.restore();
    expect(f.api.byCommand).toHaveBeenCalledWith(
      commandKey,
      expect.any(AbortSignal),
    );
    expect(f.api.resume).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().record).toEqual(record());

    await f.session.check();
    expect(f.api.resume).toHaveBeenCalledWith(
      commandKey,
      expect.any(AbortSignal),
    );
    expect(f.api.resume).toHaveBeenCalledTimes(1);
    expect(f.newKey).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
  });

  it("restores a known authorization without automatically progressing pending work", async () => {
    const f = fixture(record(authorizationId));
    f.api.status.mockResolvedValue(status(["ready", "pending", "pending"]));
    await f.session.restore();
    await f.session.restore();
    expect(f.api.status).toHaveBeenCalledTimes(1);
    expect(f.api.status).toHaveBeenCalledWith(
      authorizationId,
      expect.any(AbortSignal),
    );
    expect(f.api.progress).not.toHaveBeenCalled();
    expect(f.api.byCommand).not.toHaveBeenCalled();
  });

  it("accepts a command lookup without automatically continuing its pending purchases", async () => {
    const f = fixture(record());
    f.api.byCommand.mockResolvedValue(status(["ready", "pending", "pending"]));
    await f.session.restore();
    expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
    expect(f.api.progress).not.toHaveBeenCalled();
    expect(f.api.resume).not.toHaveBeenCalled();
  });

  it.each([
    "RETURN_LABEL_SUBMISSION_NOT_FOUND",
    "RETURN_LABEL_SUBMISSION_PROCESSING",
    "RETURN_LABEL_REQUEST_FAILED",
  ])(
    "freezes the same command after %s and prevents starting another return",
    async (code) => {
      const f = fixture(record());
      f.api.byCommand.mockRejectedValue(
        new ReturnLabelRequestError(code, "Unconfirmed"),
      );
      await f.session.restore();
      await f.session.begin(intent());
      f.session.finish();
      expect(f.session.getSnapshot()).toMatchObject({
        record: record(),
        status: null,
        error: "Unconfirmed",
        revision: 0,
      });
      expect(f.values.get(storageKey)).toBe(JSON.stringify(record()));
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(f.api.submit).not.toHaveBeenCalled();
    },
  );

  it("clears an explicitly rejected command with no known authorization and allows a fresh reviewed attempt", async () => {
    const f = fixture(record());
    f.api.byCommand.mockRejectedValue(
      new ReturnLabelRequestError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        "Review again",
      ),
    );
    await f.session.restore();
    expect(f.session.getSnapshot()).toMatchObject({
      record: null,
      status: null,
      error: "Review again",
      revision: 1,
    });
    expect(f.values.has(storageKey)).toBe(false);
    f.api.submit.mockResolvedValue(status(["ready", "ready", "ready"], false));
    await f.session.begin(intent());
    expect(f.api.submit).toHaveBeenCalledTimes(1);
  });

  it("does not erase an accepted return even if a later read reports rejection", async () => {
    const f = fixture(record(authorizationId));
    f.api.status.mockRejectedValue(
      new ReturnLabelRequestError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        "Unexpected rejection",
      ),
    );
    await f.session.restore();
    expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });

  it("keeps a rejected command frozen when clearing storage fails", async () => {
    const f = fixture(record());
    f.api.byCommand.mockRejectedValue(
      new ReturnLabelRequestError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        "Review again",
      ),
    );
    f.storage.removeItem.mockImplementation(() => {
      throw new Error("Storage denied");
    });
    await f.session.restore();
    expect(f.session.getSnapshot().record).toEqual(record());
    expect(f.session.getSnapshot().error).toContain("could not be cleared");
    expect(f.session.getSnapshot().revision).toBe(0);
  });

  it.each(["channel", "authorization"])(
    "rejects a mismatched %s on restore without overwriting its recovery record",
    async (mismatch) => {
      const f = fixture(record(authorizationId));
      const value = status(["ready", "ready", "ready"], false);
      if (mismatch === "channel") value.channelId = 8;
      else value.authorizationId = 124;
      f.api.status.mockResolvedValue(value);
      await f.session.restore();
      expect(f.session.getSnapshot().status).toBeNull();
      expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
      expect(f.session.getSnapshot().error).toContain("did not match");
      expect(f.storage.setItem).not.toHaveBeenCalled();
    },
  );

  it("notifies the access boundary and preserves recovery metadata after access loss", async () => {
    const f = fixture(record());
    f.api.byCommand.mockRejectedValue(new PreviewAccessError("Sign in again"));
    await f.session.restore();
    expect(f.denied).toHaveBeenCalledWith("Sign in again");
    expect(f.session.getSnapshot().record).toEqual(record());
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().busy).toBe(false);
  });
});

describe("return session lifecycle", () => {
  it("aborts on unmount, keeps the command, and ignores a late successful response", async () => {
    const f = fixture();
    const pending = deferred<CustomerReturnLabelStatus>();
    f.api.submit.mockReturnValue(pending.promise);
    const listener = vi.fn();
    f.session.subscribe(listener);
    const begin = f.session.begin(intent());
    const signal = f.api.submit.mock.calls[0][1];
    const notifications = listener.mock.calls.length;
    const beforeDispose = f.session.getSnapshot();
    f.session.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve(status(["ready", "pending", "pending"]));
    await begin;
    expect(f.values.get(storageKey)).toBe(JSON.stringify(record()));
    expect(f.session.getSnapshot()).toBe(beforeDispose);
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(f.api.progress).not.toHaveBeenCalled();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
  });

  it("survives effect cleanup/replay without accepting a stale aborted operation", async () => {
    const f = fixture(record());
    const listener = vi.fn();
    const unsubscribe = f.session.subscribe(listener);
    const oldRead = deferred<CustomerReturnLabelStatus>();
    f.api.byCommand
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(status(["ready", "ready", "ready"], false));
    const firstRestore = f.session.restore();
    const firstSignal = f.api.byCommand.mock.calls[0][1];
    const beforeReplay = listener.mock.calls.length;
    f.session.dispose();
    f.session.activate();
    expect(listener).toHaveBeenCalledTimes(beforeReplay + 1);
    expect(f.session.getSnapshot().busy).toBe(false);
    await f.session.restore();
    const accepted = f.session.getSnapshot();
    oldRead.resolve(status(["processing", "pending", "pending"]));
    await firstRestore;
    expect(firstSignal.aborted).toBe(true);
    expect(f.api.byCommand).toHaveBeenCalledTimes(2);
    expect(f.session.getSnapshot()).toBe(accepted);
    unsubscribe();
  });

  it("finishes only after every parcel is ready and clears metadata once", async () => {
    const f = fixture();
    f.api.submit.mockResolvedValue(
      status(["ready", "pending", "pending"], false),
    );
    await f.session.begin(intent());
    f.session.finish();
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    f.api.status.mockResolvedValue(status(["ready", "ready", "ready"], false));
    await f.session.check();
    f.session.finish();
    f.session.finish();
    expect(f.storage.removeItem).toHaveBeenCalledExactlyOnceWith(storageKey);
    expect(f.session.getSnapshot()).toMatchObject({
      record: null,
      status: null,
      error: null,
      revision: 1,
    });
  });

  it("preserves the completed return when storage cleanup fails", async () => {
    const f = fixture();
    f.api.submit.mockResolvedValue(status(["ready", "ready", "ready"], false));
    await f.session.begin(intent());
    f.storage.removeItem.mockImplementation(() => {
      throw new Error("Storage denied");
    });
    f.session.finish();
    expect(f.session.getSnapshot().record).toEqual(record(authorizationId));
    expect(f.session.getSnapshot().error).toContain("could not be cleared");
    expect(f.session.getSnapshot().revision).toBe(0);
  });
});
