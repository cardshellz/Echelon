# Procurement setting availability

This review changes the settings page's descriptions and controls. It does not change saved preferences, the settings API contract, approval/send behavior or the editor's incoterms rules.

## Verified runtime consumers

| Saved setting | Current consumer | Page treatment |
| --- | --- | --- |
| `requireApproval` | `server/modules/procurement/purchasing.service.ts:sendWithLockedEconomics` reads the setting and selects `getMatchingApprovalTierTx` with threshold less than or equal to the locked PO total. A matching tier requires valid approval; no matching tier can proceed without that extra step. | Available. Description includes the matching-tier condition. |
| `useNewPoEditor` | `client/src/pages/PurchaseOrders.tsx:handleNewPoClick` and `poHref` select the full-page creation/editor flow. `PurchaseOrderDetail` and `PurchasingDashboard` also use this flag for eligible editor links. | Available. Describes creation/edit navigation, not purchasing automation. |
| `hideIncotermsDomestic` | `client/src/pages/PurchaseOrderEdit.tsx:showIncotermsField` uses this setting only when the supplier country is absent. US always returns false; known non-US always returns true. | Available under the accurate label **Hide incoterms until supplier country is known**. Existing editor behavior is preserved. |
| `useNewReorderCockpit` | `client/src/App.tsx:ReorderAnalysisRoute` chooses `ReorderEngine` or `PurchasingView`; `client/src/components/layout/AppShell.tsx` uses the same query to select its Procurement nav label. | Available. Describes recommendation/planning review and the retained legacy route. |

## Retained settings without a behavior consumer

`autoSendOnApprove`, `requireAcknowledgeBeforeReceive`, `enableShipmentTracking`, `autoPutawayLocation`, `autoCloseOnReconcile` and `oneClickReceiveStart` appear in schema, type definitions, defaults and settings read/write projections. The reviewed server/client source has no behavior consumer for these keys. Both camel-case names and SQL column names were searched. All call sites of `getProcurementSettings` and `getProcurementSettingsTx` were traced; the lifecycle owners consume `requireApproval`, not these retained keys.

These six controls are now disabled and labeled **Unavailable**, while displaying their saved on/off value and stating that the option has no effect. In particular, the page no longer claims that `autoSendOnApprove` advances status or sends a purchase. The change adds no automatic vendor communication.

## Permissions and save behavior

- `client/src/App.tsx:ProtectedRoute` retains the existing admin-role restriction on `/settings/procurement`.
- `server/modules/procurement/purchase-order.routes.ts` requires `purchasing:view` for GET and `inventory:adjust` for PATCH. `server/routes/middleware.ts:requirePermission` checks the authenticated user's actual capability. The page now checks `inventory:adjust` for editable controls, including its event-handler guard. An admin with purchasing-view access but no write capability can inspect every saved value with read-only controls.
- `ProcurementSettings:onToggle` accepts only a currently available setting, a validated loaded snapshot and an authorized user. One in-flight save disables further edits. The API request remains exactly `{ key, value }`.
- The page validates all displayed response booleans and preserves additional response fields in the shared query cache. Missing/malformed settings produce a visible load error rather than default-off controls.
- Switches update only from confirmed saved state. A rejected, lost or malformed save response triggers a read to reconcile the saved value; it does not issue another write. Failed refreshes keep a visible warning and disable editing until a successful read.

## Proof and limits

`test/browser/procurement-settings.spec.ts` exercises four available/six unavailable controls, unchanged saved preferences, permission-based read-only behavior, no write on mount, the existing PATCH payload, in-flight serialization, known rejection, lost/malformed response recovery and malformed initial reads on desktop and 390px mobile. All requests are intercepted; no production setting was read or changed. The existing reorder UI contract and procurement create/send route suites remain unchanged and pass.

The source trace proves the behavior in this repository's current candidate; it does not prove a production deployment's version or actual saved configuration. Unsupported settings remain API-compatible for historical clients. This page's disabled controls do not remove those persisted keys or establish new server policy.
