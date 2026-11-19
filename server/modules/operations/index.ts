/**
 * @module Operations (Control Tower)
 * @owner Operations / Platform Observability
 *
 * Public entrypoint barrel for `server/modules/operations`.
 * External callers must import from `server/modules/operations` or one of its
 * capability-scoped `.api.ts` contracts (`routes.api`, `projection-scheduler.api`,
 * `projection-runner.api`, `legacy-overview.api`), never internal `.service`,
 * `.repository`, `.query`, `.triage`, `.actions`, `.job`, `.sources`, `.scheduler`,
 * or `.routes` files.
 */
export * from "./routes.api";
export * from "./projection-scheduler.api";
export * from "./projection-runner.api";
export * from "./legacy-overview.api";
