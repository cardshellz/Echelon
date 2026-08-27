-- Phase 1 remains draft-only. The activate ability is seeded now so later
-- activation routes can be independently gated without overloading edit.
INSERT INTO auth_permissions (resource, action, description, category)
VALUES
  (
    'inventory_planning',
    'view',
    'View inventory availability master data and draft evidence',
    'inventory'
  ),
  (
    'inventory_planning',
    'edit',
    'Create and edit inventory availability drafts',
    'inventory'
  ),
  (
    'inventory_planning',
    'activate',
    'Activate validated inventory availability authority',
    'inventory'
  )
ON CONFLICT (resource, action) DO UPDATE
SET
  description = EXCLUDED.description,
  category = EXCLUDED.category;

INSERT INTO auth_role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM auth_roles AS role
CROSS JOIN auth_permissions AS permission
WHERE role.name = 'Administrator'
  AND permission.resource = 'inventory_planning'
  AND permission.action IN ('view', 'edit', 'activate')
ON CONFLICT (role_id, permission_id) DO NOTHING;
