import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnIntakeService,
  validatePreparedCustomerReturnIntake,
} from "../../application/customer-return-intake.service";
import {
  type CustomerReturnIntakeResult,
  type CustomerReturnIntakeStore,
  type PreparedCustomerReturnIntake,
} from "../../application/customer-return-intake.ports";
import {
  preparedIntake,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";

function input(): PreparedCustomerReturnIntake {
  const { now: _now, ...value } = preparedIntake();
  return value;
}
const saved: CustomerReturnIntakeResult = {
  authorizationId: 1,
  authorizationNumber: "RMA-1",
  replayed: false,
  cases: [{ caseId: 1, caseNumber: "RET-1", wmsOrderId: 201, wmsReturnId: 1 }],
  parcels: [
    {
      parcelId: 1,
      parcelKey: "1",
      providerExternalShipmentId: "ecr-1-1",
      dimensions: { lengthMm: 100, widthMm: 120, heightMm: 150 },
      weightGrams: 25,
    },
  ],
};
function harness() {
  const store = {
    find: vi.fn(async () => null as CustomerReturnIntakeResult | null),
    persist: vi.fn<CustomerReturnIntakeStore["persist"]>(async () => saved),
  };
  const dependencies = {
    store,
    now: () => new Date(INTAKE_NOW),
    maxSourceAgeMs: 120_000,
    isIntakeReady: vi.fn(() => true),
    reportFailure: vi.fn(),
  };
  return {
    store,
    dependencies,
    service: new CustomerReturnIntakeService(dependencies),
  };
}
describe("CustomerReturnIntakeService", () => {
  it("persists validated immutable intent using the injected decision instant", async () => {
    const h = harness();
    const request = input();
    expect(await h.service.submit(request)).toEqual(saved);
    expect(h.store.persist).toHaveBeenCalledWith({
      ...request,
      now: INTAKE_NOW,
    });
    expect(h.store.persist.mock.calls[0][0]).not.toBe(request);
  });
  it("replays an accepted request while intake is paused and old observations are stale", async () => {
    const h = harness();
    h.store.find.mockResolvedValue({ ...saved, replayed: true });
    h.dependencies.isIntakeReady.mockReturnValue(false);
    const request = input();
    request.observedAt = "2020-01-01T00:00:00Z";
    expect(await h.service.submit(request)).toEqual({
      ...saved,
      replayed: true,
    });
    expect(h.store.persist).not.toHaveBeenCalled();
  });
  it("rejects a closed gate without persistence", async () => {
    const h = harness();
    h.dependencies.isIntakeReady.mockReturnValue(false);
    await expect(h.service.submit(input())).rejects.toMatchObject({
      code: "RETURN_INTAKE_NOT_READY",
    });
    expect(h.store.persist).not.toHaveBeenCalled();
  });
  it.each([-1, 120_001])(
    "rejects future/stale observations at age %s",
    async (age) => {
      const h = harness();
      const request = input();
      request.observedAt = new Date(INTAKE_NOW.getTime() - age).toISOString();
      await expect(h.service.submit(request)).rejects.toMatchObject({
        code: "RETURN_INTAKE_SOURCE_CHANGED",
      });
      expect(h.store.persist).not.toHaveBeenCalled();
    },
  );
  it("accepts the exact freshness boundary", async () => {
    const h = harness();
    const request = input();
    request.observedAt = new Date(INTAKE_NOW.getTime() - 120_000).toISOString();
    await expect(h.service.submit(request)).resolves.toEqual(saved);
  });
  it.each([
    [
      "duplicate selection",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        lines: [...value.lines, value.lines[0]],
      }),
    ],
    [
      "duplicate parcel item",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            items: [...value.parcels[0].items, value.parcels[0].items[0]],
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "zero weight",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [{ ...value.parcels[0], weightGrams: 0 }, value.parcels[1]],
      }),
    ],
    [
      "non-US origin",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            originAddress: {
              ...value.parcels[0].originAddress,
              countryCode: "CA",
            },
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "unknown manifest line",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            items: [{ omsOrderLineId: 999, quantity: 2 }],
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "unpacked selection",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [value.parcels[0]],
      }),
    ],
    [
      "invalid box key",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        parcels: [{ ...value.parcels[0], parcelKey: "oops" }, value.parcels[1]],
      }),
    ],
    [
      "duplicate claim source",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        expectedClaims: [...value.expectedClaims, value.expectedClaims[0]],
      }),
    ],
    [
      "client weight metadata",
      (value: PreparedCustomerReturnIntake) => ({ ...value, weight: 1 }),
    ],
    [
      "unsafe quantity",
      (value: PreparedCustomerReturnIntake) => ({
        ...value,
        lines: [
          { ...value.lines[0], quantity: Number.MAX_SAFE_INTEGER + 1 },
          value.lines[1],
        ],
      }),
    ],
  ] as const)("rejects %s before persistence", async (_name, alter) => {
    const h = harness();
    await expect(
      h.service.submit(alter(input()) as PreparedCustomerReturnIntake),
    ).rejects.toMatchObject({ code: "RETURN_INTAKE_INPUT_INVALID" });
    expect(h.store.find).not.toHaveBeenCalled();
    expect(h.store.persist).not.toHaveBeenCalled();
  });
  it("preserves optional reasons and exact purchased identities independently of SKU", () => {
    const result = validatePreparedCustomerReturnIntake(input());
    expect(
      result.lines.map((line) => [
        line.omsOrderLineId,
        line.externalLineItemId,
        line.reasonCode,
      ]),
    ).toEqual([
      [101, "500", null],
      [102, "501", null],
    ]);
  });
  it("classifies unknown persistence failure without exposing provider/database detail", async () => {
    const h = harness();
    h.store.persist.mockRejectedValue(new Error("secret connection string"));
    await expect(h.service.submit(input())).rejects.toMatchObject({
      code: "RETURN_INTAKE_UNAVAILABLE",
      status: 503,
    });
    expect(h.dependencies.reportFailure).toHaveBeenCalledWith({
      code: "RETURN_INTAKE_UNAVAILABLE",
    });
  });
});
