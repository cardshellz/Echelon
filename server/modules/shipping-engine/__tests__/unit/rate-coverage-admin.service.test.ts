import { describe, expect, it } from "vitest";
import type { AuditLogPayload } from "../../../../infrastructure/auditLogger";
import {
  saveRateCoverageManifest,
  type DraftRateCoverageGroup,
  type RateBookDestinationGroupRecord,
  type RateCoverageAdminTransaction,
  type RateTableCoverageRecord,
  type SavedRateCoverageGroup,
} from "../../application/rate-coverage-admin.service";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function draftGroup(
  overrides: Partial<DraftRateCoverageGroup> = {},
): DraftRateCoverageGroup {
  return {
    destinationGroupId: null,
    destinationGroupLockVersion: null,
    name: " Pennsylvania ",
    originWarehouseId: null,
    availability: "offered",
    sortOrder: 0,
    destinations: [{
      destinationCountry: "us",
      destinationRegion: "pa",
      postalPrefix: null,
    }],
    ...overrides,
  };
}

describe("saveRateCoverageManifest", () => {
  it("creates a normalized named group and freezes its coverage in one transaction", async () => {
    const tx = new FakeTransaction();

    const result = await saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [draftGroup()],
      actor: "operator-1",
      now: NOW,
    });

    expect(result.groups[0]).toMatchObject({
      destinationGroupId: 1,
      destinationGroupLockVersion: 1,
      name: "Pennsylvania",
      availability: "offered",
      destinations: [{
        destinationCountry: "US",
        destinationRegion: "PA",
        postalPrefix: null,
      }],
    });
    expect(result.coverages).toHaveLength(1);
    expect(tx.audits).toEqual([
      expect.objectContaining({
        actor: "operator-1",
        action: "shipping.rate_table_coverage.saved",
      }),
    ]);
  });

  it("reuses an existing same-name group only when geography is identical", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup());

    const result = await saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [draftGroup({ name: "PENNSYLVANIA" })],
      actor: "operator-1",
      now: NOW,
    });

    expect(result.groups[0].destinationGroupId).toBe(7);
    expect(tx.insertCalls).toBe(0);
  });

  it("rejects reuse of a same-name group with different geography", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup());

    await expect(saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [draftGroup({
        destinations: [{
          destinationCountry: "US",
          destinationRegion: "OH",
          postalPrefix: null,
        }],
      })],
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_ADMIN_DESTINATION_GROUP_NAME_CONFLICT",
    });
    expect(tx.coverages).toEqual([]);
  });

  it("rejects a stale edit before replacing the coverage manifest", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup({ lockVersion: 3 }));

    await expect(saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [draftGroup({
        destinationGroupId: 7,
        destinationGroupLockVersion: 2,
        name: "Pennsylvania updated",
      })],
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_ADMIN_DESTINATION_GROUP_CHANGED",
    });
    expect(tx.replaceCalls).toBe(0);
  });

  it("updates a current group with optimistic locking", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup({ lockVersion: 3 }));

    const result = await saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [draftGroup({
        destinationGroupId: 7,
        destinationGroupLockVersion: 3,
        name: "Pennsylvania retail",
      })],
      actor: "operator-1",
      now: NOW,
    });

    expect(result.groups[0]).toMatchObject({
      destinationGroupId: 7,
      destinationGroupLockVersion: 4,
      name: "Pennsylvania retail",
    });
  });

  it("allows one named geography to have distinct warehouse overrides", async () => {
    const tx = new FakeTransaction();

    const result = await saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [
        draftGroup({ name: "Pennsylvania" }),
        draftGroup({
          name: "PENNSYLVANIA",
          originWarehouseId: 7,
        }),
      ],
      actor: "operator-1",
      now: NOW,
    });

    expect(result.groups).toEqual([
      expect.objectContaining({
        destinationGroupId: 1,
        originWarehouseId: null,
      }),
      expect.objectContaining({
        destinationGroupId: 1,
        originWarehouseId: 7,
      }),
    ]);
    expect(tx.insertCalls).toBe(1);
  });

  it("updates a shared geography once and freezes one version across scopes", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup({ lockVersion: 3, sortOrder: 9 }));

    const result = await saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [
        draftGroup({
          destinationGroupId: 7,
          destinationGroupLockVersion: 3,
          name: "Pennsylvania retail",
          sortOrder: 0,
        }),
        draftGroup({
          destinationGroupId: 7,
          destinationGroupLockVersion: 3,
          name: "PENNSYLVANIA RETAIL",
          originWarehouseId: 7,
          sortOrder: 1,
        }),
      ],
      actor: "operator-1",
      now: NOW,
    });

    expect(tx.updateCalls).toBe(1);
    expect(result.groups.map((group) => ({
      warehouse: group.originWarehouseId,
      version: group.destinationGroupLockVersion,
    }))).toEqual([
      { warehouse: null, version: 4 },
      { warehouse: 7, version: 4 },
    ]);
  });

  it("rejects conflicting definitions for one geography identity", async () => {
    const tx = new FakeTransaction();
    tx.groups.set(7, persistedGroup({ lockVersion: 3 }));

    await expect(saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [
        draftGroup({
          destinationGroupId: 7,
          destinationGroupLockVersion: 3,
        }),
        draftGroup({
          destinationGroupId: 7,
          destinationGroupLockVersion: 3,
          originWarehouseId: 7,
          destinations: [{
            destinationCountry: "US",
            destinationRegion: "OH",
            postalPrefix: null,
          }],
        }),
      ],
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_ADMIN_DESTINATION_GROUP_DEFINITION_CONFLICT",
    });
    expect(tx.updateCalls).toBe(0);
    expect(tx.replaceCalls).toBe(0);
  });

  it("rejects duplicate configurations for one group and warehouse scope", async () => {
    const tx = new FakeTransaction();

    await expect(saveRateCoverageManifest(tx, {
      rateBookId: 10,
      rateTableId: 20,
      groups: [
        draftGroup({ name: "Pennsylvania" }),
        draftGroup({ name: "PENNSYLVANIA" }),
      ],
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_ADMIN_DESTINATION_GROUP_SCOPE_CONFLICT",
    });
    expect(tx.replaceCalls).toBe(0);
  });
});

