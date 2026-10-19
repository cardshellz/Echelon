# Archived variants and transformation drafts

Variant archival changes catalog lifecycle state; it does not rewrite sealed transformation definitions or the model snapshots used by existing claims. New and edited drafts must stop carrying authority for those archived identities.

The planning admin reader captures actual `catalog.product_variants.is_active` values in the same repeatable-read transaction as the selected models and recipes. It returns archived references even when shipping or tracking filters omit a variant, and includes external recipe components. Missing references are not treated as archived.

`prepareTransformationDraft` is the shared policy used by the product inventory behavior editor and the detailed draft editor:

- Exclude every direction whose source or destination is archived, including explicit blocked directions.
- Exclude an entire recipe binding when its output or any component is archived, together with its bound paths. Never remove just one ingredient.
- Disable build-to-promise when that exclusion removes the last component-build binding.
- Preserve all other paths, directions, quantities, recipe scopes, and snapshots. Never compose a new direction through an archived intermediate SKU or substitute a merge target.

Both editors show excluded rules before saving. The saved model/head identity remains the concurrency baseline. The successor is recorded by the existing transactional, audited, idempotent draft commands and still requires normal review and application. The server continues to reject inactive references and locks catalog references during persistence; a concurrent archive cannot be silently incorporated into an already-open edit. Recipes that currently use archived variants cannot be selected again.

This also handles models with stale references left by earlier archives. Reopening the editor prepares a successor from current lifecycle state, without a SKU-specific repair or a migration that rewrites historical authority. Existing stock and sealed history are unchanged by preparing or saving a draft.

Routine Review/Apply also checks every saved draft path, recipe output, and component against current lifecycle state. It locks model ownership, products, and variants in stable order through promotion. A draft saved before an archive returns an actionable review blocker, and both stale reviewed commands and attempts to apply that blocked review are rejected.
