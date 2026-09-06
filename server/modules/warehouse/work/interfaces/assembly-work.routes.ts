import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";
import { assemblyPackingCommandSchema, assemblyPackingResultSchema } from "@shared/warehouse-assembly-packing";
import {
  assemblyQueueRequestSchema, assemblyTaskCommandSchema, assemblyQueueSchema, assemblyTaskSchema, assemblyTaskResultSchema,
  createAssemblyHandoffSchema, completeAssemblyTaskSchema, workEvidenceIdSchema,
} from "@shared/warehouse-assembly-work";
import { requireAuth } from "../../../../routes/middleware";
import { logger } from "../../../../platform/observability/logger";
import type { AssemblyWorkService } from "../application/assembly-work.service";
import type { AssemblyExecutionService } from "../application/assembly-execution.service";
import { assemblyExecutionContextsSchema, assemblyOrderInstructionsSchema, assemblyTaskViewSchema, assemblyOutputPickCommandSchema } from "@shared/warehouse-assembly-execution";
import { InventoryAvailabilityClaimRepositoryError } from "../../../inventory-planning/infrastructure/inventory-availability-claim.repository";
import { AssemblyOrderAuthorityError } from "../../../orders/assembly-handoff-authority";
import { WmsOrderItemCommandError } from "../../../wms/order-item-commands";
import { WarehouseWorkError } from "../domain/work-configuration";
import { BuildDomainError } from "../../../inventory/domain/build.domain";
import { CanonicalClaimInventoryMutationError } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { canonicalAvailabilityClaimBuildHandoffResultSchema, canonicalAvailabilityClaimOperationExecutionResultSchema, canonicalAvailabilityClaimPickResultSchema } from "@shared/types/inventory-availability-claims";

interface Services {
  assemblyPacking?: Pick<import("../application/assembly-packing.service").AssemblyPackingService, "ready">;
  assemblyWork: Pick<AssemblyWorkService, "queue" | "get" | "command" | "handoff" | "complete">;
  assemblyExecution?: Pick<AssemblyExecutionService, "contexts" | "order" | "task" | "pickOutput">;
}
const integerParameter = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));

