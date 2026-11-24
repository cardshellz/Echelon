/**
 * Scheduled Sync Service
 *
 * Manages periodic sync jobs that keep Echelon and Shopify in lockstep.
 * Configurable interval, enable/disable, and dry-run mode.
 *
 * Default schedule: every 5 minutes
 *   1. Run allocation engine for all active products
 *   2. Push inventory to channels based on allocation results
 *   3. Push pricing changes to channels
 *   4. Pull unlocked fields from channels back to Echelon
 *
 * Safety:
 *   - Prevents concurrent runs (single-flight lock)
 *   - Logs every cycle with timing and result summary
 *   - Can be toggled on/off without restart
 *   - Supports dry-run mode for verification
 */

import type { EchelonSyncOrchestrator, FullSyncResult, SyncOrchestratorConfig } from "./echelon-sync-orchestrator.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledSyncConfig {
  /** Sync interval in milliseconds. Default: 5 minutes (300_000) */
  intervalMs: number;
  /** Whether scheduled sync is enabled */
  enabled: boolean;
  /** Run in dry-run mode (log what would happen, don't push) */
  dryRun: boolean;
}

export interface ScheduledSyncStatus {
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
  running: boolean;
  lastRunAt: Date | null;
  lastRunDurationMs: number | null;
  lastRunResult: FullSyncResult | null;
  totalRuns: number;
  totalErrors: number;
}

const DEFAULT_CONFIG: ScheduledSyncConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  enabled: false, // Start disabled — explicitly enable after verification
  dryRun: true, // Start in dry-run — switch to live after verification
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ScheduledSyncService {
  private config: ScheduledSyncConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: Date | null = null;
  private lastRunDurationMs: number | null = null;
  private lastRunResult: FullSyncResult | null = null;
  private totalRuns = 0;
  private totalErrors = 0;

  constructor(
    private readonly orchestrator: EchelonSyncOrchestrator,
    config?: Partial<ScheduledSyncConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the scheduled sync timer.
   * Does nothing if already started.
   */
  start(): void {
    if (this.timer) {
      console.log("[ScheduledSync] Already running");
      return;
    }

    if (!this.config.enabled) {
      console.log("[ScheduledSync] Not enabled — call enable() first or pass enabled: true");
      return;
    }

    console.log(
      `[ScheduledSync] Starting — interval=${this.config.intervalMs}ms ` +
      `dryRun=${this.config.dryRun} enabled=${this.config.enabled}`,
    );

    this.timer = setInterval(() => this.tick(), this.config.intervalMs);

    // Run immediately on start
    this.tick();
  }

  /**
   * Stop the scheduled sync timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[ScheduledSync] Stopped");
    }
  }

  /**
   * Enable scheduled sync and start the timer.
   */
  enable(): void {
    this.config.enabled = true;
    if (!this.timer) {
      this.start();
    }
  }

  /**
   * Disable scheduled sync and stop the timer.
   */
  disable(): void {
    this.config.enabled = false;
    this.stop();
  }

  /**
   * Update configuration. Restarts timer if interval changed.
   */
  updateConfig(updates: Partial<ScheduledSyncConfig>): void {
    const intervalChanged = updates.intervalMs && updates.intervalMs !== this.config.intervalMs;
    this.config = { ...this.config, ...updates };

    if (intervalChanged && this.timer) {
      this.stop();
      if (this.config.enabled) {
        this.start();
      }
    }

    if (updates.enabled === true && !this.timer) {
      this.start();
    } else if (updates.enabled === false) {
      this.stop();
    }

    console.log(`[ScheduledSync] Config updated:`, this.config);
  }

  /**
   * Run a single sync cycle manually (outside the timer).
   */
  async runOnce(overrideConfig?: Partial<SyncOrchestratorConfig>): Promise<FullSyncResult> {
    const syncConfig: SyncOrchestratorConfig = {
      dryRun: overrideConfig?.dryRun ?? this.config.dryRun,
    };

    return this.executeSyncCycle(syncConfig);
  }

  /**
   * Get current status.
   */
  getStatus(): ScheduledSyncStatus {
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      intervalMs: this.config.intervalMs,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastRunDurationMs: this.lastRunDurationMs,
      lastRunResult: this.lastRunResult,
      totalRuns: this.totalRuns,
      totalErrors: this.totalErrors,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Timer tick — runs the sync cycle with single-flight protection.
   */
  private async tick(): Promise<void> {
    if (!this.config.enabled) return;

    // Single-flight lock: skip if already running
    if (this.running) {
      console.log("[ScheduledSync] Skipping tick — previous cycle still running");
      return;
    }

    try {
      await this.executeSyncCycle({ dryRun: this.config.dryRun });
    } catch (err: any) {
      console.error(`[ScheduledSync] Cycle failed: ${err.message}`);
      this.totalErrors++;
    }
  }

  /**
   * Execute a full sync cycle.
   */
  private async executeSyncCycle(config: SyncOrchestratorConfig): Promise<FullSyncResult> {
    this.running = true;
    const startTime = Date.now();

    console.log(`[ScheduledSync] Cycle starting (${config.dryRun ? "DRY RUN" : "LIVE"})`);

    try {
      const result = await this.orchestrator.runFullSync(config);

      this.lastRunAt = new Date();
      this.lastRunDurationMs = Date.now() - startTime;
      this.lastRunResult = result;
      this.totalRuns++;

      if (result.errors.length > 0) {
        this.totalErrors += result.errors.length;
      }

      // Summary log
      const inventoryPushed = result.inventory.reduce((s, r) => s + r.variantsPushed, 0);
      const pricingPushed = result.pricing.reduce((s, r) => s + r.variantsPushed, 0);
      const listingsPushed = result.listings.reduce((s, r) => s + r.pushed, 0);
      const listingsPulled = result.listings.reduce((s, r) => s + r.pulled, 0);

      console.log(
        `[ScheduledSync] Cycle complete in ${this.lastRunDurationMs}ms — ` +
        `inventory=${inventoryPushed} pricing=${pricingPushed} ` +
        `listings_pushed=${listingsPushed} listings_pulled=${listingsPulled} ` +
        `errors=${result.errors.length}`,
      );

      return result;
    } finally {
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduledSyncService(
  orchestrator: EchelonSyncOrchestrator,
  config?: Partial<ScheduledSyncConfig>,
) {
  return new ScheduledSyncService(orchestrator, config);
}

export type { ScheduledSyncService };
