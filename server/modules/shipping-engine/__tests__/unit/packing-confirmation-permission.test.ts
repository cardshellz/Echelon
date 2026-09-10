import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as unknown[],
  executes: [] as unknown[],
  updated: {} as Record<string, unknown>,
  transactions: 0,
}));
vi.mock("../../../../db", () => ({
  db: {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      mocked.transactions++;
      function select() {
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          for: () => chain,
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(mocked.selects.shift() ?? []).then(resolve),
        };
        return chain;
      }
      function update() {
        const chain = {
          set: (value: unknown) => {
            mocked.updates.push(value);
            return chain;
          },
          where: () => chain,
          returning: async () => [mocked.updated],
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve([]).then(resolve),
        };
        return chain;
      }
      return work({
        select,
        update,
        execute: async (query: unknown) => {
          mocked.executes.push(query);
          return [];
        },
      });
    },
  },
}));
import { confirmParcel } from "../../application/packing.service";

const now = new Date("2026-09-09T12:00:00Z");
const input = {
  planId: 5,
  parcelId: 8,
  actualBoxId: 10,
  actualWeightGrams: 500,
  packedBy: "operator-7",
};
const parcel = {
  id: 8,
  packPlanId: 5,
  boxId: 10,
  actualBoxId: null,
  actualWeightGrams: null,
  packedAt: null,
  packedBy: null,
};
const plan = {
  id: 5,
  wmsOrderId: 20,
  status: "active",
  packagingSnapshot: {
    channelId: 11,
    warehouseId: 2,
    requirement: "unbranded",
    boxes: [{ id: 10 }],
  },
};
beforeEach(() => {
  mocked.selects = [];
  mocked.updates = [];
  mocked.executes = [];
  mocked.updated = { ...parcel, ...input, id: 8, packedAt: now };
  mocked.transactions = 0;
});
describe("manual packing transaction guard", () => {
  it("rejects cross-program substitution before any write", async () => {
    mocked.selects = [[plan], [parcel]];
    expect(
      await confirmParcel({ ...input, actualBoxId: 99 }, () => now),
    ).toMatchObject({ ok: false, code: "BOX_NOT_PERMITTED" });
    expect(mocked.updates).toHaveLength(0);
    expect(mocked.executes).toHaveLength(1);
  });
  it("rejects warehouse mismatch and unavailable actual boxes", async () => {
    mocked.selects = [[plan], [parcel], [{ warehouseId: 1, channelId: 11 }]];
    expect(await confirmParcel(input, () => now)).toMatchObject({
      ok: false,
      code: "BOX_NOT_PERMITTED",
    });
    mocked.selects = [
      [plan],
      [parcel],
      [{ warehouseId: 2, channelId: 11 }],
      [{ id: 10, branding: "unbranded", reviewed: false }],
    ];
    expect(await confirmParcel(input, () => now)).toMatchObject({
      ok: false,
      code: "BOX_NOT_PERMITTED",
    });
    expect(mocked.updates).toHaveLength(0);
  });
  it("writes actuals and an audit event together using the injected time", async () => {
    mocked.selects = [
      [plan],
      [parcel],
      [{ warehouseId: 2, channelId: 11 }],
      [{ id: 10, branding: "unbranded", reviewed: true }],
      [{ packedAt: now }],
    ];
    expect(await confirmParcel(input, () => now)).toMatchObject({
      ok: true,
      planStatus: "packed",
      allConfirmed: true,
    });
    expect(mocked.updates[0]).toMatchObject({
      packedAt: now,
      packedBy: input.packedBy,
      actualBoxId: 10,
    });
    expect(mocked.executes).toHaveLength(2);
    expect(mocked.transactions).toBe(1);
  });
  it("replays identical confirmation without re-reading changed availability, timestamps or audit", async () => {
    mocked.selects = [
      [{ ...plan, status: "packed" }],
      [
        {
          ...parcel,
          actualBoxId: 10,
          actualWeightGrams: 500,
          packedBy: input.packedBy,
          packedAt: now,
        },
      ],
      [{ packedAt: now }],
    ];
    expect(
      await confirmParcel(input, () => new Date("2027-01-01")),
    ).toMatchObject({ ok: true, parcel: { packedAt: now } });
    expect(mocked.updates).toHaveLength(0);
    expect(mocked.executes).toHaveLength(1);
    expect(mocked.selects).toHaveLength(0);
  });
  it("rejects a plan snapshot belonging to a different channel", async () => {
    mocked.selects = [[plan], [parcel], [{ warehouseId: 2, channelId: 12 }]];
    expect(await confirmParcel(input, () => now)).toMatchObject({
      ok: false,
      code: "BOX_NOT_PERMITTED",
    });
    expect(mocked.updates).toHaveLength(0);
  });
  it("requires validated IDs and accountable actor before a transaction", async () => {
    expect(await confirmParcel({ ...input, actualBoxId: -1 })).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await confirmParcel({ ...input, packedBy: "" })).toMatchObject({
      code: "ACTOR_REQUIRED",
    });
    expect(mocked.transactions).toBe(0);
  });
  it("checks the warehouse even when an unrestricted plan ships in its own container", async () => {
    mocked.selects = [
      [
        {
          ...plan,
          packagingSnapshot: { ...plan.packagingSnapshot, requirement: "any" },
        },
      ],
      [{ ...parcel, boxId: null }],
      [{ warehouseId: 1, channelId: 11 }],
    ];
    expect(
      await confirmParcel({ ...input, actualBoxId: null }, () => now),
    ).toMatchObject({ ok: false, code: "BOX_NOT_PERMITTED" });
    expect(mocked.updates).toHaveLength(0);
  });
});
