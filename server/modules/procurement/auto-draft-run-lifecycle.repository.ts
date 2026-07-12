import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { autoDraftRuns } from "@shared/schema";
import { db as defaultDatabase } from "../../db";
import type {
  AutoDraftRunLifecycleRepository,
  AutoDraftRunLifecycleUnitOfWork,
  AutoDraftRunRecord,
} from "./auto-draft-run-lifecycle.service";

type Database = Pick<typeof defaultDatabase, "transaction">;
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0];

const AUTO_DRAFT_RUN_CLAIM_LOCK = "procurement:auto-draft-run-claim";

function createUnitOfWork(tx: Transaction): AutoDraftRunLifecycleUnitOfWork {
  return {
    async lockClaims() {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${AUTO_DRAFT_RUN_CLAIM_LOCK}, 0::bigint))
      `);
    },

    async getDatabaseTimestamp() {
      const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
      const value = (result.rows[0] as { now?: Date | string } | undefined)?.now;
      const timestamp = value instanceof Date ? value : new Date(String(value ?? ""));
      if (Number.isNaN(timestamp.getTime())) throw new Error("Database timestamp is unavailable");
      return timestamp;
    },

    async getRunningRunsForUpdate() {
      return await tx
        .select()
        .from(autoDraftRuns)
        .where(eq(autoDraftRuns.status, "running"))
        .orderBy(asc(autoDraftRuns.runAt), asc(autoDraftRuns.id))
        .for("update") as AutoDraftRunRecord[];
    },

    async getRunForUpdate(id) {
      const [run] = await tx
        .select()
        .from(autoDraftRuns)
        .where(eq(autoDraftRuns.id, id))
        .for("update")
        .limit(1);
      return (run ?? null) as AutoDraftRunRecord | null;
    },

    async interruptRuns(ids, values) {
      const safeIds = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
      if (safeIds.length === 0) return [];
      return await tx
        .update(autoDraftRuns)
        .set({
          status: "interrupted",
          finishedAt: values.finishedAt,
          heartbeatAt: values.heartbeatAt,
          leaseExpiresAt: null,
          errorMessage: values.errorMessage,
        })
        .where(and(
          inArray(autoDraftRuns.id, safeIds),
          eq(autoDraftRuns.status, "running"),
        ))
        .returning() as AutoDraftRunRecord[];
    },

    async createRun(values) {
      const [created] = await tx.insert(autoDraftRuns).values(values).returning();
      if (!created) throw new Error("Auto-draft run insert returned no row");
      return created as AutoDraftRunRecord;
    },

    async renewRun(id, values) {
      const [updated] = await tx
        .update(autoDraftRuns)
        .set(values)
        .where(and(eq(autoDraftRuns.id, id), eq(autoDraftRuns.status, "running")))
        .returning();
      return (updated ?? null) as AutoDraftRunRecord | null;
    },

    async finishRun(id, values) {
      const [updated] = await tx
        .update(autoDraftRuns)
        .set(values)
        .where(and(eq(autoDraftRuns.id, id), eq(autoDraftRuns.status, "running")))
        .returning();
      return (updated ?? null) as AutoDraftRunRecord | null;
    },
  };
}

export function createDrizzleAutoDraftRunLifecycleRepository(
  database: Database = defaultDatabase,
): AutoDraftRunLifecycleRepository {
  return {
    transaction<T>(work: (unitOfWork: AutoDraftRunLifecycleUnitOfWork) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => work(createUnitOfWork(tx as Transaction)));
    },
  };
}

export const autoDraftRunLifecycleRepository = createDrizzleAutoDraftRunLifecycleRepository();
