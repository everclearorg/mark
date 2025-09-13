-- migrate:up

-- Add is_orphaned field to rebalance_operations
ALTER TABLE rebalance_operations
ADD COLUMN is_orphaned BOOLEAN DEFAULT FALSE NOT NULL;

-- Drop the existing constraint
ALTER TABLE rebalance_operations DROP CONSTRAINT IF EXISTS rebalance_operation_status_check;

-- Add the new constraint with 'cancelled' status included
ALTER TABLE rebalance_operations ADD CONSTRAINT rebalance_operation_status_check
  CHECK (status IN ('pending', 'awaiting_callback', 'completed', 'expired', 'cancelled'));

-- Add comment for the new field
COMMENT ON COLUMN rebalance_operations.is_orphaned IS 'Indicates if this operation was orphaned when its associated earmark was cancelled';

-- Update comment for status to include cancelled
COMMENT ON COLUMN rebalance_operations.status IS 'Operation status: pending, awaiting_callback, completed, expired, cancelled (enforced by CHECK constraint)';

-- Add index for querying orphaned operations
CREATE INDEX idx_rebalance_operations_orphaned ON rebalance_operations(is_orphaned) WHERE is_orphaned = true;

-- migrate:down

-- Drop the index
DROP INDEX IF EXISTS idx_rebalance_operations_orphaned;

-- Drop the constraint with 'cancelled' status
ALTER TABLE rebalance_operations DROP CONSTRAINT IF EXISTS rebalance_operation_status_check;

-- Re-add the original constraint without 'cancelled' status
ALTER TABLE rebalance_operations ADD CONSTRAINT rebalance_operation_status_check
  CHECK (status IN ('pending', 'awaiting_callback', 'completed', 'expired'));

-- Drop the is_orphaned column
ALTER TABLE rebalance_operations DROP COLUMN IF EXISTS is_orphaned;

-- Restore original status comment
COMMENT ON COLUMN rebalance_operations.status IS 'Operation status: pending, awaiting_callback, completed, expired (enforced by CHECK constraint)';
