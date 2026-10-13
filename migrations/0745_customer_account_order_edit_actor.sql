-- Preserve staff foreign keys while recording externally authenticated Shopify
-- customers in their existing channel/customer namespace. Do not create staff
-- users for shoppers or copy customer identities into identity.users.
ALTER TABLE oms.order_edit_operations ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE oms.order_edit_operations
  ADD COLUMN customer_actor_channel_id integer REFERENCES channels.channels(id),
  ADD COLUMN customer_actor_external_id varchar(30),
  ADD CONSTRAINT order_edit_operation_actor_kind CHECK (
    (actor_id IS NOT NULL AND customer_actor_channel_id IS NULL AND customer_actor_external_id IS NULL)
    OR (actor_id IS NULL AND customer_actor_channel_id IS NOT NULL
      AND customer_actor_external_id IS NOT NULL
      AND customer_actor_external_id ~ '^[1-9][0-9]*$'
      AND COALESCE(document->>'actorId','') = 'shopify:' || customer_actor_channel_id::text || ':' || customer_actor_external_id
      AND COALESCE(document#>>'{baseline,channelId}','') = customer_actor_channel_id::text
      AND regexp_replace(COALESCE(document#>>'{baseline,customerId}',''),'^gid://shopify/Customer/','') = customer_actor_external_id)
  );
ALTER TABLE oms.order_edit_events
  ADD COLUMN customer_actor_channel_id integer REFERENCES channels.channels(id),
  ADD COLUMN customer_actor_external_id varchar(30),
  ADD CONSTRAINT order_edit_event_actor_kind CHECK (
    (customer_actor_channel_id IS NULL AND customer_actor_external_id IS NULL)
    OR (actor_id IS NULL AND customer_actor_channel_id IS NOT NULL
      AND customer_actor_external_id IS NOT NULL
      AND customer_actor_external_id ~ '^[1-9][0-9]*$')
  );
