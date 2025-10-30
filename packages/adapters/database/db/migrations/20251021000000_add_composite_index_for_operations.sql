-- migrate:up
-- Add composite index to optimize getAvailableBalanceLessEarmarks query performance
-- This index covers the common query pattern: filter by destination_chain_id, status, and earmark_id
-- Improves performance when calculating available balance by filtering operations associated with active earmarks

CREATE INDEX IF NOT EXISTS idx_rebalance_operations_status_earmark_dest
ON rebalance_operations (destination_chain_id, status, earmark_id)
WHERE earmark_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS idx_rebalance_operations_status_earmark_dest;
