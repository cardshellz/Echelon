import type { Express } from "express";
import { z } from "zod";

import { pool } from "../../db";
import { requirePermission } from "../../routes/middleware";
import {
  FinancialCommandOperationsError,
  getFinancialCommandOperations,
  getFinancialCommandOperationsDetail,
  rearmDeadFinancialCommand,
} from "./financial-command-operations.service";

const listQuerySchema = z.object({
  status: z.enum([
    "all",
    "attention",
    "claimed",
    "succeeded",
    "rejected",
    "retryable",
    "dead",
  ]).default("attention"),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const rearmBodySchema = z.object({
  reason: z.string().trim().min(10).max(1000),
}).strict();

export function registerFinancialCommandOperationsRoutes(app: Express): void {
  app.get(
    "/api/operations/financial-commands",
    requirePermission("operations", "view"),
    async (req, res) => {
      try {
        const query = listQuerySchema.parse(req.query);
        res.setHeader("Cache-Control", "private, no-store");
        res.json(await getFinancialCommandOperations(pool, query));
      } catch (error) {
        sendError(res, error, "Failed to load financial command operations");
      }
    },
  );

  app.get(
    "/api/operations/financial-commands/:id",
    requirePermission("operations", "view_technical"),
    async (req, res) => {
      try {
        const id = parseCommandId(req.params.id);
        res.setHeader("Cache-Control", "private, no-store");
        res.json(await getFinancialCommandOperationsDetail(pool, id));
      } catch (error) {
        sendError(res, error, "Failed to load financial command detail");
      }
    },
  );

  app.post(
    "/api/operations/financial-commands/:id/rearm",
    requirePermission("operations", "triage"),
    async (req, res) => {
      try {
        const commandId = parseCommandId(req.params.id);
        const body = rearmBodySchema.parse(req.body);
        const operatorId = String(req.session.user?.id ?? "").trim();
        if (!operatorId) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        res.json(await rearmDeadFinancialCommand(pool, {
          commandId,
          operatorId,
          reason: body.reason,
        }));
      } catch (error) {
        sendError(res, error, "Failed to re-arm financial command");
      }
    },
  );
}

function parseCommandId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new FinancialCommandOperationsError(
      "Financial command id must be a positive integer",
      400,
      "FINANCIAL_COMMAND_ID_INVALID",
    );
  }
  return id;
}

function sendError(res: any, error: unknown, fallback: string): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "Invalid financial command operations request",
      code: "FINANCIAL_COMMAND_OPERATIONS_INVALID",
      details: error.flatten(),
    });
    return;
  }
  if (error instanceof FinancialCommandOperationsError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  console.error(`[Financial Command Operations] ${fallback}`, error);
  res.status(500).json({ error: fallback, code: "FINANCIAL_COMMAND_OPERATIONS_FAILED" });
}
