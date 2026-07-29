export interface RateProgramRecord {
  id: number;
  name: string;
  status: string;
}

export interface RateProgramSourceRevision {
  id: number;
  serviceLevelId: number;
  serviceLevelCode: string;
  serviceLevelName: string;
  serviceLevelSortOrder: number;
}

export interface RateProgramBlockingRevision {
  id: number;
  serviceLevelId: number;
  serviceLevelCode: string;
  serviceLevelName: string;
  status: "active" | "draft";
}

export interface CreatedRateProgramDraft {
  id: number;
  sourceRateTableId: number;
  serviceLevelId: number;
  serviceLevelCode: string;
  serviceLevelName: string;
  rowCount: number;
  coverageCount: number;
}

export interface RateProgramCloneRepository {
  lockRatePrograms(rateBookIds: readonly number[]): Promise<void>;
  loadRatePrograms(rateBookIds: readonly number[]): Promise<RateProgramRecord[]>;
  loadActiveSourceRevisions(
    sourceRateBookId: number,
  ): Promise<RateProgramSourceRevision[]>;
  loadBlockingTargetRevisions(
    targetRateBookId: number,
  ): Promise<RateProgramBlockingRevision[]>;
  cloneRevision(input: {
    source: RateProgramSourceRevision;
    targetRateBookId: number;
    actor: string;
    now: Date;
  }): Promise<CreatedRateProgramDraft>;
  persistProgramCloneAudit(input: {
    actor: string;
    sourceRateBook: RateProgramRecord;
    targetRateBook: RateProgramRecord;
    createdDrafts: readonly CreatedRateProgramDraft[];
    now: Date;
  }): Promise<void>;
}

export interface CopyActiveRatesInput {
  sourceRateBookId: number;
  targetRateBookId: number;
  actor: string;
  now: Date;
}

export interface CopyActiveRatesResult {
  sourceRateBook: Pick<RateProgramRecord, "id" | "name">;
  targetRateBook: Pick<RateProgramRecord, "id" | "name">;
  createdDrafts: CreatedRateProgramDraft[];
  assignmentsCopied: false;
  liveRatesChanged: false;
}

export class RateProgramCloneError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RateProgramCloneError";
  }
}

export async function copyActiveRatesToProgram(
  repository: RateProgramCloneRepository,
  input: CopyActiveRatesInput,
): Promise<CopyActiveRatesResult> {
  assertInput(input);
  await repository.lockRatePrograms([
    input.sourceRateBookId,
    input.targetRateBookId,
  ]);

  const programs = await repository.loadRatePrograms([
    input.sourceRateBookId,
    input.targetRateBookId,
  ]);
  const sourceRateBook = programs.find(
    (program) => program.id === input.sourceRateBookId,
  );
  const targetRateBook = programs.find(
    (program) => program.id === input.targetRateBookId,
  );
  if (sourceRateBook === undefined) {
    throw new RateProgramCloneError(
      404,
      "SHIPPING_ADMIN_COPY_SOURCE_NOT_FOUND",
      "Source pricing program not found.",
      { sourceRateBookId: input.sourceRateBookId },
    );
  }
  if (targetRateBook === undefined) {
    throw new RateProgramCloneError(
      404,
      "SHIPPING_ADMIN_COPY_TARGET_NOT_FOUND",
      "Target pricing program not found.",
      { targetRateBookId: input.targetRateBookId },
    );
  }
  assertActiveProgram(sourceRateBook, "source");
  assertActiveProgram(targetRateBook, "target");

  const sourceRevisions = await repository.loadActiveSourceRevisions(
    sourceRateBook.id,
  );
  if (sourceRevisions.length === 0) {
    throw new RateProgramCloneError(
      409,
      "SHIPPING_ADMIN_COPY_SOURCE_HAS_NO_LIVE_RATES",
      "The source program has no live rates to copy.",
      { sourceRateBookId: sourceRateBook.id },
    );
  }
  assertOneActiveRevisionPerService(sourceRevisions);

  const conflicts = await repository.loadBlockingTargetRevisions(
    targetRateBook.id,
  );
  if (conflicts.length > 0) {
    throw new RateProgramCloneError(
      409,
      "SHIPPING_ADMIN_COPY_TARGET_NOT_EMPTY",
      "The target must not have live rates or drafts before rates are copied into it.",
      {
        conflicts: conflicts.map((conflict) => ({
          rateTableId: conflict.id,
          serviceLevelCode: conflict.serviceLevelCode,
          serviceLevelName: conflict.serviceLevelName,
          status: conflict.status,
        })),
      },
    );
  }

  const createdDrafts: CreatedRateProgramDraft[] = [];
  for (const source of sourceRevisions) {
    createdDrafts.push(await repository.cloneRevision({
      source,
      targetRateBookId: targetRateBook.id,
      actor: input.actor,
      now: input.now,
    }));
  }
  await repository.persistProgramCloneAudit({
    actor: input.actor,
    sourceRateBook,
    targetRateBook,
    createdDrafts,
    now: input.now,
  });

  return {
    sourceRateBook: {
      id: sourceRateBook.id,
      name: sourceRateBook.name,
    },
    targetRateBook: {
      id: targetRateBook.id,
      name: targetRateBook.name,
    },
    createdDrafts,
    assignmentsCopied: false,
    liveRatesChanged: false,
  };
}

function assertInput(input: CopyActiveRatesInput): void {
  if (
    !Number.isInteger(input.sourceRateBookId)
    || input.sourceRateBookId <= 0
    || !Number.isInteger(input.targetRateBookId)
    || input.targetRateBookId <= 0
  ) {
    throw new RateProgramCloneError(
      400,
      "SHIPPING_ADMIN_COPY_INPUT_INVALID",
      "Valid source and target pricing program IDs are required.",
    );
  }
  if (input.sourceRateBookId === input.targetRateBookId) {
    throw new RateProgramCloneError(
      400,
      "SHIPPING_ADMIN_COPY_PROGRAMS_IDENTICAL",
      "Choose a different source pricing program.",
      { rateBookId: input.sourceRateBookId },
    );
  }
  if (input.actor.trim() === "") {
    throw new RateProgramCloneError(
      401,
      "SHIPPING_ADMIN_ACTOR_REQUIRED",
      "An authenticated operator is required to copy shipping rates.",
    );
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new RateProgramCloneError(
      500,
      "SHIPPING_ADMIN_COPY_CLOCK_INVALID",
      "The shipping rate copy clock is invalid.",
    );
  }
}

function assertActiveProgram(
  program: RateProgramRecord,
  role: "source" | "target",
): void {
  if (program.status === "active") return;
  throw new RateProgramCloneError(
    409,
    `SHIPPING_ADMIN_COPY_${role.toUpperCase()}_RETIRED`,
    `The ${role} pricing program is retired and cannot be used for this copy.`,
    { rateBookId: program.id, status: program.status },
  );
}

function assertOneActiveRevisionPerService(
  revisions: readonly RateProgramSourceRevision[],
): void {
  const seen = new Map<number, RateProgramSourceRevision>();
  const duplicates = new Set<string>();
  for (const revision of revisions) {
    const previous = seen.get(revision.serviceLevelId);
    if (previous !== undefined) {
      duplicates.add(revision.serviceLevelName);
    } else {
      seen.set(revision.serviceLevelId, revision);
    }
  }
  if (duplicates.size === 0) return;
  throw new RateProgramCloneError(
    409,
    "SHIPPING_ADMIN_COPY_SOURCE_AMBIGUOUS",
    "The source has more than one live revision for a shipping option.",
    { serviceLevels: [...duplicates].sort() },
  );
}
