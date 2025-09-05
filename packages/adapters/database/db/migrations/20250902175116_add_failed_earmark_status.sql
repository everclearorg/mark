-- migrate:up

-- Drop the existing constraint
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Add the new constraint with 'failed' status included
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('pending', 'ready', 'completed', 'cancelled', 'failed'));

-- Add comment for the new status
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled, failed (enforced by CHECK constraint)';

-- migrate:down

-- Drop the constraint with 'failed' status
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS earmark_status_check;

-- Re-add the original constraint without 'failed' status
ALTER TABLE earmarks ADD CONSTRAINT earmark_status_check
  CHECK (status IN ('pending', 'ready', 'completed', 'cancelled'));

-- Restore original comment
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled (enforced by CHECK constraint)';
