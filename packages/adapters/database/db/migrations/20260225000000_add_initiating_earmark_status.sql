-- migrate:up

-- Drop the existing constraint
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Add the new constraint with 'initiating' status included
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('initiating', 'pending', 'ready', 'completed', 'cancelled', 'failed', 'expired'));

-- Update the unique partial index to include 'initiating' status
-- This prevents two concurrent processes from both creating earmarks before bridge transactions
DROP INDEX IF EXISTS unique_active_earmark_per_invoice;
CREATE UNIQUE INDEX unique_active_earmark_per_invoice ON earmarks(invoice_id)
WHERE status IN ('initiating', 'pending', 'ready');

-- Update comment
COMMENT ON COLUMN earmarks.status IS 'Earmark status: initiating, pending, ready, completed, cancelled, failed, expired (enforced by CHECK constraint)';

-- migrate:down

-- Drop the constraint with 'initiating' status
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Re-add the previous constraint without 'initiating' status
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('pending', 'ready', 'completed', 'cancelled', 'failed', 'expired'));

-- Restore the original partial unique index without 'initiating'
DROP INDEX IF EXISTS unique_active_earmark_per_invoice;
CREATE UNIQUE INDEX unique_active_earmark_per_invoice ON earmarks(invoice_id)
WHERE status IN ('pending', 'ready');

-- Restore previous comment
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled, failed, expired (enforced by CHECK constraint)';
