import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { purchasePipelineJobRuns } from "@shared/schema";
import { db as defaultDatabase } from "../../db";
import type {
  PurchasePipelineJobRunLifecycleRepository,
  PurchasePipelineJobRunLifecycleUnitOfWork,
  PurchasePipelineJobRunRecord,
  PurchasePipelineJobType,
} from "./purchase-pipeline-job-run-lifecycle.service";

type Database = Pick<typeof defaultDatabase, "transaction">;
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0];

const CLAIM_LOCK_PREFIX = "procurement:purchase-pipeline-job-run:";

function createUnitOfWork(tx: Transaction): PurchasePipelineJobRunLifecycleUnitOfWork {
  return {
    async lockClaims(jobType: PurchasePipelineJobType) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${CLAIM_LOCK_PREFIX}${jobType}`}, 0::bigint)
        )
      `);
    },

    async getDatabaseTimestamp() {
      const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
      const value = (result.rows[0] as { now?: Date | string } | undefined)?.now;
      const timestamp = value instanceof Date ? value : new Date(String(value ?? ""));
      if (Number.isNaN(timestamp.getTime())) throw new Error("Database timestamp is unavailable");
      return timestamp;
    },

    async getRunningRunsForUpdate(jobType) {
      return await tx
        .select()
        .from(purchasePipelineJobRuns)
        .where(and(
          eq(purchasePipelineJobRuns.jobType, jobType),
          eq(purchasePipelineJobRuns.status, "running"),
        ))
        .orderBy(asc(purchasePipelineJobRuns.startedAt), asc(purchasePipelineJobRuns.id))
        .for("update") as PurchasePipelineJobRunRecord[];
    },

    async getRunForUpdate(id) {
      const [run] = await tx
        .select()
        .from(purchasePipelineJobRuns)
        .where(eq(purchasePipelineJobRuns.id, id))
        .for("update")
        .limit(1);
      return (run ?? null) as PurchasePipelineJobRunRecord | null;
    },

    async interruptRuns(ids, values) {
      const safeIds = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
      if (safeIds.length === 0) return [];
      return await tx
        .update(purchasePipelineJobRuns)
        .set({
          status: "interrupted",
          finishedAt: values.finishedAt,
          heartbeatAt: values.heartbeatAt,
          leaseExpiresAt: null,
          errorCode: values.errorCode,
          errorMessage: values.errorMessage,
          updatedAt: values.updatedAt,
        })
        .where(and(
          inArray(purchasePipelineJobRuns.id, safeIds),
          eq(purchasePipelineJobRuns.status, "running"),
        ))
        .returning() as PurchasePipelineJobRunRecord[];
    },

    async createRun(values) {
      const [created] = await tx.insert(purchasePipelineJobRuns).values(values).returning();
      if (!created) throw new Error("Purchase pipeline job run insert returned no row");
      return created as PurchasePipelineJobRunRecord;
    },

    async renewRun(id, values) {
      const [updated] = await tx
        .update(purchasePipelineJobRuns)
        .set(values)
        .where(and(
          eq(purchasePipelineJobRuns.id, id),
          eq(purchasePipelineJobRuns.status, "running"),
        ))
        .returning();
      return (updated ?? null) as PurchasePipelineJobRunRecord | null;
    },

    async finishRun(id, values) {
      const [updated] = await tx
        .update(purchasePipelineJobRuns)
        .set(values)
        .where(and(
          eq(purchasePipelineJobRuns.id, id),
          eq(purchasePipelineJobRuns.status, "running"),
        ))
        .returning();
      return (updated ?? null) as PurchasePipelineJobRunRecord | null;
    },
  };
}

export function createDrizzlePurchasePipelineJobRunLifecycleRepository(
  database: Database = defaultDatabase,
): PurchasePipelineJobRunLifecycleRepository {
  return {
    transaction<T>(
      work: (unitOfWork: PurchasePipelineJobRunLifecycleUnitOfWork) => Promise<T>,
    ): Promise<T> {
      return database.transaction(async (tx) => work(createUnitOfWork(tx as Transaction)));
    },
  };
}

export const purchasePipelineJobRunLifecycleRepository =
  createDrizzlePurchasePipelineJobRunLifecycleRepository();
