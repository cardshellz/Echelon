import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { sourcingId, supplierSourcingUpdateSchema } from "@shared/procurement/supplier-sourcing";
import { SupplierSourcingRepository, emptySupplierSourcingRecord, loadSupplierSourcingRecords } from "./supplier-sourcing.repository";

export class SupplierSourcingError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) { super(message); this.name = "SupplierSourcingError"; }
}
export class SupplierSourcingService {
  constructor(private readonly repository: SupplierSourcingRepository, private readonly clock: () => Date) {}
  async read(id: number) { const record = await this.repository.read(sourcingId.parse(id)); if (!record) throw new SupplierSourcingError("SUPPLIER_MAPPING_NOT_FOUND", "Supplier mapping was not found", 404); return record; }
  history(id: number, before: number | null) { return this.repository.history(sourcingId.parse(id), sourcingId.nullable().parse(before)); }
  async update(id: number, raw: unknown, actorId: string) {
    sourcingId.parse(id); z.string().trim().min(1).max(255).parse(actorId);
    const input = supplierSourcingUpdateSchema.parse(raw);
    const requestHash = createHash("sha256").update(canonicalJson({ vendorProductId: id, actorId, ...input })).digest("hex");
    return this.repository.transaction(async (tx) => {
      if (!await this.repository.lockMapping(tx, id)) throw new SupplierSourcingError("SUPPLIER_MAPPING_NOT_FOUND", "Supplier mapping was not found", 404);
      const replay = await this.repository.replay(tx, id, input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new SupplierSourcingError("SUPPLIER_SOURCING_IDEMPOTENCY_CONFLICT", "This request key belongs to a different supplier policy change", 409);
        return { record: replay.result, reused: true };
      }
      const current = (await loadSupplierSourcingRecords(tx, [id])).get(id) ?? emptySupplierSourcingRecord(id);
      if (current.revision !== input.expectedRevision) throw new SupplierSourcingError("SUPPLIER_SOURCING_CHANGED", "Supplier sourcing settings changed. Reload and review the latest revision.", 409);
      const at = z.date().parse(this.clock());
      if (input.policy.priceList && new Date(input.policy.priceList.quotedAt).getTime() > at.getTime()) throw new SupplierSourcingError("SUPPLIER_QUOTE_FUTURE", "A supplier quote cannot be dated in the future", 400);
      return { record: await this.repository.insert(tx, { current, policy: input.policy, idempotencyKey: input.idempotencyKey, requestHash, reason: input.reason, actorId, at }), reused: false };
    });
  }
}
