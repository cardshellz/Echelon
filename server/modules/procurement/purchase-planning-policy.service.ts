import { createHash } from "node:crypto";
import { z } from "zod";
import { parsePurchasePlanningPolicy, purchasePlanningPolicySchema } from "@shared/procurement/purchase-planning-policy";
import { PurchasePlanningPolicyRepository } from "./purchase-planning-policy.repository";

const updateSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  idempotencyKey: z.string().trim().min(8).max(160),
  policy: purchasePlanningPolicySchema,
}).strict();

export class PurchasePlanningPolicyError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

export class PurchasePlanningPolicyService {
  constructor(private readonly repository: PurchasePlanningPolicyRepository, private readonly clock: () => Date) {}
  read() { return this.repository.read(); }
  history() { return this.repository.history(); }
  describeProducts(ids: number[]) { return this.repository.describeProducts(ids); }
  searchProducts(raw: unknown) {
    const search = z.string().trim().min(2).max(100).safeParse(raw);
    if (!search.success) throw new PurchasePlanningPolicyError("PLANNING_PRODUCT_SEARCH_INVALID", "Search must contain 2 to 100 characters", 400);
    return this.repository.searchProducts(search.data);
  }

  async update(raw: unknown, actor: unknown) {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) throw new PurchasePlanningPolicyError("PLANNING_POLICY_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400);
    if (typeof actor !== "string" || actor.trim().length === 0 || actor.length > 255) {
      throw new PurchasePlanningPolicyError("PLANNING_POLICY_ACTOR_REQUIRED", "An authenticated operator is required", 403);
    }
    const request = parsed.data;
    const policy = parsePurchasePlanningPolicy(request.policy);
    const requestHash = createHash("sha256").update(JSON.stringify({ expectedRevision: request.expectedRevision, policy, actor })).digest("hex");
    return this.repository.transaction(async (tx) => {
      // Every command locks the singleton before checking replay evidence. A lost
      // response can therefore retry safely even after a later operator edit.
      const current = await tx.lock();
      const replay = await tx.findRequest(request.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new PurchasePlanningPolicyError("PLANNING_POLICY_IDEMPOTENCY_CONFLICT", "This request key belongs to a different policy change", 409);
        return { ...replay.result, reused: true };
      }
      if (current.revision !== request.expectedRevision) throw new PurchasePlanningPolicyError("PLANNING_POLICY_CHANGED", "Another operator changed this policy. Reload and review the current version before saving.", 409);
      const productIds = [...new Set([...policy.products.map((product) => product.productId), ...(policy.replacementForecasts ?? []).map((range) => range.productId)])].sort((a, b) => a - b);
      const found = await tx.validateProducts(productIds);
      if (found.length !== productIds.length) throw new PurchasePlanningPolicyError("PLANNING_POLICY_PRODUCT_MISSING", "Every product policy must reference an existing product", 400);
      const changedAt = this.clock();
      if (!(changedAt instanceof Date) || !Number.isFinite(changedAt.getTime())) throw new Error("Planning policy clock returned an invalid timestamp");
      const result = await tx.save({ before: current, policy, actorId: actor, idempotencyKey: request.idempotencyKey, requestHash, changedAt });
      return { ...result, reused: false };
    });
  }
}
