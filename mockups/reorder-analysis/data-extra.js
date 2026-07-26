// Hand-authored supplementary mock data for surfaces 03/04/05/06 and the accuracy strip.
// All dollar amounts cross-checked against data.js unit costs. Do not change numbers.
window.MOCK_EXTRA = {

  // ---------- Automation Control Center (03) ----------
  automation: {
    stages: [
      { n: 0, key: "off",       name: "Off",            desc: "No analysis runs. Manual purchasing only." },
      { n: 1, key: "observe",   name: "Observe",        desc: "Nightly analysis + recommendations and report only. No drafts created." },
      { n: 2, key: "auto_draft",name: "Auto-draft",     desc: "System drafts POs / RFQs for eligible items. A human reviews and sends everything." },
      { n: 3, key: "auto_send", name: "Auto-send",      desc: "Eligible POs send to the vendor automatically when inside all caps. Human handles exceptions." },
      { n: 4, key: "autopilot", name: "Full autopilot", desc: "Includes RFQ send, quote award within tolerance, and PO conversion. Human sees the report and exceptions only." }
    ],
    globalDefaultStage: 2,
    globalKillSwitch: false,
    globalCaps: { maxDailySpendCents: 500000, maxLinesPerRun: 25, maxPoCents: 250000 },
    // per-vendor ladder state; promotion requires N clean runs at current stage
    vendors: [
      { code: "GTS", name: "GTS Distribution",  stage: 3, cleanRuns: 14, cleanRunsRequired: 10, last30: { runs: 26, autoSent: 6, drafts: 9, interventions: 1 }, caps: { maxPoCents: 250000, maxDayCents: 500000 } },
      { code: "BCW", name: "BCW Direct",        stage: 3, cleanRuns: 11, cleanRunsRequired: 10, last30: { runs: 26, autoSent: 4, drafts: 3, interventions: 0 }, caps: { maxPoCents: 200000, maxDayCents: 250000 } },
      { code: "SHD", name: "Southern Hobby",    stage: 2, cleanRuns: 7,  cleanRunsRequired: 10, last30: { runs: 26, autoSent: 0, drafts: 6, interventions: 2 }, caps: { maxPoCents: 150000, maxDayCents: 300000 } },
      { code: "PSC", name: "Peach State Cards", stage: 1, cleanRuns: 3,  cleanRunsRequired: 10, last30: { runs: 26, autoSent: 0, drafts: 0, interventions: 0 }, caps: null },
      { code: "MEX", name: "Magazine Exchange", stage: 1, cleanRuns: 0,  cleanRunsRequired: 10, last30: { runs: 26, autoSent: 0, drafts: 0, interventions: 0 }, caps: null }
    ],
    categoryOverrides: [
      { category: "Singles", stage: 0, note: "Also excluded from analysis by rule" },
      { category: "Sealed - Pokemon", stageCap: 2, note: "Volatile demand — hold at Auto-draft through Q4 wave" }
    ],
    anomalyRules: [
      { id: "qty_vs_history",  on: true,  label: "Suggested qty exceeds 3x the trailing 90-day average order", action: "Hold line + warn" },
      { id: "cost_drift",      on: true,  label: "Vendor unit cost drifts more than 15% from last verified quote", action: "Hold line + warn" },
      { id: "forecast_review", on: true,  label: "Forecast trust is at review (thin history, stale demand, missing windows)", action: "Hold line" },
      { id: "new_sku",         on: true,  label: "SKU has under 30 days of sales history", action: "Always hold for human review" },
      { id: "daily_cap",       on: true,  label: "Cumulative auto-send spend reaches the daily cap", action: "Pause auto-send until tomorrow + warn" },
      { id: "run_overlap",     on: true,  label: "Previous run still holds the run lease", action: "Skip run + critical alert" }
    ],
    gateLog: [
      { at: "2026-07-24 09:12", actor: "owner", entry: "Raised GTS per-PO cap $2,000 → $2,500 after 6 clean auto-sends" },
      { at: "2026-07-12 08:40", actor: "owner", entry: "Promoted GTS Stage 2 → 3 (14 clean runs, 0 interventions in 30d)" },
      { at: "2026-07-08 21:03", actor: "system", entry: "Auto-pause: daily spend cap reached ($5,000). Resumed next run." },
      { at: "2026-06-30 10:15", actor: "owner", entry: "Promoted BCW Stage 2 → 3; capped at $2,000/PO" },
      { at: "2026-06-18 07:55", actor: "owner", entry: "Enabled cost-drift anomaly rule at 15% after MEX price change slipped through" },
      { at: "2026-06-02 09:30", actor: "owner", entry: "Global default set to Stage 2 (Auto-draft). Ladder went live." }
    ]
  },

  // ---------- Run Report (04) ----------
  runReport: {
    runId: 1382, at: "2026-07-26 02:00 UTC", trigger: "scheduled", status: "success", durationSec: 46,
    policyCohort: "3f9a2c1e", forecastVersion: 2, calculationVersion: "purchasing-recommendation-v2",
    totals: { activeSkus: 214, excluded: 37, analyzed: 177, healthy: 171, actionable: 4, monitored: 2 },
    suggestedSpendCents: 7094300,
    actions: [
      { sku: "PKM-151-UPC",  action: "auto_draft_po", vendor: "Southern Hobby", pieces: 54,  valueCents: 496800,  gate: "Auto-draft — vendor at Stage 2", note: "PO-2417 drafted, awaiting review & send" },
      { sku: "PKM-PRE-ETB",  action: "held_by_cap",   vendor: "GTS Distribution", pieces: 390, valueCents: 1813500, gate: "Held — $18,135 exceeds GTS $2,500 auto-send cap", note: "Draft created for human review (PO-2418)" },
      { sku: "PKM-MEGA-ETB", action: "held_review",   vendor: "GTS Distribution", pieces: 920, valueCents: 4784000, gate: "Held — low confidence (preorder, 6d history) + qty anomaly (>3x trailing avg)", note: "Routed to review queue" },
      { sku: "PAN-PRZ-HOB",  action: "monitor",       vendor: "Peach State Cards", pieces: 0, valueCents: 0, gate: "Burn rate high — 35d supply vs 25d lead time. No order needed yet", note: "Recheck at next run" }
    ],
    warnings: [
      { level: "warn", text: "PKM-MEGA-ETB: suggested 920 pieces is 30x trailing 90-day demand (event-driven). Anomaly rule qty_vs_history held the line." },
      { level: "warn", text: "PKM-MEGA-ETB: vendor cost is unverified (no quote in 365 days). Verify with GTS before ordering." },
      { level: "info", text: "Growth adjustment +20% Sealed - Pokemon (Jul 15 – Aug 31) is active and raised Pokemon reorder points this run." },
      { level: "info", text: "Black Friday supplies push (2,500 pc) enters the 90-day forecast horizon on Aug 29." }
    ],
    history: [
      { runId: 1382, at: "2026-07-26 02:00", trigger: "scheduled", status: "success", analyzed: 177, autoSent: 0, drafts: 2, held: 2, spentCents: 0 },
      { runId: 1381, at: "2026-07-25 02:00", trigger: "scheduled", status: "success", analyzed: 176, autoSent: 0, drafts: 0, held: 1, spentCents: 0 },
      { runId: 1380, at: "2026-07-24 02:00", trigger: "scheduled", status: "success", analyzed: 176, autoSent: 1, drafts: 1, held: 1, spentCents: 118100 },
      { runId: 1379, at: "2026-07-23 14:21", trigger: "manual",    status: "success", analyzed: 176, autoSent: 0, drafts: 0, held: 0, spentCents: 0 },
      { runId: 1378, at: "2026-07-23 02:00", trigger: "scheduled", status: "interrupted", analyzed: 0, autoSent: 0, drafts: 0, held: 0, spentCents: 0, note: "Lease reclaimed after dyno restart; rerun succeeded" },
      { runId: 1377, at: "2026-07-20 02:00", trigger: "scheduled", status: "success", analyzed: 175, autoSent: 1, drafts: 2, held: 0, spentCents: 118100, note: "BCW-TL-100 top-off auto-sent to BCW Direct ($1,181)" }
    ],
    email: {
      subject: "Echelon reorder run #1382 — 2 drafts waiting, 1 hold, $0 auto-sent",
      preheader: "177 SKUs analyzed · 4 need action · suggested pipeline $70,943"
    }
  },

  // ---------- RFQ Workbench (05) ----------
  // Need-by figures come from data.js suggestions. Landed unit cost = unit + freight/pieces.
  rfq: {
    pipeline: { draft: 1, sent: 1, quoting: 1, award: 1, converted: 2 },
    showcase: {
      number: "RFQ-20260726-4F7A2B", status: "award", sentAt: "2026-07-26", dueAt: "2026-08-02",
      lines: [
        {
          sku: "PKM-PRE-ETB", name: "Prismatic Evolutions Elite Trainer Box", needPieces: 390, currentCostCents: 4650,
          quotes: [
            { vendor: "GTS Distribution",  unitCents: 4590, moq: 100, leadDays: 7,  freightCents: 0,     landedUnitCents: 4590, totalCents: 1790100, note: "Freight included" },
            { vendor: "Southern Hobby",    unitCents: 4450, moq: 200, leadDays: 10, freightCents: 18000, landedUnitCents: 4496, totalCents: 1753500, note: "$180 freight, allocated over 390 pc", recommended: true, why: "Lowest landed cost. +3 days lead is inside the 14-day coverage window." },
            { vendor: "Peach State Cards", unitCents: 4700, moq: 50,  leadDays: 12, freightCents: 0,     landedUnitCents: 4700, totalCents: 1833000, note: "" }
          ],
          award: { vendor: "Southern Hobby", pieces: 390, totalCents: 1753500, savesVsCurrentCents: 60000 }
        },
        {
          sku: "PKM-151-UPC", name: "151 Ultra Premium Collection", needPieces: 54, currentCostCents: 9200,
          quotes: [
            { vendor: "GTS Distribution",  unitCents: 9150, moq: 24, leadDays: 7,  freightCents: 0, landedUnitCents: 9150, totalCents: 494100, note: "", recommended: true, why: "PSC unit cost is lower, but its MOQ 60 forces 6 extra pieces: $5,334 total vs $4,941 for the exact 54. GTS also restocks 5 days sooner on a stockout." },
            { vendor: "Southern Hobby",    declined: true, note: "No allocation this wave" },
            { vendor: "Peach State Cards", unitCents: 8890, moq: 60, leadDays: 12, freightCents: 0, landedUnitCents: 8890, totalCents: 533400, notePieces: 60, note: "MOQ forces 60 pc (+6 over need)" }
          ],
          award: { vendor: "GTS Distribution", pieces: 54, totalCents: 494100, savesVsCurrentCents: 2700 }
        }
      ],
      awardTotals: { totalCents: 2247600, savesCents: 62700, poCount: 2 },
      promoteQuotesDefault: true
    },
    quoteEntryExample: {
      vendor: "Southern Hobby", fields: ["Unit cost", "MOQ (pieces)", "Lead time (days)", "Freight", "Quote reference", "Valid until", "Notes"],
      noBidReasons: ["No allocation", "Discontinued", "Below vendor minimum", "Other"]
    }
  },

  // ---------- Exclusions & Policy (06) ----------
  exclusions: {
    totals: { activeSkus: 251, excluded: 37 },
    addRulePreview: { field: "brand", value: "Funko", wouldExclude: 6, sample: ["FNK-POP-PIKA", "FNK-POP-CHZ", "FNK-POP-MEW", "FNK-SODA-SQ", "FNK-POP-EEV"] },
    perProduct: [
      { sku: "PKM-CEL-PC", name: "Celebrations Premium Collection (allocated, no reorders)", by: "owner", at: "2026-06-11" },
      { sku: "TOP-24C-HOB", name: "2024 Topps Chrome Hobby (closeout — sell through)", by: "owner", at: "2026-07-02" }
    ]
  },

  // ---------- Forecast accuracy strip (01) — mirrors the live ForecastAccuracyPanel ----------
  accuracy: {
    cohort: "3f9a2c1e", forecastVersion: 2, method: "Weighted blend", horizon: 30,
    wape: { historical: 18.4, baseline: 24.1, overlayAdjusted: 17.2 },
    overlayCoveragePct: 62, evaluations: 1842,
    wins: { forecastVsBaselinePct: 61, overlayVsForecastPct: 54 },
    pipeline: { status: "healthy", snapshotAt: "2026-07-26 02:00", evaluationAt: "2026-07-26 02:04" }
  }
};
