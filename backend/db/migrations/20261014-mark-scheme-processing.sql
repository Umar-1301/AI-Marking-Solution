-- Apply to the database used by the backend before deploying the mark-scheme
-- lease/heartbeat consumer. Safe to re-run; only mark-scheme objects change.
IF OBJECT_ID(N'dbo.mark_scheme_jobs', N'U') IS NULL
    THROW 50001, 'dbo.mark_scheme_jobs is missing; apply the base schema first', 1;
GO

IF COL_LENGTH('dbo.mark_scheme_jobs', 'ocr_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD ocr_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'owner_id') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD owner_id NVARCHAR(128) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'attempt_id') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD attempt_id UNIQUEIDENTIFIER NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'attempt_count') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD attempt_count INT NOT NULL
        CONSTRAINT DF_mark_scheme_jobs_attempt_count DEFAULT (0);
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'heartbeat_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD heartbeat_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'lease_expires_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD lease_expires_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'attempt_deadline_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD attempt_deadline_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'recovery_due_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD recovery_due_at DATETIME2(3) NULL;
GO
IF COL_LENGTH('dbo.mark_scheme_jobs', 'recovery_enqueued_at') IS NULL
    ALTER TABLE dbo.mark_scheme_jobs ADD recovery_enqueued_at DATETIME2(3) NULL;
GO

-- Give jobs started by an older worker three minutes to finish on rollout.
UPDATE dbo.mark_scheme_jobs
SET lease_expires_at = DATEADD(SECOND, 180, SYSUTCDATETIME())
WHERE status IN (N'processing', N'ocr') AND lease_expires_at IS NULL;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_mark_scheme_jobs_status'
           AND parent_object_id = OBJECT_ID(N'dbo.mark_scheme_jobs'))
    ALTER TABLE dbo.mark_scheme_jobs DROP CONSTRAINT CK_mark_scheme_jobs_status;
ALTER TABLE dbo.mark_scheme_jobs ADD CONSTRAINT CK_mark_scheme_jobs_status CHECK (
    status IN (N'awaiting_upload', N'queued', N'processing', N'ocr', N'complete', N'failed')
);
GO

IF OBJECT_ID(N'dbo.mark_scheme_ocr_admissions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.mark_scheme_ocr_admissions (
        attempt_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        started_at DATETIME2(3) NOT NULL DEFAULT (SYSUTCDATETIME())
    );
END;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID(N'dbo.mark_scheme_ocr_admissions')
                 AND name = N'IX_mark_scheme_ocr_admissions_started_at')
    CREATE INDEX IX_mark_scheme_ocr_admissions_started_at
        ON dbo.mark_scheme_ocr_admissions (started_at);
GO
