# Account and returns: live-theme compatibility

The existing signed account gateway can retain its original `themeId` and accept
an explicitly configured `additionalThemeIds` list. The legacy single-theme
configuration remains valid and default-off behavior is unchanged. IDs must be
unique numeric strings; at most ten additional themes may be configured.

For the reviewed Card Shellz launch, the proposed non-secret value of
`CUSTOMER_ACCOUNT_STAGING_CONFIG` is:

```json
{"themeId":"174740308127","additionalThemeIds":["174464958623"],"shops":{"card-shellz.myshopify.com":{"enabled":true}}}
```

The environment variable name and original field are retained for compatibility.
This proposal is not applied by committing or testing this change. Deploy this
backend compatibility change before explicitly applying the proposed config and
releasing the live theme. Existing staging tabs continue to use their configured
ID. The live theme sends its actual Liquid `theme.id`; it does not impersonate
the staging theme.

Theme IDs remain rollout selectors, never customer credentials. Shopify HMAC,
timestamp, proxy path, approved shop, origin, command header, customer identity,
session key and application-level order ownership checks still apply. An
additional theme cannot admit a guest, a different customer, another shop or an
unapproved origin. No financial or inventory strategy changes.

Rollback before live-theme release: retain the original single-theme config.
After release, first restore a compatible account theme or explicitly disable
access. Removing a live theme ID denies new account requests; it does not reverse
committed orders, refunds or returns, nor stop their existing recovery workers.

Validation uses synthetic signed HTTP requests and deterministic authorization
tests. No live configuration, theme upload, order, payment, points or inventory
command is submitted by these tests.
