import { randomUUID } from "node:crypto";
import { costReportDeliveryListSchema, type CostReportDeliveryList, type CostReportAcknowledgement, type CostReportEnvelope } from "@shared/procurement/cost-report-delivery";
import { CostReportingRepository } from "./cost-reporting.repository";
import { parseReportConfiguration, reportFailure, type ReportTransportConfiguration } from "./cost-reporting.domain";
import { sendCostReport } from "./cost-reporting.transport";

export interface CostReportingDependencies {
  repository: CostReportingRepository;
  configuration: () => ReportTransportConfiguration | null;
  clock: () => Date;
  newId: () => string;
  send: (configuration: ReportTransportConfiguration, envelope: CostReportEnvelope) => Promise<CostReportAcknowledgement>;
  log: (event: Record<string,unknown>) => void;
}
export class CostReportingService {
  constructor(private readonly dependencies: CostReportingDependencies) {}
  async status(purchaseOrderId: number): Promise<CostReportDeliveryList> {
    let config: ReportTransportConfiguration | null = null, configuration: CostReportDeliveryList["configuration"] = "not_configured";
    try { config = this.dependencies.configuration(); if (config) configuration = config.enabled ? "enabled" : "disabled"; }
    catch { configuration = "invalid"; }
    return costReportDeliveryListSchema.parse({purchaseOrderId,configuration,...await this.dependencies.repository.list(purchaseOrderId,config?.id ?? null)});
  }
  async retry(input: Parameters<CostReportingRepository["retry"]>[0]): Promise<Awaited<ReturnType<CostReportingRepository["retry"]>>> {
    // Durable replays are read before configuration checks by the repository.
    let config: ReportTransportConfiguration | null = null;
    try { config = this.dependencies.configuration(); } catch { /* Presented as unavailable for a new intent; retained replay still works. */ }
    return this.dependencies.repository.retry(input,config,this.dependencies.clock());
  }
  async tick(): Promise<{enqueued: number; claimed: number; acknowledged: number; failed: number}> {
    const d = this.dependencies, configuration = d.configuration();
    if (!configuration?.enabled) return {enqueued:0,claimed:0,acknowledged:0,failed:0};
    const enqueued = await d.repository.enqueue(configuration,d.clock(),d.newId);
    const claims = await d.repository.claim(configuration,d.clock(),d.newId);
    // All ten bounded requests start together. Serial delivery could leave later
    // claims waiting longer than the 60-second lease before they even start.
    const results = await Promise.allSettled(claims.map(async (claim) => {
      let outcome: {acknowledgement:CostReportAcknowledgement} | {error:ReturnType<typeof reportFailure>};
      try { outcome = {acknowledgement:await d.send(configuration,claim.envelope)}; }
      catch (error) { outcome = {error:reportFailure(error)}; }
      const retained = await d.repository.finish(claim,outcome,d.clock());
      d.log({event:"cost_report_delivery",deliveryId:claim.id,attempt:claim.attemptCount,retained,
        outcome:"acknowledgement" in outcome ? "acknowledged" : "failed",errorCode:"error" in outcome ? outcome.error.code : null});
      return retained && "acknowledgement" in outcome;
    }));
    for (const result of results) if (result.status === "rejected") d.log({event:"cost_report_persistence_failed",code:reportFailure(result.reason).code});
    const acknowledged = results.filter((result) => result.status === "fulfilled" && result.value).length;
    return {enqueued,claimed:claims.length,acknowledged,failed:claims.length-acknowledged};
  }
}
export function createCostReportingService(repository: CostReportingRepository): CostReportingService {
  return new CostReportingService({repository,configuration:() => parseReportConfiguration(process.env),clock:() => new Date(),newId:randomUUID,send:sendCostReport,
    log:(event) => console.info(JSON.stringify(event))});
}

/** Process-local scheduling is not delivery authority. PostgreSQL owns leases,
 * retries and completion, so several app processes may run this scheduler. */
export function startCostReportingWorker(service: CostReportingService, log: (event: Record<string,unknown>) => void = (event) => console.error(JSON.stringify(event))): () => Promise<void> {
  const intervalMs = 30_000;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined;
  const run = (): void => {
    if (stopped) return;
    active = service.tick().then(() => undefined).catch((error: unknown) => log({event:"cost_reporting_worker_failed",code:reportFailure(error).code})).finally(() => {
      if (!stopped) { timer = setTimeout(run,intervalMs); timer.unref(); }
    });
  };
  run();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
