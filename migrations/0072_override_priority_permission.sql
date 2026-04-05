-- Insert the new permission for overriding SLA priorities
-- Add unique constraints if they don't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_permissions_resource_action_unique') THEN
    ALTER TABLE auth_permissions ADD CONSTRAINT auth_permissions_resource_action_unique UNIQUE (resource, action);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_role_permissions_role_permission_unique') THEN
    ALTER TABLE auth_role_permissions ADD CONSTRAINT auth_role_permissions_role_permission_unique UNIQUE (role_id, permission_id);
  END IF;
END $$;

INSERT INTO auth_permissions (resource, action, description, category) 
VALUES ('orders', 'override_priority', 'Systemic override of shipping SLAs (BUMP, HOLD, NORMAL)', 'orders')
ON CONFLICT (resource, action) DO NOTHING;

-- Grant to admin and lead roles
INSERT INTO auth_role_permissions (role_id, permission_id)
SELECT r.id, p.id 
FROM auth_roles r
CROSS JOIN auth_permissions p 
WHERE r.name IN ('admin', 'lead') AND p.resource = 'orders' AND p.action = 'override_priority'
ON CONFLICT (role_id, permission_id) DO NOTHING;
