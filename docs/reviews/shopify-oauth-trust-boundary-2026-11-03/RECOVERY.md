# Staff Shopify OAuth: bounded recovery and release notes

This runbook describes the FND-1 implementation in draft PR #1995. It does not authorize a
deployment, production query, token rotation, provider call or permission change.
Channels owns the connection command; Identity supplies current permission.

## Read the recorded outcome

Use the safe operation reference returned by a failed or uncertain accepted
callback, or the structured `shopify_oauth.*` event. In an independently authorized
read-only session, inspect only these safe columns using a bound UUID parameter:

```sql
SELECT operation_id, actor_id, channel_id, connection_id, shop_domain,
       status, attempt_id, created_at, expires_at, started_at, completed_at, error_code
FROM channels.shopify_oauth_authorizations
WHERE operation_id = $1;

SELECT timestamp, actor, action, target, changes, context
FROM public.audit_events
WHERE action LIKE 'channels.shopify_oauth.%'
  AND context->>'operationId' = $1
ORDER BY id;
```

Do not retrieve or paste access tokens, client secrets, callback codes, raw state,
session IDs, fingerprints or full callback URLs into logs/support messages.
Historical actor/channel/connection IDs describe the accepted operation; they do
not prove those live entities still exist or the actor still has permission.

| Recorded fact | Meaning and safe next step |
|---|---|
| `issued` | No exchange was claimed by this owner. An expired challenge cannot be used. A newly authorized installation may supersede it. |
| `exchanging` | The attempt was durably claimed before dispatch. It may be running, may have crashed before dispatch, or may have received a provider response that was not recorded. Never infer “never started.” |
| `exchanging` older than 120 seconds | Read projection reports `exchange_unknown / SHOPIFY_OAUTH_ATTEMPT_STALLED`. This is an uncertainty threshold, not proof of provider failure and not a lease allowing replay. The original durable fence stays intact. |
| `succeeded` | Token replacement and success audit committed in one transaction. This proves stored outcome, not continuing provider validity or synchronization of environment-token consumers. |
| `failed` | A stable known rejection or a pre-dispatch expiry was recorded. The code explains the boundary. A new authorization needs current permission; do not reuse its old callback. |
| `exchange_unknown` | Provider acceptance or credential persistence could not be established safely. Inspect facts and approved provider evidence before choosing a new authorization. A previously stored token may have become invalid even though it was preserved. |
| `superseded` | A newer explicit initiation owns the connection attempt. Old success/failure cannot overwrite the newer intent. Continue the newer operation. |

Current permission is rechecked for initiation, claiming, credential replacement
and historical outcome reads. Recording the terminal failure of an already
accepted attempt is narrowly authorized by its immutable binding and attempt ID;
it cannot write credentials or start work. Thus revocation/deletion can block
installation without suppressing evidence of an in-flight result.

Do not clear a challenge, change its status, replay an exchange, retry an old code,
or restore a saved token automatically. New installation is an explicit new
operation, not recovery by repetition. Old callback timestamps expire; the callback
is not a permanent status API. No dashboard, automatic reconciler, provider token
validation or refresh-token lifecycle is introduced by this fix.

## Publication and release prerequisites

The owner authorized branch publication and a draft pull request. Migration
`900000052000019950001_shopify_oauth_authorization_challenges.sql` and its sidecar
are allocated to PR #1995. This is publication, not merge/deployment approval.
The following remain release gates:

1. Reconcile current main/parallel work; run migration-policy checks against the
   actual PR base/head, hosted unit/type/PG checks, and verify the effective
   required checks/review protections through permitted access. Existing denials
   are not permission to circumvent settings access.
2. Verify the allocated SQL against an authoritative nonproduction schema and
   runtime role/default privileges. The local source-schema fixture is not a
   deployed database snapshot. Historical clean catalog replay has a pre-existing
   failure in migration 0002; do not patch, skip, or rewrite applied history to
   claim upgrade acceptance. Check actual namespace placement and existing audit
   guards, and retain the exact migration hash and release-ledger evidence.
3. In an authorized nonproduction integration, verify app distribution/lifecycle,
   callback registration, the configured shop and unambiguous connection mapping,
   an active operator's unscoped `channels:edit`, session continuity, Shopify
   clock/scopes, and real non-expiring offline response compatibility. Public app
   expiry policy may require separately scoped lifecycle work; never silently
   discard refresh/expiry fields. The current implementation fails closed.
4. Apply the additive migration before activating the application change. Missing
   storage fails closed before credential dispatch. Existing pre-fix in-flight
   authorizations have no durable binding and must start again.
5. After a separately authorized rollout, observe operation/audit outcomes and
   connection-specific provider validity. No such rollout or observation was
   performed during this task.

## Rollback

Work remains isolated on a dedicated draft PR branch. Reverting application files
is a review action, not permission to delete work. After any future deployment, **do
not restore the vulnerable callback**. Prefer disabling only this authorization
entrypoint or forwarding a correction through the release process. Preserve
challenge/audit history; the additive table need not be removed for an application
rollback. Never auto-restore previous credential values. No rollback operation
was executed here.