export function registerAssemblyWorkRoutes(app: Express, injected?: Services): void {
  const services = (req: Request): Services => injected ?? req.app.locals.services;
  const actor = (req: Request) => req.session.user!.id;
  function handler<T>(parse: (req: Request) => T, run: (req: Request, input: T) => Promise<unknown>, output: z.ZodTypeAny) {
    return async (req: Request, res: Response) => {
      let input: T;
      try { input = parse(req); } catch (error) {
        if (!(error instanceof ZodError)) {
          logger.error("warehouse_assembly_input_validation_failed", { error_code: "WORK_REQUEST_FAILED", error_class: "fatal" });
          res.status(500).json({ code: "WORK_REQUEST_FAILED", message: "Assembly request validation failed", context: {} });
          return;
        }
        logger.warn("warehouse_assembly_request_rejected", { actor_id: req.session.user?.id, error_code: "WORK_INPUT_INVALID", error_class: "permanent" });
        res.status(400).json({ code: "WORK_INPUT_INVALID", message: "Invalid assembly work request", context: { issues: error.issues } });
        return;
      }
      try { res.json(output.parse(await run(req, input))); } catch (error) {
        const domain = error instanceof WarehouseWorkError || error instanceof AssemblyOrderAuthorityError;
        const claim = error instanceof InventoryAvailabilityClaimRepositoryError || error instanceof BuildDomainError || error instanceof CanonicalClaimInventoryMutationError || error instanceof WmsOrderItemCommandError;
        const sqlState = error && typeof error === "object" && "code" in error ? String(error.code) : null;
        const transient = ["40001", "40P01", "55P03"].includes(sqlState ?? "") || (claim && /RETRY_EXHAUSTED$/.test(error.code));
        const status = transient ? 503 : domain ? error.status : claim ? 409 : sqlState === "23505" ? 409 : 500;
        const code = transient ? "WORK_RETRY_REQUIRED" : domain || claim ? error.code : sqlState === "23505" ? "WORK_COMMAND_CONFLICT" : "WORK_REQUEST_FAILED";
        const message = domain || claim ? error.message : transient ? "Retry with the same command ID; do not repeat physical work" : "Assembly work request failed";
        logger.error("warehouse_assembly_request_failed", { actor_id: req.session.user?.id, error_code: code,
          error_class: transient ? "transient" : status === 500 ? "fatal" : "permanent", path: req.path, sql_state: sqlState });
        res.status(status).json({ code, message, context: domain || claim ? error.context : {} });
      }
    };
  }
  const root = "/api/warehouse/assembly-work";
  app.post(`${root}/:id/packing-ready`, requireAuth, handler((req) => ({ id: workEvidenceIdSchema.parse(req.params.id), command: assemblyPackingCommandSchema.parse(req.body) }),
    (req, input) => {
      const service = services(req).assemblyPacking;
      if (!service) throw new WarehouseWorkError("WORK_EXECUTION_NOT_CONFIGURED", "Packing handoff is not configured", 503);
      return service.ready(actor(req), input.id, input.command);
    }, assemblyPackingResultSchema));
  const execution = (req: Request) => {
    const service = services(req).assemblyExecution;
    if (!service) throw new WarehouseWorkError("WORK_EXECUTION_NOT_CONFIGURED", "Assembly execution is not configured", 503);
    return service;
  };
  app.get(`${root}/contexts`, requireAuth, handler(() => null,
    (req) => execution(req).contexts(actor(req)), assemblyExecutionContextsSchema));
  app.get(`${root}/orders/:orderId`, requireAuth, handler((req) => integerParameter.parse(req.params.orderId),
    (req, orderId) => execution(req).order(actor(req), orderId), assemblyOrderInstructionsSchema));
  app.get(`${root}/:id/view`, requireAuth, handler((req) => workEvidenceIdSchema.parse(req.params.id),
    (req, id) => execution(req).task(actor(req), id), assemblyTaskViewSchema));
  app.post(`${root}/:id/pick-output`, requireAuth, handler((req) => ({ id: workEvidenceIdSchema.parse(req.params.id), command: assemblyOutputPickCommandSchema.parse(req.body) }),
    (req, input) => execution(req).pickOutput(actor(req), input.id, input.command), canonicalAvailabilityClaimPickResultSchema));
  app.get(root, requireAuth, handler((req) => assemblyQueueRequestSchema.parse({
    warehouseId: integerParameter.parse(req.query.warehouseId), stationId: req.query.stationId,
    beforeId: req.query.beforeId, limit: req.query.limit === undefined ? undefined : integerParameter.parse(req.query.limit),
    includeClosed: req.query.includeClosed === undefined ? false : z.enum(["true", "false"]).parse(req.query.includeClosed) === "true",
  }), (req, input) => services(req).assemblyWork.queue(actor(req), input), assemblyQueueSchema));
  app.get(`${root}/:id`, requireAuth, handler((req) => workEvidenceIdSchema.parse(req.params.id),
    (req, id) => services(req).assemblyWork.get(actor(req), id), assemblyTaskSchema));
  app.post(`${root}/:id/commands`, requireAuth, handler((req) => ({
    id: workEvidenceIdSchema.parse(req.params.id), command: assemblyTaskCommandSchema.parse(req.body),
  }), (req, input) => services(req).assemblyWork.command(actor(req), input.id, input.command), assemblyTaskResultSchema));
  app.post(`${root}/handoffs`, requireAuth, handler((req) => createAssemblyHandoffSchema.parse(req.body),
    (req, input) => services(req).assemblyWork.handoff(actor(req), input), canonicalAvailabilityClaimBuildHandoffResultSchema));
  app.post(`${root}/:id/complete`, requireAuth, handler((req) => ({
    id: workEvidenceIdSchema.parse(req.params.id), command: completeAssemblyTaskSchema.parse(req.body),
  }), (req, input) => services(req).assemblyWork.complete(actor(req), input.id, input.command), canonicalAvailabilityClaimOperationExecutionResultSchema));
}