class FakeTransaction implements RateCoverageAdminTransaction {
  readonly groups = new Map<number, RateBookDestinationGroupRecord>();
  readonly audits: AuditLogPayload[] = [];
  coverages: RateTableCoverageRecord[] = [];
  insertCalls = 0;
  updateCalls = 0;
  replaceCalls = 0;
  private nextGroupId = 1;
  private nextCoverageId = 1;

  async getDestinationGroupForUpdate(
    destinationGroupId: number,
  ): Promise<RateBookDestinationGroupRecord | null> {
    return this.groups.get(destinationGroupId) ?? null;
  }

  async findActiveDestinationGroupByName(
    rateBookId: number,
    name: string,
  ): Promise<RateBookDestinationGroupRecord | null> {
    return [...this.groups.values()].find(
      (group) =>
        group.rateBookId === rateBookId
        && group.status === "active"
        && group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    ) ?? null;
  }

  async insertDestinationGroup(input: {
    rateBookId: number;
    name: string;
    sortOrder: number;
    actor: string;
    now: Date;
    destinations: DraftRateCoverageGroup["destinations"];
  }): Promise<RateBookDestinationGroupRecord> {
    this.insertCalls += 1;
    const id = this.nextGroupId;
    this.nextGroupId += 1;
    const group: RateBookDestinationGroupRecord = {
      id,
      rateBookId: input.rateBookId,
      name: input.name,
      status: "active",
      sortOrder: input.sortOrder,
      lockVersion: 1,
      destinations: [...input.destinations],
    };
    this.groups.set(id, group);
    return group;
  }

  async updateDestinationGroup(input: {
    destinationGroupId: number;
    expectedLockVersion: number;
    name: string;
    sortOrder: number;
    now: Date;
    destinations: DraftRateCoverageGroup["destinations"];
  }): Promise<RateBookDestinationGroupRecord | null> {
    this.updateCalls += 1;
    const existing = this.groups.get(input.destinationGroupId);
    if (
      existing === undefined
      || existing.lockVersion !== input.expectedLockVersion
    ) return null;
    const updated: RateBookDestinationGroupRecord = {
      ...existing,
      name: input.name,
      sortOrder: input.sortOrder,
      lockVersion: existing.lockVersion + 1,
      destinations: [...input.destinations],
    };
    this.groups.set(updated.id, updated);
    return updated;
  }

  async loadRateTableCoverages(
    rateTableId: number,
  ): Promise<RateTableCoverageRecord[]> {
    return this.coverages.filter(
      (coverage) => coverage.rateTableId === rateTableId,
    );
  }

  async replaceRateTableCoverages(input: {
    rateTableId: number;
    groups: readonly SavedRateCoverageGroup[];
  }): Promise<RateTableCoverageRecord[]> {
    this.replaceCalls += 1;
    this.coverages = [
      ...this.coverages.filter(
        (coverage) => coverage.rateTableId !== input.rateTableId,
      ),
      ...input.groups.map((group) => ({
        ...group,
        id: this.nextCoverageId++,
        rateTableId: input.rateTableId,
        destinationGroupName: group.name,
        rateRowCount: group.availability === "offered" ? 1 : 0,
      })),
    ];
    return this.loadRateTableCoverages(input.rateTableId);
  }

  async persistAudit(payload: AuditLogPayload): Promise<void> {
    this.audits.push(payload);
  }
}

function persistedGroup(
  overrides: Partial<RateBookDestinationGroupRecord> = {},
): RateBookDestinationGroupRecord {
  return {
    id: 7,
    rateBookId: 10,
    name: "Pennsylvania",
    status: "active",
    sortOrder: 0,
    lockVersion: 1,
    destinations: [{
      destinationCountry: "US",
      destinationRegion: "PA",
      postalPrefix: null,
    }],
    ...overrides,
  };
}
