import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnSubmissionService,
  type CustomerReturnSubmissionStore,
  type ReturnSubmissionCommand,
} from "../../application/customer-return-submission.service";
import {
  CustomerReturnIntakeError,
  type CustomerReturnIntakeStore,
} from "../../application/customer-return-intake.ports";
import { CustomerReturnLiveError } from "../../application/customer-return-live-error";
import {
  labelPolicy,
  labelPreparationFixture,
  labelSettings,
  LABEL_KEY,
  LABEL_LEASE,
} from "../support/label-fixtures";
import { LIVE_NOW } from "../support/live-inspection-fixtures";
import type { CustomerReturnLabelStatus } from "@shared/returns/customer-return-label.contract";

async function setup() {
  const fixture = await labelPreparationFixture();
  const command: ReturnSubmissionCommand = {
    request: structuredClone(fixture.input),
    actor: "original-admin",
    leaseToken: LABEL_LEASE,
    status: "preparing",
    authorizationId: null,
  };
  const acquire = vi.fn<CustomerReturnSubmissionStore["acquire"]>(async () =>
    structuredClone(command),
  );
  const read = vi.fn<CustomerReturnSubmissionStore["read"]>(async () =>
    structuredClone(command),
  );
  const reject = vi.fn<CustomerReturnSubmissionStore["reject"]>(async () => {
    command.status = "rejected";
  });
  const persist = vi.fn<CustomerReturnIntakeStore["persist"]>(async (input) => {
    command.status = "accepted";
    command.authorizationId = 1;
    return {
      authorizationId: 1,
      authorizationNumber: "RMA-1",
      replayed: false,
      cases: [
        { caseId: 1, caseNumber: "RET-1", wmsOrderId: 200, wmsReturnId: 1 },
      ],
      parcels: input.parcels.map((parcel, i) => ({
        parcelId: i + 1,
        parcelKey: parcel.parcelKey,
        providerExternalShipmentId: `ecr-1-${i + 1}`,
        dimensions: parcel.dimensions,
        weightGrams: parcel.weightGrams,
      })),
    };
  });
  const inspectForIntake = vi.fn(async () =>
    structuredClone(fixture.inspection),
  );
  const requireEnabled = vi.fn(async () => ({
    settings: labelSettings,
    operationalPolicy: { id: 1, version: 1, snapshot: labelPolicy },
  }));
  const status = vi.fn(
    async (): Promise<CustomerReturnLabelStatus> => ({
      channelId: 36,
      authorizationId: 1,
      authorizationNumber: "RMA-1",
      canProgress: true,
      parcels: [
        {
          parcelId: 1,
          number: 1,
          status: "pending",
          trackingNumber: null,
          downloadPath: null,
        },
      ],
    }),
  );
  const authorizeChannel = vi.fn(async () => {});
  const service = new CustomerReturnSubmissionService({
    commands: { read, acquire, reject },
    intake: { persist, find: vi.fn() },
    live: { inspectForIntake },
    settings: { requireEnabled },
    labels: { status },
    authorizeChannel,
    now: () => new Date(LIVE_NOW),
    newToken: () => LABEL_LEASE,
  });
  return {
    ...fixture,
    service,
    command,
    acquire,
    read,
    reject,
    persist,
    inspectForIntake,
    requireEnabled,
    status,
    authorizeChannel,
  };
}
describe("private return submission and exact-intent recovery", () => {
  it("records intent before provider observation and persists trusted preparation before labels", async () => {
    const s = await setup();
    s.inspectForIntake.mockImplementation(async () => {
      expect(s.acquire).toHaveBeenCalledTimes(1);
      return s.inspection;
    });
    const result = await s.service.submit(s.input, "admin");
    expect(result.authorizationId).toBe(1);
    expect(s.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionLeaseToken: LABEL_LEASE,
        actor: "original-admin",
        parcels: expect.any(Array),
      }),
    );
    expect(s.status.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.persist.mock.invocationCallOrder[0],
    );
  });
  it("accepted retry replays while providers/configuration are unavailable", async () => {
    const s = await setup();
    s.command.status = "accepted";
    s.command.authorizationId = 1;
    await s.service.submit(s.input, "admin");
    expect(s.inspectForIntake).not.toHaveBeenCalled();
    expect(s.requireEnabled).not.toHaveBeenCalled();
    expect(s.persist).not.toHaveBeenCalled();
  });
  it("resumes the server's saved request and key under the current lease actor", async () => {
    const s = await setup();
    s.command.actor = "second-admin";
    await s.service.resume(36, LABEL_KEY, "second-admin");
    expect(s.acquire).toHaveBeenCalledWith({
      channelId: 36,
      key: LABEL_KEY,
      actor: "second-admin",
      token: LABEL_LEASE,
      now: new Date(LIVE_NOW),
    });
    expect(s.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: LABEL_KEY,
        actor: "second-admin",
      }),
    );
  });
  it("known stale input is definitively rejected only via the current lease", async () => {
    const s = await setup();
    s.command.request.sourceRevision = "f".repeat(64);
    await expect(s.service.submit(s.input, "admin")).rejects.toMatchObject({
      code: "RETURN_LABEL_SUBMISSION_REJECTED",
      status: 410,
    });
    expect(s.reject).toHaveBeenCalledWith(
      36,
      LABEL_KEY,
      LABEL_LEASE,
      "RETURN_LIVE_REVIEW_CHANGED",
      new Date(LIVE_NOW),
    );
    expect(s.persist).not.toHaveBeenCalled();
  });
  it("a provider read outage keeps the original request recoverable", async () => {
    const s = await setup();
    s.inspectForIntake.mockRejectedValue(
      new CustomerReturnLiveError(
        "RETURN_LIVE_DATA_UNVERIFIED",
        "temporarily unavailable",
        503,
      ),
    );
    await expect(s.service.submit(s.input, "admin")).rejects.toMatchObject({
      code: "RETURN_LABEL_SUBMISSION_PROCESSING",
    });
    expect(s.reject).not.toHaveBeenCalled();
    expect(s.command.status).toBe("preparing");
  });
  it("a lost database commit response does not mark an accepted return rejected", async () => {
    const s = await setup();
    s.persist.mockImplementation(async () => {
      s.command.status = "accepted";
      s.command.authorizationId = 1;
      throw new Error("connection dropped");
    });
    await expect(s.service.submit(s.input, "admin")).rejects.toMatchObject({
      code: "RETURN_LABEL_SUBMISSION_PROCESSING",
    });
    expect(s.reject).not.toHaveBeenCalled();
    expect((await s.service.status(36, LABEL_KEY)).authorizationId).toBe(1);
  });
  it("a superseded preparer cannot reject a command accepted by another worker", async () => {
    const s = await setup();
    s.persist.mockImplementation(async () => {
      s.command.status = "accepted";
      s.command.authorizationId = 1;
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SUBMISSION_LEASE_CHANGED",
        "changed",
      );
    });
    s.reject.mockResolvedValue();
    expect((await s.service.submit(s.input, "admin")).authorizationId).toBe(1);
  });
  it.each(["preparing", "rejected", "missing"])(
    "lookup exposes %s without making a new request",
    async (kind) => {
      const s = await setup();
      if (kind === "missing") s.read.mockResolvedValue(null);
      else s.command.status = kind as "preparing" | "rejected";
      await expect(s.service.status(36, LABEL_KEY)).rejects.toMatchObject({
        status: kind === "missing" ? 404 : kind === "rejected" ? 410 : 409,
      });
      expect(s.acquire).not.toHaveBeenCalled();
      expect(s.persist).not.toHaveBeenCalled();
    },
  );
  it("rejects customer supplied weights and actors before storing anything", async () => {
    const s = await setup();
    await expect(
      s.service.submit(
        { ...s.input, actor: "forged", weightGrams: 1 },
        "admin",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.acquire).not.toHaveBeenCalled();
  });
});
