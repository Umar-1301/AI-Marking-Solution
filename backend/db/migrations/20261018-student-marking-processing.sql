-- Apply before deploying the new student marking worker and backend recovery.
-- Run with the old worker stopped or after its queue has drained.
IF OBJECT_ID(N'dbo.marking_jobs', N'U') IS NULL
    THROW 50002, 'dbo.marking_jobs is missing; apply the base schema first', 1;
GO

IF COL_LENGTH('dbo.marking_jobs', 'owner_id') IS NULL
    ALTER TABLE dbo.marking_jobs ADD owner_id NVARCHAR(128) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'attempt_id') IS NULL
    ALTER TABLE dbo.marking_jobs ADD attempt_id UNIQUEIDENTIFIER NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'attempt_count') IS NULL
    ALTER TABLE dbo.marking_jobs ADD attempt_count INT NOT NULL
        CONSTRAINT DF_marking_jobs_attempt_count DEFAULT (0);
GO
IF COL_LENGTH('dbo.marking_jobs', 'heartbeat_at') IS NULL
    ALTER TABLE dbo.marking_jobs ADD heartbeat_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'lease_expires_at') IS NULL
    ALTER TABLE dbo.marking_jobs ADD lease_expires_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'attempt_deadline_at') IS NULL
    ALTER TABLE dbo.marking_jobs ADD attempt_deadline_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'recovery_due_at') IS NULL
    ALTER TABLE dbo.marking_jobs ADD recovery_due_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'recovery_enqueued_at') IS NULL
    ALTER TABLE dbo.marking_jobs ADD recovery_enqueued_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'error_message') IS NULL
    ALTER TABLE dbo.marking_jobs ADD error_message NVARCHAR(500) NULL;
GO

-- Existing jobs had no ownership token. Requeue active ones only after the old
-- worker is stopped; the new worker will claim them with a fresh attempt ID.
UPDATE dbo.marking_jobs
SET status = N'queued', recovery_due_at = SYSUTCDATETIME(),
    recovery_enqueued_at = NULL, owner_id = NULL, attempt_id = NULL,
    heartbeat_at = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL,
    updated_at = SYSUTCDATETIME()
WHERE status IN (N'processing', N'marking') AND attempt_id IS NULL;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_marking_jobs_status'
           AND parent_object_id = OBJECT_ID(N'dbo.marking_jobs'))
    ALTER TABLE dbo.marking_jobs DROP CONSTRAINT CK_marking_jobs_status;
ALTER TABLE dbo.marking_jobs ADD CONSTRAINT CK_marking_jobs_status CHECK (
    status IN (N'queued', N'processing', N'marking', N'complete', N'failed')
);
GO
