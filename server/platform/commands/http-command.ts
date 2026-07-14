import { createHash } from "node:crypto";
import type { Request } from "express";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  FINANCIAL_COMMAND_CONTRACT_VERSION,
  FinancialCommandError,
  type FinancialCommandActorType,
  type FinancialCommandDescriptor,
} from "./transactional-command.service";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,99}$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type HttpFinancialCommandOptions = {
  actorType?: FinancialCommandActorType;
  actorId?: string;
  routeTemplate: string;
  resourceKey: string;
  commandName: string;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function hashHttpFinancialCommand(input: {
  method: string;
  routeTemplate: string;
  resourceKey: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}): string {
  const canonical = canonicalJson({
    method: input.method.toUpperCase(),
    routeTemplate: input.routeTemplate,
    resourceKey: input.resourceKey,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function financialCommandFromRequest(
  req: Request,
  options: HttpFinancialCommandOptions,
): FinancialCommandDescriptor {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    throw new FinancialCommandError(
      "Transactional idempotency is only valid for mutating requests",
      500,
      "FINANCIAL_COMMAND_METHOD_INVALID",
    );
  }

  const standardKey = firstHeader(req.headers["idempotency-key"])?.trim();
  const legacyKey = firstHeader(req.headers["x-idempotency-key"])?.trim();
  if (standardKey && legacyKey && standardKey !== legacyKey) {
    throw new FinancialCommandError(
      "Idempotency-Key and X-Idempotency-Key must match when both are provided",
      400,
      "FINANCIAL_COMMAND_IDEMPOTENCY_HEADERS_CONFLICT",
    );
  }
  const idempotencyKey = standardKey || legacyKey;
  if (!idempotencyKey) {
    throw new FinancialCommandError(
      "Idempotency-Key header is required for this financial command",
      400,
      "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new FinancialCommandError(
      "Idempotency-Key must be 8-200 characters using letters, numbers, '.', '_', ':', '/', or '-'",
      400,
      "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_INVALID",
    );
  }

  const actorType = options.actorType ?? "user";
  const actorId = options.actorId?.trim()
    || (req as any).user?.id
    || (req as any).session?.user?.id;
  if (!actorId) {
    throw new FinancialCommandError(
      "An authenticated command actor is required",
      401,
      "FINANCIAL_COMMAND_ACTOR_REQUIRED",
    );
  }
  if (!options.routeTemplate.startsWith("/") || options.routeTemplate.length > 255) {
    throw new TypeError("Financial command routeTemplate is invalid");
  }
  if (!options.resourceKey || options.resourceKey.length > 255) {
    throw new TypeError("Financial command resourceKey is invalid");
  }
  if (!COMMAND_NAME_PATTERN.test(options.commandName)) {
    throw new TypeError("Financial command commandName is invalid");
  }

  return {
    actorType,
    actorId: String(actorId),
    method,
    routeTemplate: options.routeTemplate,
    resourceKey: options.resourceKey,
    idempotencyKey,
    requestHash: hashHttpFinancialCommand({
      method,
      routeTemplate: options.routeTemplate,
      resourceKey: options.resourceKey,
      params: req.params,
      query: req.query,
      body: req.body,
    }),
    commandName: options.commandName,
    contractVersion: FINANCIAL_COMMAND_CONTRACT_VERSION,
  };
}
