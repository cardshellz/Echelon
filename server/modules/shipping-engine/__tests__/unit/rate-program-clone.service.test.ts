import { describe, expect, it, vi } from "vitest";

import {
  copyActiveRatesToProgram,
  RateProgramCloneError,
  type RateProgramCloneRepository,
} from "../../application/rate-program-clone.service";

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("copyActiveRatesToProgram", () => {
  it("copies every live shipping option as a target draft and audits once", async () => {
    const repository = fakeRepository();
    repository.loadActiveSourceRevisions.mockResolvedValue([
      sourceRevision(101, 1, "standard", "Standard Shipping", 10),
      sourceRevision(102, 2, "priority", "Priority Shipping", 20),
    ]);
    repository.cloneRevision
      .mockResolvedValueOnce(createdDraft(201, 101, 1, "standard", "Standard Shipping"))
      .mockResolvedValueOnce(createdDraft(202, 102, 2, "priority", "Priority Shipping"));

    const result = await copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    });

    expect(repository.lockRatePrograms).toHaveBeenCalledWith([10, 20]);
    expect(repository.loadBlockingTargetRevisions).toHaveBeenCalledWith(
      20,
    );
    expect(repository.cloneRevision).toHaveBeenNthCalledWith(1, {
      source: sourceRevision(
        101,
        1,
        "standard",
        "Standard Shipping",
        10,
      ),
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    });
    expect(repository.cloneRevision).toHaveBeenNthCalledWith(2, {
      source: sourceRevision(
        102,
        2,
        "priority",
        "Priority Shipping",
        20,
      ),
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    });
    expect(repository.persistProgramCloneAudit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      sourceRateBook: { id: 10, name: "Source" },
      targetRateBook: { id: 20, name: "Target" },
      assignmentsCopied: false,
      liveRatesChanged: false,
    });
    expect(result.createdDrafts.map((draft) => draft.id)).toEqual([201, 202]);
  });

  it("rejects an overlapping target draft before copying anything", async () => {
    const repository = fakeRepository();
    repository.loadBlockingTargetRevisions.mockResolvedValue([{
      id: 301,
      serviceLevelId: 1,
      serviceLevelCode: "standard",
      serviceLevelName: "Standard Shipping",
      status: "draft",
    }]);

    await expect(copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      code: "SHIPPING_ADMIN_COPY_TARGET_NOT_EMPTY",
      statusCode: 409,
      context: {
        conflicts: [{
          rateTableId: 301,
          serviceLevelCode: "standard",
          serviceLevelName: "Standard Shipping",
          status: "draft",
        }],
      },
    });
    expect(repository.cloneRevision).not.toHaveBeenCalled();
    expect(repository.persistProgramCloneAudit).not.toHaveBeenCalled();
  });

  it("rejects a source without live rates", async () => {
    const repository = fakeRepository();
    repository.loadActiveSourceRevisions.mockResolvedValue([]);

    await expect(copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      code: "SHIPPING_ADMIN_COPY_SOURCE_HAS_NO_LIVE_RATES",
      statusCode: 409,
    });
    expect(repository.loadBlockingTargetRevisions).not.toHaveBeenCalled();
    expect(repository.cloneRevision).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous source with two live revisions for one option", async () => {
    const repository = fakeRepository();
    repository.loadActiveSourceRevisions.mockResolvedValue([
      sourceRevision(101, 1, "standard", "Standard Shipping", 10),
      sourceRevision(102, 1, "standard", "Standard Shipping", 10),
    ]);

    await expect(copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      code: "SHIPPING_ADMIN_COPY_SOURCE_AMBIGUOUS",
      statusCode: 409,
      context: { serviceLevels: ["Standard Shipping"] },
    });
    expect(repository.cloneRevision).not.toHaveBeenCalled();
  });

  it("rejects identical source and target programs before taking locks", async () => {
    const repository = fakeRepository();

    await expect(copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 10,
      actor: "operator-1",
      now: NOW,
    })).rejects.toBeInstanceOf(RateProgramCloneError);
    expect(repository.lockRatePrograms).not.toHaveBeenCalled();
  });

  it("rejects a retired source or target program", async () => {
    const repository = fakeRepository();
    repository.loadRatePrograms.mockResolvedValue([
      { id: 10, name: "Source", status: "retired" },
      { id: 20, name: "Target", status: "active" },
    ]);

    await expect(copyActiveRatesToProgram(repository, {
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
      now: NOW,
    })).rejects.toMatchObject({
      code: "SHIPPING_ADMIN_COPY_SOURCE_RETIRED",
      statusCode: 409,
    });
    expect(repository.loadActiveSourceRevisions).not.toHaveBeenCalled();
  });
});

function fakeRepository() {
  const repository = {
    lockRatePrograms: vi.fn(async () => undefined),
    loadRatePrograms: vi.fn(async () => [
      { id: 10, name: "Source", status: "active" },
      { id: 20, name: "Target", status: "active" },
    ]),
    loadActiveSourceRevisions: vi.fn(async () => [
      sourceRevision(101, 1, "standard", "Standard Shipping", 10),
    ]),
    loadBlockingTargetRevisions: vi.fn(async () => []),
    cloneRevision: vi.fn(async () =>
      createdDraft(201, 101, 1, "standard", "Standard Shipping")),
    persistProgramCloneAudit: vi.fn(async () => undefined),
  } satisfies RateProgramCloneRepository;
  return repository;
}

function sourceRevision(
  id: number,
  serviceLevelId: number,
  serviceLevelCode: string,
  serviceLevelName: string,
  serviceLevelSortOrder: number,
) {
  return {
    id,
    serviceLevelId,
    serviceLevelCode,
    serviceLevelName,
    serviceLevelSortOrder,
  };
}

function createdDraft(
  id: number,
  sourceRateTableId: number,
  serviceLevelId: number,
  serviceLevelCode: string,
  serviceLevelName: string,
) {
  return {
    id,
    sourceRateTableId,
    serviceLevelId,
    serviceLevelCode,
    serviceLevelName,
    rowCount: 12,
    coverageCount: 3,
  };
}
