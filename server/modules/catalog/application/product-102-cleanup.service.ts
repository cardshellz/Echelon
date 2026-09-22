import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  PRODUCT_102_CLEANUP_KEY,
  Product102CleanupError,
  assertCleanupReferenceScope,
  assertProduct102CleanupEligible,
  assertProduct102ReviewedRows,
  cleanupRequire,
  product102CleanupCommandSchema,
  product102CleanupResultSchema,
  type CleanupReference,
  type CleanupSnapshot,
  type Product102CleanupCommand,
  type Product102CleanupResult,
} from "../domain/product-102-cleanup";

export interface StoredCleanupReceipt {
  requestHash: string;
  expectedHash: string;
  actorId: string;
  approval: string;
  before: string;
  after: string;
  manifest: string;
  result: Product102CleanupResult;
}

export interface Product102CleanupTransactionPort {
  schemaReady(): Promise<boolean>;
  lock(): Promise<void>;
  capture(): Promise<CleanupSnapshot>;
  readReceipt(): Promise<StoredCleanupReceipt | null>;
  expectedAfter(before: string): Promise<string>;
  changedSections(expected: string, actual: string): Promise<string[]>;
  equal(left: string, right: string): Promise<boolean>;
  record(
    command: Product102CleanupCommand,
    requestHash: string,
    before: CleanupSnapshot,
    after: string,
    occurredAt: string,
  ): Promise<Product102CleanupResult>;
  mutate(): Promise<void>;
  assertAudit(receipt: StoredCleanupReceipt): Promise<void>;
}

export interface Product102CleanupRepositoryPort {
  transaction<T>(
    readOnly: boolean,
    work: (transaction: Product102CleanupTransactionPort) => Promise<T>,
  ): Promise<T>;
}

const blockerSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();
const previewSchema = z
  .object({
    commandKey: z.literal(PRODUCT_102_CLEANUP_KEY),
    checkedAt: z.string().datetime(),
    status: z.enum(["ready", "blocked", "already_applied"]),
    schemaReady: z.boolean(),
    // A pre-migration evidence hash is deliberately not an execution token.
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    executableHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    blockers: z.array(blockerSchema),
    dependencies: z.array(
      z
        .object({
          parent: z.string(),
          id: z.number().int(),
          child: z.string(),
          count: z.string().regex(/^[0-9]+$/),
        })
        .strict(),
    ),
    result: product102CleanupResultSchema.nullable(),
  })
  .strict();
export type Product102CleanupPreview = z.infer<typeof previewSchema>;

const verificationSchema = z
  .object({
    commandKey: z.literal(PRODUCT_102_CLEANUP_KEY),
    checkedAt: z.string().datetime(),
    recordedComplete: z.literal(true),
    currentStateMatches: z.boolean(),
    changedSections: z.array(z.string()),
    result: product102CleanupResultSchema,
  })
  .strict();

/** Hash PostgreSQL's exact JSONB text, not parsed JS financial numbers. */
export function product102StateHash(data: string, manifest: string): string {
  return createHash("sha256")
    .update(PRODUCT_102_CLEANUP_KEY)
    .update("\n")
    .update(data)
    .update("\n")
    .update(manifest)
    .digest("hex");
}

export function product102RequestHash(
  command: Product102CleanupCommand,
): string {
  return createHash("sha256")
    .update(canonicalJson({ commandKey: PRODUCT_102_CLEANUP_KEY, ...command }))
    .digest("hex");
}

function describeBlocker(error: unknown): z.infer<typeof blockerSchema> {
  if (error instanceof Product102CleanupError)
    return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    return {
      code: "CLEANUP_REVIEWED_ROW_CHANGED",
      message: error.issues
        .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
        .join("; "),
    };
  }
  throw error; // A failed read is not an empty dependency list or a safe preview.
}

export class Product102CleanupService {
  constructor(
    private readonly repository: Product102CleanupRepositoryPort,
    private readonly clock: () => Date,
  ) {}

  private now(): string {
    const date = this.clock();
    cleanupRequire(
      date instanceof Date && Number.isFinite(date.getTime()),
      "CLEANUP_INVALID_CLOCK",
      "A valid injected clock is required.",
    );
    return date.toISOString();
  }

  async preview(): Promise<Product102CleanupPreview> {
    const checkedAt = this.now();
    return this.repository.transaction(true, async (transaction) => {
      const snapshot = await transaction.capture();
      const receipt = await transaction.readReceipt();
      if (receipt) await this.validateReceipt(transaction, receipt);
      const blockers: z.infer<typeof blockerSchema>[] = [];
      if (!snapshot.schemaReady)
        blockers.push({
          code: "CLEANUP_MIGRATION_REQUIRED",
          message:
            "Deploy migration 0695, then obtain and approve a fresh executable preview. No cleanup has run.",
        });
      else if (snapshot.guardProblems.length)
        blockers.push({
          code: "CLEANUP_GUARD_MISSING",
          message: snapshot.guardProblems.join("; "),
        });
      const checks = receipt
        ? [() => assertCleanupReferenceScope(snapshot.references, true)]
        : [
            () => assertProduct102ReviewedRows(snapshot),
            () =>
              assertCleanupReferenceScope(
                snapshot.references,
                false,
                snapshot.schemaReady,
              ),
          ];
      for (const check of checks) {
        try {
          check();
        } catch (error) {
          blockers.push(describeBlocker(error));
        }
      }
      const status = blockers.length
        ? "blocked"
        : receipt
          ? "already_applied"
          : "ready";
      const evidenceHash = product102StateHash(
        snapshot.data,
        snapshot.manifest,
      );
      return previewSchema.parse({
        commandKey: PRODUCT_102_CLEANUP_KEY,
        checkedAt,
        status,
        schemaReady: snapshot.schemaReady,
        evidenceHash,
        executableHash: status === "ready" ? evidenceHash : null,
        blockers,
        dependencies: snapshot.references.map(
          (reference: CleanupReference) => ({
            parent: reference.parent,
            id: reference.id,
            child: `${reference.schema}.${reference.table}.${reference.column}`,
            count: reference.count,
          }),
        ),
        result: receipt ? { ...receipt.result, alreadyApplied: true } : null,
      });
    });
  }

