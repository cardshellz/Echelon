import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { rfqConversionResultSchema, type RfqQuoteEvidence } from "@shared/procurement/rfq-workflow";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { buildPurchaseRecommendationRunInput } from "../../purchase-recommendation-snapshot.service";
import { generatePurchasingRecommendations, type AutoDraftRecommendationSettings, type PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import { attachSupplierSourcingCandidates } from "../../supplier-sourcing.repository";
import { createRfqWorkflowCommands, rfqWorkflowCommandScope, RFQ_WORKFLOW_COMMAND_PRINCIPAL } from "../../rfq-workflow.commands";
import { createRfqWorkflowService, type RfqWorkflowCommand } from "../../rfq-workflow.service";
import type { createPurchasingService } from "../../purchasing.service";

/** Actual migrations required by the planning snapshot and RFQ owners. */
export const RFQ_CONTROLLED_MIGRATIONS = [
  "130_atomic_recommendation_po_handoffs.sql",
  "136_financial_command_results.sql",
  "140_financial_command_operations.sql",
  "148_purchase_rfq_requests.sql",
  "150_purchase_recommendation_run_automation.sql",
  "158_rfq_allocation_override_evidence.sql",
  "162_purchase_forecast_observations.sql",
  "168_purchase_forecast_overlay_contributions.sql",
  "169_purchase_forecast_overlay_capture_coverage.sql",
  "172_purchase_forecast_policy_cohorts.sql",
  "174_scheduled_purchase_recommendation_runs.sql",
  "223_purchase_planning_policy.sql",
  "224_rfq_quote_revisions_and_purchase_links.sql",
  "225_purchase_replacement_forecast_capture.sql",
  "228_supplier_sourcing_policies.sql",
  "232_rfq_product_reservation_scope.sql",
] as const;

export interface ControlledRfqProposalInput {
  database: ReturnType<typeof drizzle<typeof schema>>;
  purchasingOwner: ReturnType<typeof createPurchasingService>;
  actorId: string;
  at: Date;
  key: string;
  lookbackDays: number;
  settings: AutoDraftRecommendationSettings;
  rows: PurchasingRecommendationRawRow[];
}

/**
 * The caller seeds only synthetic catalog/demand/stock observations. Every saved
 * recommendation, RFQ, quote revision, PO and link is created by its real owner.
 * This is service/SQL acceptance, not sales ingestion or browser acceptance.
 */
export async function createControlledRfqProposal(input: ControlledRfqProposalInput) {
  const rows = await attachSupplierSourcingCandidates(input.database, input.rows);
  const recommendations = generatePurchasingRecommendations({
    rows, asOf: input.at, lookbackDays: input.lookbackDays,
    autoDraftSettings: input.settings,
  });
  const runInput = buildPurchaseRecommendationRunInput({
    recommendationResult: recommendations, settings: input.settings,
    lookbackDays: input.lookbackDays, asOf: input.at, evaluatedCount: input.rows.length,
  });
  const snapshot = await input.purchasingOwner.snapshotPurchaseRecommendations(runInput, input.actorId);
  if (snapshot.lines.length !== input.rows.length) {
    throw new Error(`Controlled RFQ scenario expected ${input.rows.length} proposals; saved ${snapshot.lines.length}`);
  }
  const request = {
    idempotencyKey: `${input.key}-request`,
    requestNote: "Controlled local acceptance: operator reviewed the saved planning recommendations",
    lines: snapshot.lines.map((line: typeof schema.purchaseRecommendationLines.$inferSelect) => {
      if (line.preferredVendorId === null || line.preferredVendorProductId === null) {
        throw new Error(`Controlled RFQ product ${line.productId} has no selected supplier mapping`);
      }
      return { recommendationLineId: line.id, vendorId: line.preferredVendorId,
        vendorProductId: line.preferredVendorProductId, requestedPieces: line.recommendedPieces };
    }),
  };
  const batch = await input.purchasingOwner.createRfqBatch(request, input.actorId);
  if (batch.rfqs.length !== 1) throw new Error("Controlled RFQ scenario requires one supplier RFQ");
  const rfqId = Number(batch.rfqs[0].id);
  const workflow = createRfqWorkflowService(input.database, input.purchasingOwner);
  const commands = createRfqWorkflowCommands(workflow,
    createDrizzleFinancialCommandRepository(input.database), () => input.at);
  function descriptor(command: RfqWorkflowCommand, key: string): FinancialCommandDescriptor {
    const scope = rfqWorkflowCommandScope(command);
    return { actorType: "service", actorId: RFQ_WORKFLOW_COMMAND_PRINCIPAL, ...scope,
      idempotencyKey: `${input.key}-${key}`,
      requestHash: hashHttpFinancialCommand({ ...scope, body: command.body }), contractVersion: 1 };
  }
  return { ...input, recommendations, runInput, snapshot, request, batch, rfqId, workflow, commands, descriptor };
}

export type ControlledRfqProposal = Awaited<ReturnType<typeof createControlledRfqProposal>>;

export async function captureControlledRfqQuote(
  proposal: ControlledRfqProposal, productId: number, quote: RfqQuoteEvidence, key: string,
) {
  const before = await proposal.workflow.getDetail(proposal.rfqId);
  const line = before.lines.find((candidate) => candidate.productId === productId);
  if (!line) throw new Error(`Controlled RFQ has no product ${productId}`);
  const command: RfqWorkflowCommand = { operation: "capture_quote", rfqId: proposal.rfqId,
    lineId: line.id, body: { expectedVersion: before.version, quote } };
  const identity = proposal.descriptor(command, key);
  const result = await proposal.commands.execute(command, proposal.actorId, identity);
  return { command, identity, result };
}

export async function prepareControlledRfqConversion(
  proposal: ControlledRfqProposal, productIds: number[], quantityOverrideReason: string | null, key: string,
) {
  const before = await proposal.workflow.getDetail(proposal.rfqId);
  const lines = productIds.map((productId) => {
    const line = before.lines.find((candidate) => candidate.productId === productId);
    if (!line?.latestQuote) throw new Error(`Controlled RFQ product ${productId} has no recorded quote`);
    return { rfqLineId: line.id, quoteRevisionId: line.latestQuote.id };
  });
  const command: RfqWorkflowCommand = { operation: "convert", rfqId: proposal.rfqId,
    body: { expectedVersion: before.version, lines, quantityOverrideReason } };
  return { command, identity: proposal.descriptor(command, key) };
}

/** The FLOW cost test uses these exact created POs for its subsequent receipts. */
export async function createControlledRfqPurchases(input: ControlledRfqProposalInput & {
  quotes: Array<{ productId: number; quote: RfqQuoteEvidence; quantityOverrideReason?: string }>;
}) {
  const proposal = await createControlledRfqProposal(input);
  for (const [index, selected] of input.quotes.entries()) {
    const capture = await captureControlledRfqQuote(proposal, selected.productId, selected.quote, `quote-${index}`);
    if (capture.result.httpStatus !== 200) {
      throw new Error(`Controlled quote capture failed: ${JSON.stringify(capture.result.body)}`);
    }
  }
  const purchases = new Map<number, ReturnType<typeof rfqConversionResultSchema.parse>>();
  for (const [index, selected] of input.quotes.entries()) {
    const conversion = await prepareControlledRfqConversion(proposal, [selected.productId],
      selected.quantityOverrideReason ?? null, `convert-${index}`);
    const result = await proposal.commands.execute(conversion.command, input.actorId, conversion.identity);
    if (result.httpStatus !== 201) {
      throw new Error(`Controlled quote conversion failed: ${JSON.stringify(result.body)}`);
    }
    purchases.set(selected.productId, rfqConversionResultSchema.parse(result.body));
  }
  return { proposal, purchases };
}
