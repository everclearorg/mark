-- migrate:up
ALTER TABLE rebalance_operations DROP CONSTRAINT IF EXISTS rebalance_operation_status_check;
ALTER TABLE rebalance_operations ADD CONSTRAINT rebalance_operation_status_check
  CHECK (status IN ('pending', 'awaiting_callback', 'awaiting_post_bridge', 'completed', 'expired', 'cancelled'));

-- migrate:down
ALTER TABLE rebalance_operations DROP CONSTRAINT IF EXISTS rebalance_operation_status_check;
ALTER TABLE rebalance_operations ADD CONSTRAINT rebalance_operation_status_check
  CHECK (status IN ('pending', 'awaiting_callback', 'completed', 'expired', 'cancelled'));
