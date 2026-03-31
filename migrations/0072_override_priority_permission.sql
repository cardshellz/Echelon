-- Insert the new permission for overriding SLA priorities
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
