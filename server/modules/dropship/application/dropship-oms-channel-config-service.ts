import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const commandActorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

const configureDropshipOmsChannelInputSchema = z.object({
  channelId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict();

export interface DropshipOmsChannelOption {
  channelId: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  isDropshipOmsChannel: boolean;
  markerSources: string[];
  updatedAt: Date;
}

export interface DropshipOmsChannelConfigOverview {
  currentChannelId: number | null;
  currentChannelCount: number;
  channels: DropshipOmsChannelOption[];
  generatedAt: Date;
}

export interface DropshipOmsChannelConfigMutationResult {
  config: DropshipOmsChannelConfigOverview;
  selectedChannel: DropshipOmsChannelOption;
  idempotentReplay: boolean;
}

export interface DropshipOmsChannelConfigRepository {
  getOverview(input: { generatedAt: Date }): Promise<DropshipOmsChannelConfigOverview>;
  configure(
    input: NormalizedConfigureDropshipOmsChannelInput & DropshipOmsChannelConfigCommandContext,
  ): Promise<DropshipOmsChannelConfigMutationResult>;
}

export interface DropshipOmsChannelConfigCommandContext {
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "admin" | "system";
    actorId?: string;
  };
  now: Date;
}

export type ConfigureDropshipOmsChannelInput = z.infer<typeof configureDropshipOmsChannelInputSchema>;
export type NormalizedConfigureDropshipOmsChannelInput = Omit<ConfigureDropshipOmsChannelInput, "idempotencyKey" | "actor">;

export class DropshipOmsChannelConfigService {
  constructor(private readonly deps: {
    repository: DropshipOmsChannelConfigRepository;
    clock: DropshipClock;
    logger: DropshipLogger;
  }) {}

  async getOverview(): Promise<DropshipOmsChannelConfigOverview> {
    return this.deps.repository.getOverview({ generatedAt: this.deps.clock.now() });
  }

  async configure(input: unknown): Promise<DropshipOmsChannelConfigMutationResult> {
    const parsed = configureDropshipOmsChannelInputSchema.parse(input);
    const normalized: NormalizedConfigureDropshipOmsChannelInput = {
      channelId: parsed.channelId,
    };
    const result = await this.deps.repository.configure({
      ...normalized,
      idempotencyKey: parsed.idempotencyKey.trim(),
      requestHash: hashDropshipOmsChannelConfigCommand("dropship_oms_channel_configured", normalized),
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_OMS_CHANNEL_CONFIG_REPLAYED"
        : "DROPSHIP_OMS_CHANNEL_CONFIGURED",
      message: result.idempotentReplay
        ? "Dropship OMS channel config command was replayed by idempotency key."
        : "Dropship OMS channel config command completed.",
      context: {
        channelId: result.selectedChannel.channelId,
        currentChannelCount: result.config.currentChannelCount,
        idempotentReplay: result.idempotentReplay,
      },
    });
    return result;
  }
}

export function hashDropshipOmsChannelConfigCommand(commandType: string, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ commandType, payload: sortJsonValue(payload) }))
    .digest("hex");
}

export function makeDropshipOmsChannelConfigLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOmsChannelConfigEvent("info", event),
    warn: (event) => logDropshipOmsChannelConfigEvent("warn", event),
    error: (event) => logDropshipOmsChannelConfigEvent("error", event),
  };
}

export const systemDropshipOmsChannelConfigClock: DropshipClock = {
  now: () => new Date(),
};

export function omsChannelConfigValidationError(error: unknown): DropshipError | null {
  if (error && typeof error === "object" && "issues" in error) {
    return new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_INVALID_INPUT",
      "Dropship OMS channel configuration input failed validation.",
      { issues: (error as { issues: unknown }).issues },
    );
  }
  return null;
}

function sortJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
}

function logDropshipOmsChannelConfigEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
