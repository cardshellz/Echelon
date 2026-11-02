import { z } from "zod";
import {
  stockLinkCheckAgainRequestSchema, stockLinkContinueRequestSchema, stockLinkControlResultSchema, stockLinkStatusRequestSchema,
  stockLinkStatusSchema, stockLinkSwitchRequestSchema, type StockLinkControlResult, type StockLinkStatus,
  type StockLinkSupportedStatus,
} from "@shared/types/stock-link";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import type { StockLinkControlKind, StockLinkControlRequest } from "../domain/stock-link-controls";

/**
 * Channel Inventory's stock-link controls (channels PR2, PLAN-CH2 v4.1 §7.3): the status of one destination and a
 * person's three writes, the per-store switch, Continue (release held retires, retry a pause now) and Check again
 * (failed, flagged, linked and Shopify status-ineligible waiting sizes due now, a halt cleared). Validates every input against the shared contract,
 * names the actor and takes the time from the injected clock; the store makes the change, its audit row and the
 * revision guard in one transaction. Every change is logged at INFO with before → after; a control that changes
 * nothing (the switch already in that position, Continue with nothing held or paused) writes nothing and logs DEBUG.
 */

const ACTION = "inventory_availability.stock_link.control";
/** stock_link_destinations.retires_released_by is varchar(100), as every audited actor of this module. */
const actorSchema = z.string().trim().min(1).max(100);

export interface StockLinkControlCommand {
  readonly publicationTargetId: number;
  readonly expectedRevision: string;
  readonly request: StockLinkControlRequest;
  readonly reason: string | null;
  readonly actorId: string;
  readonly occurredAt: Date;
}

/** The destination as a control sees it before and after (the audit row's before → after). */
export interface StockLinkControlSnapshot {
  readonly autoLinkEnabled: boolean;
  readonly revision: string;
  readonly paused: { code: string; since: string; until: string } | null;
  readonly halted: { code: string; at: string } | null;
  readonly retiresReleased: { at: string; by: string } | null;
}

export interface StockLinkControlOutcome {
  readonly kind: StockLinkControlKind;
  readonly changed: boolean;
  readonly before: StockLinkControlSnapshot;
  readonly after: StockLinkControlSnapshot;
  /** Check again: the sizes made due now (sorted). */
  readonly productVariantIdsMadeDue: readonly number[];
  readonly status: StockLinkSupportedStatus;
}

/** The status route's answer for a destination the engine has no policy for (the client hides the controls). */
export interface StockLinkUnsupportedStatus { supported: false; publicationTargetId: number }

export interface StockLinkControlsStore {
  readStatus(publicationTargetId: number, now: Date): Promise<StockLinkSupportedStatus | StockLinkUnsupportedStatus>;
  apply(command: StockLinkControlCommand): Promise<StockLinkControlOutcome>;
}

export interface StockLinkControlsLogger {
  info(action: string, data: Record<string, unknown>): void;
  debug(action: string, data: Record<string, unknown>): void;
}

export class StockLinkControlsService {
  constructor(
    private readonly store: StockLinkControlsStore,
    private readonly clock: () => Date,
    private readonly log: StockLinkControlsLogger,
    /** Whether the runner's kill switch is on in this process (composition: stockLinkRunnerDisableReason). */
    private readonly runnerOff: () => boolean = () => false,
  ) {}

  async status(query: unknown): Promise<StockLinkStatus> {
    const request = parse(stockLinkStatusRequestSchema, query, "status");
    const status = await this.store.readStatus(request.publicationTargetId, this.now());
    return stockLinkStatusSchema.parse(status.supported ? this.withRunner(status) : status);
  }

  async setSwitch(input: unknown, actor: string): Promise<StockLinkControlResult> {
    const request = parse(stockLinkSwitchRequestSchema, input, "switch");
    return this.apply("switch", { kind: "switch", enabled: request.enabled }, request, request.reason, actor);
  }

  async continue(input: unknown, actor: string): Promise<StockLinkControlResult> {
    const request = parse(stockLinkContinueRequestSchema, input, "continue");
    return this.apply("continue", { kind: "continue" }, request, null, actor);
  }

  async checkAgain(input: unknown, actor: string): Promise<StockLinkControlResult> {
    const request = parse(stockLinkCheckAgainRequestSchema, input, "check-again");
    return this.apply("check_again", { kind: "check_again" }, request, null, actor);
  }

  private async apply(kind: StockLinkControlKind, controlRequest: StockLinkControlRequest,
    target: { publicationTargetId: number; expectedRevision: string }, reason: string | null, actorInput: string):
    Promise<StockLinkControlResult> {
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new InventoryAvailabilityMasterDataError(401, "STOCK_LINK_CONTROL_ACTOR_REQUIRED",
        "An authenticated operator is required.");
    }
    const outcome = await this.store.apply({ publicationTargetId: target.publicationTargetId,
      expectedRevision: target.expectedRevision, request: controlRequest, reason, actorId: actor.data, occurredAt: this.now() });
    const event = { publication_target_id: target.publicationTargetId, control: kind, actor: actor.data };
    if (outcome.changed) {
      this.log.info(ACTION, { ...event, outcome: "changed", before: outcome.before, after: outcome.after,
        rows_made_due: outcome.productVariantIdsMadeDue.length });
    } else {
      this.log.debug(ACTION, { ...event, outcome: "unchanged", before: outcome.before });
    }
    return stockLinkControlResultSchema.parse(this.withRunner(outcome.status));
  }

  /**
   * Every answer says whether the server's kill switch stops linking (review CMP-1): the controls still write (a person
   * can switch, continue or ask again), but nothing happens until the runner runs again.
   */
  private withRunner(status: StockLinkSupportedStatus): StockLinkSupportedStatus {
    return { ...status, runnerOff: this.runnerOff() };
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new InventoryAvailabilityMasterDataError(500, "STOCK_LINK_CONTROL_CLOCK_INVALID",
        "The stock-link control clock returned an invalid timestamp.");
    }
    return now;
  }
}

function parse<TSchema extends z.ZodType>(schema: TSchema, value: unknown, control: string): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(400, "STOCK_LINK_CONTROL_INVALID_REQUEST",
      `Review the stock-link ${control} request fields.`,
      parsed.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`));
  }
  return parsed.data;
}
