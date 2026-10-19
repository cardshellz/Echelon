import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { financialCommandResults } from "@shared/schema";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";

export const AP_PAYMENT_COMMAND_PRINCIPAL = "procurement.ap-payment";
export const AP_PAYMENT_COMMAND_SCOPE = { method: "POST", routeTemplate: "/api/ap-payments/command", resourceKey: "ap:payment", commandName: "procurement.ap.payment" } as const;
const legacyCommands = ["ap.payment.record", "ap.payment.apply", "ap.payment.void"];
const descriptorSchema = z.object({ actorType: z.enum(["user", "service", "system"]), actorId: z.string(), method: z.string(), routeTemplate: z.string(), resourceKey: z.string(), idempotencyKey: z.string(), requestHash: z.string(), commandName: z.string(), contractVersion: z.number() });
export type LegacyPaymentCommandLookup = (key: string) => Promise<readonly FinancialCommandDescriptor[]>;
export async function readLegacyPaymentCommandIdentities(key: string): Promise<readonly FinancialCommandDescriptor[]> {
  const rows = await db.select().from(financialCommandResults).where(and(eq(financialCommandResults.idempotencyKey, key), inArray(financialCommandResults.commandName, legacyCommands))).orderBy(financialCommandResults.id).limit(2);
  return z.array(descriptorSchema).parse(rows);
}
export function bindApPaymentCommandIdentity(descriptor: FinancialCommandDescriptor, command: string): FinancialCommandDescriptor {
  return { ...descriptor, ...AP_PAYMENT_COMMAND_SCOPE, actorType: "service", actorId: AP_PAYMENT_COMMAND_PRINCIPAL,
    // The raw HTTP digest already binds original parameters, query, body and resource.
    // Actual actor and operation are included here, but excluded from uniqueness scope.
    requestHash: hashHttpFinancialCommand({ ...AP_PAYMENT_COMMAND_SCOPE, body: { actorType: descriptor.actorType, actorId: descriptor.actorId,
      command, method: descriptor.method, routeTemplate: descriptor.routeTemplate, resourceKey: descriptor.resourceKey, rawRequestHash: descriptor.requestHash } }) };
}
export async function resolveApPaymentCommandIdentity(descriptor: FinancialCommandDescriptor, command: string, lookup: LegacyPaymentCommandLookup): Promise<FinancialCommandDescriptor> {
  const legacy = await lookup(descriptor.idempotencyKey);
  if (!legacy.length) return bindApPaymentCommandIdentity(descriptor, command);
  const same = (row: FinancialCommandDescriptor) => Object.keys(descriptorSchema.shape).every(key => row[key as keyof FinancialCommandDescriptor] === descriptor[key as keyof FinancialCommandDescriptor]);
  if (legacy.length !== 1 || !same(legacy[0])) throw new FinancialCommandError("This payment request key belongs to existing payment history. Review that request before submitting another payment.", 409, "AP_PAYMENT_LEGACY_KEY_REVIEW");
  // Exact legacy recovery keeps its original saved response and never creates a second namespace entry.
  return descriptor;
}
