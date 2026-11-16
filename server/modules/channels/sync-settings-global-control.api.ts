/**
 * Capability-scoped public API for `channels.sync_settings` CAS mutations
 * coordinated within `inventory-planning` global publication-control transactions.
 */
export { updateGlobalSyncSettingsSingletonWithCasInTx } from "./infrastructure/sync-settings-global-control.repository";