  async apply(input: unknown): Promise<Product102CleanupResult> {
    const command = product102CleanupCommandSchema.parse(input);
    const requestHash = product102RequestHash(command);
    const occurredAt = this.now();
    return this.repository.transaction(false, async (transaction) => {
      cleanupRequire(
        await transaction.schemaReady(),
        "CLEANUP_MIGRATION_REQUIRED",
        "History migration is not installed.",
      );
      await transaction.lock();
      const prior = await transaction.readReceipt();
      if (prior) {
        cleanupRequire(
          prior.requestHash === requestHash,
          "CLEANUP_COMMAND_CONFLICT",
          "This non-expiring cleanup key was already used with different approval or evidence. Verify the original command.",
        );
        await this.validateReceipt(transaction, prior);
        return product102CleanupResultSchema.parse({
          ...prior.result,
          alreadyApplied: true,
        });
      }
      const before = await transaction.capture();
      assertProduct102CleanupEligible(before);
      cleanupRequire(
        product102StateHash(before.data, before.manifest) ===
          command.expectedHash,
        "CLEANUP_PREVIEW_STALE",
        "Evidence changed since preview. Nothing was applied; obtain a new preview and approval.",
      );
      const expectedAfter = await transaction.expectedAfter(before.data);
      const result = await transaction.record(
        command,
        requestHash,
        before,
        expectedAfter,
        occurredAt,
      );
      await transaction.mutate();
      const after = await transaction.capture();
      cleanupRequire(
        after.schemaReady && after.guardProblems.length === 0,
        "CLEANUP_GUARD_MISSING",
        "A required history guard disappeared.",
      );
      assertCleanupReferenceScope(after.references, true);
      cleanupRequire(
        await transaction.equal(expectedAfter, after.data),
        "CLEANUP_UNEXPECTED_SIDE_EFFECT",
        "A record changed outside the exact approved field projection. The transaction must roll back.",
      );
      const receipt = await transaction.readReceipt();
      cleanupRequire(
        receipt,
        "CLEANUP_RECEIPT_MISSING",
        "Cleanup receipt was not recorded.",
      );
      await this.validateReceipt(transaction, receipt);
      return result;
    });
  }

  async verify(): Promise<z.infer<typeof verificationSchema>> {
    const checkedAt = this.now();
    return this.repository.transaction(true, async (transaction) => {
      const receipt = await transaction.readReceipt();
      cleanupRequire(
        receipt,
        "CLEANUP_NOT_APPLIED",
        "No completed cleanup receipt exists.",
      );
      await this.validateReceipt(transaction, receipt);
      const current = await transaction.capture();
      cleanupRequire(
        current.schemaReady && current.guardProblems.length === 0,
        "CLEANUP_GUARD_MISSING",
        current.guardProblems.join("; "),
      );
      assertCleanupReferenceScope(current.references, true);
      const changedSections = await transaction.changedSections(
        receipt.after,
        current.data,
      );
      // Later stock movement or a new legitimate evaluation is not grounds to
      // reapply a completed command. Report drift separately from its receipt.
      return verificationSchema.parse({
        commandKey: PRODUCT_102_CLEANUP_KEY,
        checkedAt,
        recordedComplete: true,
        currentStateMatches: changedSections.length === 0,
        changedSections,
        result: { ...receipt.result, alreadyApplied: true },
      });
    });
  }

  private async validateReceipt(
    transaction: Product102CleanupTransactionPort,
    receipt: StoredCleanupReceipt,
  ): Promise<void> {
    const command = product102CleanupCommandSchema.parse({
      expectedHash: receipt.expectedHash,
      actorId: receipt.actorId,
      approval: receipt.approval,
    });
    cleanupRequire(
      product102RequestHash(command) === receipt.requestHash &&
        product102StateHash(receipt.before, receipt.manifest) ===
          receipt.expectedHash,
      "CLEANUP_RECEIPT_INVALID",
      "Stored command or evidence fingerprint does not match its receipt.",
    );
    cleanupRequire(
      await transaction.equal(
        await transaction.expectedAfter(receipt.before),
        receipt.after,
      ),
      "CLEANUP_RECEIPT_INVALID",
      "Stored result does not match the exact approved field projection.",
    );
    await transaction.assertAudit(receipt);
  }
}
