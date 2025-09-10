-- migrate:up

-- Drop the existing constraint
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Add the new constraint with 'expired' status included
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('pending', 'ready', 'completed', 'cancelled', 'failed', 'expired'));

-- Add comment for the new status
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled, failed, expired (enforced by CHECK constraint)';

-- migrate:down

-- Drop the constraint with 'expired' status
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Re-add the previous constraint without 'expired' status
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('pending', 'ready', 'completed', 'cancelled', 'failed'));

-- Restore previous comment
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled, failed (enforced by CHECK constraint)';