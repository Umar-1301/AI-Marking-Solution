-- Local OCR batching experiment only. Apply to local SQL before starting the worker.
IF OBJECT_ID(N'dbo.marking_jobs', N'U') IS NULL
    THROW 50003, 'dbo.marking_jobs is missing; apply the base schema first', 1;
GO
IF COL_LENGTH('dbo.marking_jobs', 'try_id') IS NULL
    ALTER TABLE dbo.marking_jobs ADD try_id UNIQUEIDENTIFIER NULL;
GO
IF COL_LENGTH('dbo.marking_jobs', 'ocr_retry_pending') IS NULL
    ALTER TABLE dbo.marking_jobs ADD ocr_retry_pending BIT NOT NULL
        CONSTRAINT DF_marking_jobs_ocr_retry_pending DEFAULT (0);
GO
IF COL_LENGTH('dbo.marking_jobs', 'ocr_try_count') IS NULL
    ALTER TABLE dbo.marking_jobs ADD ocr_try_count INT NOT NULL
        CONSTRAINT DF_marking_jobs_ocr_try_count DEFAULT (0);
GO
IF OBJECT_ID(N'dbo.marking_ocr_tries', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.marking_ocr_tries (
        try_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        job_id UNIQUEIDENTIFIER NOT NULL
            REFERENCES dbo.marking_jobs(job_id) ON DELETE CASCADE,
        attempt_id UNIQUEIDENTIFIER NOT NULL,
        try_number INT NOT NULL,
        outcome NVARCHAR(20) NOT NULL DEFAULT (N'processing'),
        started_at DATETIME2(3) NOT NULL DEFAULT (SYSUTCDATETIME()),
        finished_at DATETIME2(3) NULL
    );
    CREATE INDEX IX_marking_ocr_tries_job_id
        ON dbo.marking_ocr_tries(job_id, try_number);
END;
GO
