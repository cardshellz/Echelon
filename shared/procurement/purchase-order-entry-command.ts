import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const id = z.number().int().positive().max(2_147_483_647);
const payload = z.record(z.unknown());
export const purchaseOrderEntryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), targetId: z.null(), payload }).strict(),
  z.object({ action: z.literal("save-draft"), targetId: id, payload }).strict(),
  z.object({ action: z.literal("duplicate"), targetId: id, payload }).strict(),
  z.object({ action: z.literal("prepare"), targetId: id, payload }).strict(),
  z.object({ action: z.literal("prepare-document"), targetId: id, payload }).strict(),
]);
export type PurchaseOrderEntryCommand = z.infer<typeof purchaseOrderEntryCommandSchema>;
export type PurchaseOrderEntryAction = PurchaseOrderEntryCommand["action"];

const header = z.object({
  id, poNumber: z.string().min(1), status: z.enum(["draft", "approved", "pending_approval"]), physicalStatus: z.literal("draft"),
  vendorId: id, updatedAt: z.string().datetime({ offset: true }),
  totalCents: z.number().int().safe(), lineCount: z.number().int().nonnegative(),
}).passthrough();
const line = z.object({ id, purchaseOrderId: id, orderQty: z.number().int().nonnegative(),
  status: z.string().min(1), lineNumber: z.number().int().positive(),
}).passthrough();

// Preserve old wrapped/flat response fields, but require a complete canonical
// PO snapshot and line identities before a client releases its saved intent.
export const purchaseOrderEntryCommandResultSchema = z.object({
  po: header,
  lines: z.array(line),
  entryCommand: z.object({
    action: z.enum(["create", "save-draft", "duplicate", "prepare", "prepare-document"]),
    targetId: id.nullable(), actorId: z.string().min(1).max(100),
    idempotencyKey: z.string().min(8).max(200), purchaseOrderId: id,
    requestCanonical: z.string().min(1),
  }).strict(),
}).passthrough().superRefine((value, context) => {
  const identity = value.entryCommand;
  const isNew = identity.action === "create" || identity.action === "duplicate";
  if (identity.purchaseOrderId !== value.po.id
    || (identity.action === "create" ? identity.targetId !== null : identity.targetId === null)
    || (!isNew && identity.targetId !== value.po.id)
    || (identity.action === "duplicate" && identity.targetId === value.po.id)
    || value.lines.some(row => row.purchaseOrderId !== value.po.id || row.status === "cancelled")
    || new Set(value.lines.map(row => row.id)).size !== value.lines.length
    || value.lines.length !== value.po.lineCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entryCommand"], message: "Purchase order recovery identity is inconsistent" });
  }
});
export type PurchaseOrderEntryCommandResult = z.infer<typeof purchaseOrderEntryCommandResultSchema>;

export function purchaseOrderEntryResultMatchesRequest(result: PurchaseOrderEntryCommandResult, command: PurchaseOrderEntryCommand, actorId: string): boolean {
  if (result.entryCommand.action !== command.action || result.entryCommand.targetId !== command.targetId
    || result.entryCommand.actorId !== actorId || result.entryCommand.requestCanonical !== canonicalJson(command)) return false;
  if (result.status !== undefined && result.status !== result.po.status) return false;
  if (result.pending_approval !== undefined && result.pending_approval !== (result.po.status === "pending_approval")) return false;
  if (result.dispatch_recorded !== undefined && result.dispatch_recorded !== false) return false;
  if (result.sendError !== undefined && (typeof result.sendError !== "string" || !result.sendError.trim())) return false;
  if (command.action === "duplicate") return result.po.status === "draft" && result.id === result.po.id && result.po_number === result.po.poNumber;
  if (command.action === "prepare") return result.po.status === "approved" && result.id === result.po.id;
  if (command.action === "prepare-document") return result.po.status !== "draft" && result.dispatch_recorded === false
    && result.pending_approval === (result.po.status === "pending_approval") && result.pdf === null;
  const prepare = command.payload.prepare_for_supplier === true || command.payload.advance_to_sent === true;
  if (!prepare) return result.po.status === "draft" && result.sendError === undefined;
  return result.dispatch_recorded === false && (result.sendError !== undefined || result.po.status !== "draft");
}
