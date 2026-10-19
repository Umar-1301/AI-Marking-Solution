import sql from 'mssql'
import config from '../config/index.js'
import {
    MARK_SCHEME_LEASE_SECONDS,
    MARK_SCHEME_MAX_CONCURRENT,
    MARK_SCHEME_OCR_STARTS_PER_MINUTE,
    MARK_SCHEME_MAX_ATTEMPTS,
    MARK_SCHEME_RECOVERY_RESEND_SECONDS,
} from '../config/markSchemeProcessing.js'
import {
    STUDENT_MARKING_MAX_ATTEMPTS,
    STUDENT_MARKING_RECOVERY_RESEND_SECONDS,
} from '../config/studentMarkingProcessing.js'

// Azure SQL connection pool. Authentication uses Entra ID through
// DefaultAzureCredential by default: the Container App's managed identity in
// Azure, or an authenticated developer identity locally. No database password
// is stored in source code or environment variables for that path.
//
// Local-only exception: if SQL_USER/SQL_PASSWORD are set (only true in a
// local .env, pointing at the docker-compose SQL Server container — see
// docker-compose.yml and db/apply-schema.mjs), SQL authentication is used
// instead, so local development doesn't depend on the live Azure SQL server
// being reachable. Production never sets these two variables, so it always
// takes the Entra ID branch below — this file behaves identically to before
// in that case, not just similarly.
const dbConfig = (config.SQL_USER && config.SQL_PASSWORD)
    ? {
        server: config.SQL_SERVER,
        database: config.SQL_DATABASE,
        user: config.SQL_USER,
        password: config.SQL_PASSWORD,
        options: {
            encrypt: true,
            // The container's TLS cert is self-signed — there's no CA to
            // validate it against locally, unlike Azure SQL's real cert.
            trustServerCertificate: true,
        },
        connectionTimeout: 30000,
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    }
    : {
        server: config.SQL_SERVER,
        database: config.SQL_DATABASE,
        authentication: { type: 'azure-active-directory-default' },
        options: {
            encrypt: true,
            trustServerCertificate: false,
        },
        connectionTimeout: 30000,
        // Keeping no idle connections open allows an Azure SQL serverless database
        // to auto-pause when the application is quiet.
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    }

export const pool = new sql.ConnectionPool(dbConfig)
export const poolConnect = pool.connect()

// Parameter descriptors keep every query explicitly typed. This prevents the
// driver or SQL Server from guessing types and preserves Unicode input.
const intParam = (name, value) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isSafeInteger(parsed)) {
        throw new TypeError(`${name} must be an integer`)
    }
    return { name, type: sql.Int, value: parsed }
}

const textParam = (name, length, value) => {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a string`)
    }
    return { name, type: sql.NVarChar(length), value }
}

const nullableTextParam = (name, length, value) => {
    if (value !== null && typeof value !== 'string') {
        throw new TypeError(`${name} must be a string or null`)
    }
    return { name, type: sql.NVarChar(length), value }
}

const uuidParam = (name, value) => {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a UUID string`)
    }
    return { name, type: sql.UniqueIdentifier, value }
}

// Execute against either the shared pool or an mssql Transaction. Accessor
// method signatures remain unchanged: methods use the pool by default, while
// transactional callers pass their Transaction as the optional executor `e`.
const exec = async (e, queryText, params = []) => {
    const request = new sql.Request(e)
    for (const { name, type, value } of params) {
        request.input(name, type, value)
    }
    return request.query(queryText)
}

async function inTransaction(work) {
    const transaction = new sql.Transaction(pool)
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED)

    try {
        const result = await work(transaction)
        await transaction.commit()
        return result
    } catch (err) {
        // Preserve the original database/application error if SQL Server has
        // already aborted the transaction and rollback consequently also fails.
        try {
            await transaction.rollback()
        } catch (rollbackErr) {
            err.rollbackError = rollbackErr
        }
        throw err
    }
}

// Least-privilege application accessor for the teachers table.
export const teacherDb = {
    findByEmailHash: async (emailHash, e = pool) =>
        (await exec(e, `
            SELECT id, name, email_hash, password_hash, created_at
            FROM dbo.teachers
            WHERE email_hash = @emailHash
        `, [
            textParam('emailHash', 64, emailHash),
        ])).recordset[0],

    insert: async (name, emailHash, passwordHash, e = pool) =>
        (await exec(e, `
            INSERT INTO dbo.teachers (name, email_hash, password_hash)
            OUTPUT INSERTED.id
            VALUES (@name, @emailHash, @passwordHash)
        `, [
            textParam('name', 100, name),
            textParam('emailHash', 64, emailHash),
            textParam('passwordHash', 100, passwordHash),
        ])).recordset[0],
}

// Lessons are always joined through their class so teacher ownership remains
// part of the database predicate, not a frontend assumption.
const SQL_LIST_LESSONS = `
    SELECT l.id, l.lesson_title, l.class_id, l.created_at, c.class_name
    FROM dbo.lessons AS l
    JOIN dbo.classes AS c ON l.class_id = c.id
    WHERE c.teacher_id = @teacherId
    ORDER BY l.created_at DESC
`

const SQL_FIND_LESSON = `
    SELECT l.id, l.lesson_title, l.class_id, c.class_name
    FROM dbo.lessons AS l
    JOIN dbo.classes AS c ON l.class_id = c.id
    WHERE l.id = @lessonId AND c.teacher_id = @teacherId
`

const SQL_LESSON_CLASS_CHECK = `
    SELECT id, class_name
    FROM dbo.classes
    WHERE id = @classId AND teacher_id = @teacherId
`

// Central read for everything about a lesson's mark scheme — ownership-checked
// once here, reused by every endpoint that needs any piece of this data
// (GET /:id/ocr, GET /:id/questions) rather than each running its own query.
const SQL_LESSON_OCR_TEXT = `
    SELECT t.ocr_text, t.structured_scheme, t.thread_extraction,
           t.selected_question_index
    FROM dbo.teacher_ocr AS t
    JOIN dbo.lessons AS l ON t.lesson_id = l.id
    JOIN dbo.classes AS c ON l.class_id = c.id
    WHERE l.id = @lessonId AND c.teacher_id = @teacherId
`

// Everything needed to clone a lesson's already-extracted mark scheme into a
// brand-new lesson, without touching students or marking_results — backs
// POST /:sourceLessonId/reuse, which starts a genuinely new session rather
// than resuming the old one.
const SQL_LESSON_SCHEME_FOR_REUSE = `
    SELECT l.lesson_title, l.mark_scheme_file_name, l.mark_scheme_mime_type,
           t.ocr_text, t.structured_scheme, t.thread_extraction
    FROM dbo.teacher_ocr AS t
    JOIN dbo.lessons AS l ON t.lesson_id = l.id
    JOIN dbo.classes AS c ON l.class_id = c.id
    WHERE l.id = @lessonId AND c.teacher_id = @teacherId
`

export const lessonDb = {
    listLessons: async (teacherId, e = pool) =>
        (await exec(e, SQL_LIST_LESSONS, [
            intParam('teacherId', teacherId),
        ])).recordset,

    findLesson: async (lessonId, teacherId, e = pool) =>
        (await exec(e, SQL_FIND_LESSON, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    findClass: async (classId, teacherId, e = pool) =>
        (await exec(e, SQL_LESSON_CLASS_CHECK, [
            intParam('classId', classId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    getOcrText: async (lessonId, teacherId, e = pool) =>
        (await exec(e, SQL_LESSON_OCR_TEXT, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    getSchemeForReuse: async (lessonId, teacherId, e = pool) =>
        (await exec(e, SQL_LESSON_SCHEME_FOR_REUSE, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    // Saves which question index the teacher selected for a multi-question paper.
    // Ownership enforced via the same lessons -> classes -> teacher_id join used
    // everywhere else in this file, not just trusted from the request.
    updateSelectedQuestion: async (lessonId, teacherId, index, e = pool) =>
        exec(e, `
            UPDATE t
            SET t.selected_question_index = @index
            FROM dbo.teacher_ocr AS t
            JOIN dbo.lessons AS l ON t.lesson_id = l.id
            JOIN dbo.classes AS c ON l.class_id = c.id
            WHERE l.id = @lessonId AND c.teacher_id = @teacherId
        `, [
            intParam('index', index),
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ]),

    // Insert the lesson and OCR row, then link them atomically. Both extracted
    // scheme representations come from main.py's /ocr and are stored for
    // future marking and segmentation work.
    createLesson: async (
        lessonTitle,
        classId,
        fileName,
        mimeType,
        ocrText,
        structuredScheme,
        threadExtraction,
        executor = null,
        { jobId = null, attemptId = null } = {}
    ) => {
        const jobContext = jobId ? `job=${jobId}, attempt=${attemptId ?? '-'}, ` : ''
        const work = async (transaction) => {
            const lesson = (await exec(transaction, `
                INSERT INTO dbo.lessons (
                    lesson_title,
                    class_id,
                    mark_scheme_file_name,
                    mark_scheme_mime_type
                )
                OUTPUT INSERTED.id
                VALUES (@lessonTitle, @classId, @fileName, @mimeType)
            `, [
                textParam('lessonTitle', 255, lessonTitle),
                intParam('classId', classId),
                textParam('fileName', 255, fileName),
                textParam('mimeType', 100, mimeType),
            ])).recordset[0]

            const ocr = (await exec(transaction, `
                INSERT INTO dbo.teacher_ocr (
                    lesson_id,
                    ocr_text,
                    structured_scheme,
                    thread_extraction
                )
                OUTPUT INSERTED.id
                VALUES (
                    @lessonId,
                    @ocrText,
                    @structuredScheme,
                    @threadExtraction
                )
            `, [
                intParam('lessonId', lesson.id),
                textParam('ocrText', sql.MAX, ocrText),
                textParam('structuredScheme', sql.MAX, structuredScheme ?? ''),
                textParam('threadExtraction', sql.MAX, threadExtraction ?? ''),
            ])).recordset[0]

            console.log(
                `[THREAD EXTRACTION][BACKEND] 4/5 Inserting thread extraction into teacher_ocr — ${jobContext}ocr_id=${ocr.id}, characters=${(threadExtraction ?? '').length}`
            )

            const storedThreadExtraction = (await exec(transaction, `
                SELECT
                    DATALENGTH(thread_extraction) AS thread_extraction_bytes,
                    thread_extraction
                FROM dbo.teacher_ocr
                WHERE id = @ocrId
            `, [
                intParam('ocrId', ocr.id),
            ])).recordset[0]

            console.log(
                `[THREAD EXTRACTION][BACKEND] 5/5 SQL readback confirmed — ${jobContext}ocr_id=${ocr.id}, stored_bytes=${storedThreadExtraction?.thread_extraction_bytes ?? 0}`
            )

            await exec(transaction, `
                UPDATE dbo.lessons
                SET mark_scheme_ocr = @ocrId
                WHERE id = @lessonId
            `, [
                intParam('ocrId', ocr.id),
                intParam('lessonId', lesson.id),
            ])

            return lesson.id
        }
        return executor ? work(executor) : inTransaction(work)
    },
}

// Least-privilege application accessor for a student's marked work.
export const markingDb = {
    // Confirms the student belongs to a class that owns this lesson, and that
    // the lesson belongs to this teacher — ownership chain check before
    // marking runs, not just trusted from the request body.
    validateStudent: async (studentId, lessonId, teacherId, e = pool) =>
        (await exec(e, `
            SELECT s.id
            FROM dbo.students AS s
            JOIN dbo.classes AS c ON c.id = s.class_id
            JOIN dbo.lessons AS l ON l.class_id = c.id
            WHERE s.id = @studentId AND l.id = @lessonId AND c.teacher_id = @teacherId
        `, [
            intParam('studentId', studentId),
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    // Transaction: upsert a student's mark — delete any previous result for
    // this student/lesson pair (re-marking replaces, it doesn't accumulate),
    // then insert the new file, OCR, and grade rows in FK order.
    markStudent: async (
        studentId,
        lessonId,
        fileName,
        mimeType,
        ocrText,
        gradeJson,
        aggregationResultJson = null,
        finalResultJson = null
    ) =>
        inTransaction(async (transaction) => {
            const existing = (await exec(transaction, `
                SELECT mr.ocr_id, so.file_id
                FROM dbo.marking_results AS mr
                JOIN dbo.student_ocr AS so ON so.id = mr.ocr_id
                WHERE mr.lesson_id = @lessonId AND mr.student_id = @studentId
            `, [
                intParam('lessonId', lessonId),
                intParam('studentId', studentId),
            ])).recordset

            if (existing.length > 0) {
                const { ocr_id, file_id } = existing[0]

                await exec(transaction, `
                    DELETE FROM dbo.marking_results
                    WHERE lesson_id = @lessonId AND student_id = @studentId
                `, [
                    intParam('lessonId', lessonId),
                    intParam('studentId', studentId),
                ])
                await exec(transaction, `
                    DELETE FROM dbo.student_ocr WHERE id = @ocrId
                `, [intParam('ocrId', ocr_id)])
                await exec(transaction, `
                    DELETE FROM dbo.student_files WHERE id = @fileId
                `, [intParam('fileId', file_id)])
            }

            const file = (await exec(transaction, `
                INSERT INTO dbo.student_files (student_id, lesson_id, file_name, mime_type)
                OUTPUT INSERTED.id
                VALUES (@studentId, @lessonId, @fileName, @mimeType)
            `, [
                intParam('studentId', studentId),
                intParam('lessonId', lessonId),
                textParam('fileName', 255, fileName),
                textParam('mimeType', 100, mimeType),
            ])).recordset[0]

            const ocr = (await exec(transaction, `
                INSERT INTO dbo.student_ocr (file_id, ocr_text)
                OUTPUT INSERTED.id
                VALUES (@fileId, @ocrText)
            `, [
                intParam('fileId', file.id),
                textParam('ocrText', sql.MAX, ocrText),
            ])).recordset[0]

            await exec(transaction, `
                INSERT INTO dbo.marking_results (
                    lesson_id,
                    student_id,
                    ocr_id,
                    student_grade,
                    aggregation_result,
                    final_result
                )
                VALUES (
                    @lessonId,
                    @studentId,
                    @ocrId,
                    @grade,
                    @aggregationResult,
                    @finalResult
                )
            `, [
                intParam('lessonId', lessonId),
                intParam('studentId', studentId),
                intParam('ocrId', ocr.id),
                textParam('grade', sql.MAX, gradeJson),
                nullableTextParam('aggregationResult', sql.MAX, aggregationResultJson),
                nullableTextParam('finalResult', sql.MAX, finalResultJson),
            ])
        }),

    // Lightweight true/false check for whether a result already exists for
    // this student in this lesson — a student can belong to multiple
    // lessons, so both ids are required to identify the right row. Scoped
    // to the teacher's own classes, same join as getResults/validateStudent.
    // Only checks presence of student_grade, never returns its contents.
    checkResultPresence: async (studentId, lessonId, teacherId, e = pool) => {
        const result = (await exec(e, `
            SELECT mr.student_grade
            FROM dbo.marking_results AS mr
            JOIN dbo.lessons AS l ON l.id = mr.lesson_id
            JOIN dbo.classes AS c ON c.id = l.class_id
            WHERE mr.lesson_id = @lessonId AND mr.student_id = @studentId AND c.teacher_id = @teacherId
        `, [
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
            intParam('teacherId', teacherId),
        ])).recordset[0]

        return result?.student_grade != null
    },

    // Fetch all marking results for a lesson, scoped to the teacher's own classes.
    getResults: async (lessonId, teacherId, e = pool) =>
        (await exec(e, `
            SELECT mr.student_id, mr.student_grade, mr.aggregation_result,
                   mr.final_result, mr.marked_at
            FROM dbo.marking_results AS mr
            JOIN dbo.lessons AS l ON l.id = mr.lesson_id
            JOIN dbo.classes AS c ON c.id = l.class_id
            WHERE mr.lesson_id = @lessonId AND c.teacher_id = @teacherId
        `, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset,
}

// Durable lifecycle for asynchronous marking. The backend creates a queued
// job before publishing it, then exposes the worker-owned status through an
// ownership-scoped read route.
export const markingJobDb = {
    createQueued: async (teacherId, lessonId, studentId, e = pool) =>
        (await exec(e, `
            INSERT INTO dbo.marking_jobs
                (teacher_id, lesson_id, student_id, status, recovery_due_at)
            OUTPUT CONVERT(NVARCHAR(36), INSERTED.job_id) AS job_id
            VALUES (@teacherId, @lessonId, @studentId, N'queued',
                    DATEADD(SECOND, 60, SYSUTCDATETIME()))
        `, [
            intParam('teacherId', teacherId),
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
        ])).recordset[0],

    markPublished: async (jobId, attemptCount = 0) =>
        exec(pool, `
            UPDATE dbo.marking_jobs
            SET recovery_due_at = NULL, recovery_enqueued_at = NULL,
                updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND status = N'queued'
              AND attempt_count = @attemptCount
        `, [uuidParam('jobId', jobId), intParam('attemptCount', attemptCount)]),

    // If queue publication fails, remove the not-yet-published row so SQL
    // does not claim that work is queued when Service Bus never accepted it.
    deleteQueued: async (jobId, e = pool) =>
        exec(e, `
            DELETE FROM dbo.marking_jobs
            WHERE job_id = @jobId AND status = N'queued'
        `, [uuidParam('jobId', jobId)]),

    listLatestForLesson: async (lessonId, teacherId, e = pool) =>
        (await exec(e, `
            WITH latest_jobs AS (
                SELECT
                    mj.job_id,
                    mj.student_id,
                    mj.status,
                    mj.attempt_count,
                    mj.error_message,
                    mj.queued_at,
                    mj.processing_at,
                    mj.marking_at,
                    mj.completed_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY mj.student_id
                        ORDER BY mj.queued_at DESC, mj.job_id DESC
                    ) AS row_number
                FROM dbo.marking_jobs AS mj
                JOIN dbo.lessons AS l ON l.id = mj.lesson_id
                JOIN dbo.classes AS c ON c.id = l.class_id
                WHERE mj.lesson_id = @lessonId
                  AND mj.teacher_id = @teacherId
                  AND c.teacher_id = @teacherId
            )
            SELECT
                CONVERT(NVARCHAR(36), job_id) AS job_id,
                student_id,
                status,
                attempt_count,
                error_message,
                queued_at,
                processing_at,
                marking_at,
                completed_at
            FROM latest_jobs
            WHERE row_number = 1
        `, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset,

    recoverExpiredAttempts: async () =>
        exec(pool, `
            UPDATE dbo.marking_jobs
            SET status = CASE WHEN attempt_count >= @maxAttempts THEN N'failed' ELSE N'queued' END,
                owner_id = NULL, attempt_id = NULL, lease_expires_at = NULL,
                recovery_due_at = CASE WHEN attempt_count >= @maxAttempts
                    THEN NULL ELSE SYSUTCDATETIME() END,
                recovery_enqueued_at = NULL,
                error_message = N'Previous student marking attempt stopped responding',
                updated_at = SYSUTCDATETIME()
            WHERE status IN (N'processing', N'marking')
              AND (lease_expires_at <= SYSUTCDATETIME()
                   OR attempt_deadline_at <= SYSUTCDATETIME())
        `, [intParam('maxAttempts', STUDENT_MARKING_MAX_ATTEMPTS)]),

    failExhaustedQueued: async () =>
        exec(pool, `
            UPDATE dbo.marking_jobs
            SET status = N'failed', recovery_due_at = NULL,
                error_message = N'Student marking failed after maximum attempts',
                updated_at = SYSUTCDATETIME()
            WHERE status = N'queued' AND attempt_count >= @maxAttempts
        `, [intParam('maxAttempts', STUDENT_MARKING_MAX_ATTEMPTS)]),

    reserveRecoveryJobs: async () =>
        (await exec(pool, `
            UPDATE TOP (25) dbo.marking_jobs
            SET recovery_enqueued_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
            OUTPUT CONVERT(NVARCHAR(36), INSERTED.job_id) AS job_id,
                   INSERTED.teacher_id, INSERTED.lesson_id, INSERTED.student_id,
                   INSERTED.attempt_count
            WHERE status = N'queued' AND recovery_due_at <= SYSUTCDATETIME()
              AND attempt_count < @maxAttempts
              AND (recovery_enqueued_at IS NULL OR recovery_enqueued_at <=
                   DATEADD(SECOND, -@resendSeconds, SYSUTCDATETIME()))
        `, [intParam('maxAttempts', STUDENT_MARKING_MAX_ATTEMPTS),
            intParam('resendSeconds', STUDENT_MARKING_RECOVERY_RESEND_SECONDS)])).recordset,
}

export const markSchemeJobDb = {
    createPending: async (teacherId, classId, fileName, mimeType) =>
        (await exec(pool, `
            INSERT INTO dbo.mark_scheme_jobs (teacher_id, class_id, file_name, mime_type)
            OUTPUT CONVERT(NVARCHAR(36), INSERTED.job_id) AS job_id
            SELECT @teacherId, c.id, @fileName, @mimeType
            FROM dbo.classes AS c
            WHERE c.id = @classId AND c.teacher_id = @teacherId
        `, [
            intParam('teacherId', teacherId),
            intParam('classId', classId),
            textParam('fileName', 255, fileName),
            textParam('mimeType', 100, mimeType),
        ])).recordset[0],

    setBlobName: async (jobId, teacherId, blobName) =>
        exec(pool, `
            UPDATE dbo.mark_scheme_jobs SET blob_name = @blobName, updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND teacher_id = @teacherId AND status = N'awaiting_upload'
        `, [
            uuidParam('jobId', jobId), intParam('teacherId', teacherId),
            textParam('blobName', 512, blobName),
        ]),

    findOwned: async (jobId, teacherId) =>
        (await exec(pool, `
            SELECT CONVERT(NVARCHAR(36), j.job_id) AS job_id, j.teacher_id, j.class_id,
                   j.blob_name, j.blob_etag, j.file_name, j.mime_type, j.status,
                   j.lesson_id, j.has_multiple_questions, j.error_message,
                   j.created_at, j.queued_at, j.processing_at, j.ocr_at, j.completed_at
            FROM dbo.mark_scheme_jobs AS j
            JOIN dbo.classes AS c ON c.id = j.class_id
            WHERE j.job_id = @jobId AND j.teacher_id = @teacherId
              AND c.teacher_id = @teacherId
        `, [uuidParam('jobId', jobId), intParam('teacherId', teacherId)])).recordset[0],

    markQueued: async (jobId, teacherId, etag) =>
        (await exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET status = N'queued', blob_etag = @etag,
                queued_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(),
                recovery_due_at = DATEADD(SECOND, @resendSeconds, SYSUTCDATETIME()),
                recovery_enqueued_at = NULL
            WHERE job_id = @jobId AND teacher_id = @teacherId
              AND status = N'awaiting_upload' AND blob_name IS NOT NULL
        `, [
            uuidParam('jobId', jobId), intParam('teacherId', teacherId),
            textParam('etag', 128, etag),
            intParam('resendSeconds', MARK_SCHEME_RECOVERY_RESEND_SECONDS),
        ])).rowsAffected[0] === 1,

    restorePending: async (jobId, teacherId) =>
        exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET status = N'awaiting_upload', blob_etag = NULL,
                queued_at = NULL, recovery_due_at = NULL,
                recovery_enqueued_at = NULL, updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND teacher_id = @teacherId AND status = N'queued'
        `, [uuidParam('jobId', jobId), intParam('teacherId', teacherId)]),

    claimProcessing: async (jobId, ownerId, attemptId) =>
        inTransaction(async (transaction) => {
            // Serialize slot allocation across all backend replicas. A SQL
            // transaction lock prevents two replicas from both claiming the
            // same remaining slot.
            const allocationLock = (await exec(transaction, `
                DECLARE @result INT;
                EXEC @result = sys.sp_getapplock
                    @Resource = N'mark-scheme-processing-slots',
                    @LockMode = N'Exclusive',
                    @LockOwner = N'Transaction',
                    @LockTimeout = 10000;
                SELECT @result AS result;
            `)).recordset[0]?.result
            if (typeof allocationLock !== 'number' || allocationLock < 0) {
                throw new Error('Could not reserve mark scheme processing slot')
            }

            const active = (await exec(transaction, `
                SELECT COUNT(*) AS total FROM dbo.mark_scheme_jobs
                WHERE status IN (N'processing', N'ocr')
                  AND lease_expires_at > SYSUTCDATETIME()
            `)).recordset[0].total
            if (active >= MARK_SCHEME_MAX_CONCURRENT) return undefined

            return (await exec(transaction, `
            UPDATE dbo.mark_scheme_jobs
            SET status = N'processing', owner_id = @ownerId, attempt_id = @attemptId,
                attempt_count = attempt_count + 1,
                processing_at = SYSUTCDATETIME(), ocr_at = NULL,
                heartbeat_at = SYSUTCDATETIME(),
                lease_expires_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                attempt_deadline_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                recovery_due_at = NULL, recovery_enqueued_at = NULL,
                error_message = NULL, updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.teacher_id, INSERTED.class_id, INSERTED.blob_name,
                   INSERTED.blob_etag, INSERTED.file_name, INSERTED.mime_type,
                   INSERTED.attempt_count, INSERTED.attempt_deadline_at
            WHERE job_id = @jobId AND status = N'queued'
              AND attempt_count < @maxAttempts
            `, [
                uuidParam('jobId', jobId),
                textParam('ownerId', 128, ownerId),
                uuidParam('attemptId', attemptId),
                intParam('leaseSeconds', MARK_SCHEME_LEASE_SECONDS),
                intParam('maxAttempts', MARK_SCHEME_MAX_ATTEMPTS),
            ])).recordset[0]
        }),

    getProcessingState: async (jobId) =>
        (await exec(pool, `
            SELECT status, attempt_count, lease_expires_at
            FROM dbo.mark_scheme_jobs WHERE job_id = @jobId
        `, [uuidParam('jobId', jobId)])).recordset[0],

    heartbeat: async (jobId, attemptId) =>
        (await exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET heartbeat_at = SYSUTCDATETIME(),
                lease_expires_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND attempt_id = @attemptId
              AND status IN (N'processing', N'ocr')
              AND lease_expires_at > SYSUTCDATETIME()
              AND attempt_deadline_at > SYSUTCDATETIME()
        `, [
            uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
            intParam('leaseSeconds', MARK_SCHEME_LEASE_SECONDS),
        ])).rowsAffected[0] === 1,

    markOcr: async (jobId, attemptId) =>
        inTransaction(async (transaction) => {
            // Reserve the provider quota immediately before the OCR request,
            // after Blob download. This is a global rolling-minute gate.
            const allocationLock = (await exec(transaction, `
                DECLARE @result INT;
                EXEC @result = sys.sp_getapplock
                    @Resource = N'mark-scheme-processing-slots',
                    @LockMode = N'Exclusive',
                    @LockOwner = N'Transaction',
                    @LockTimeout = 10000;
                SELECT @result AS result;
            `)).recordset[0]?.result
            if (typeof allocationLock !== 'number' || allocationLock < 0) {
                throw new Error('Could not reserve mark scheme OCR allowance')
            }
            const owned = (await exec(transaction, `
                SELECT 1 AS owned FROM dbo.mark_scheme_jobs
                WHERE job_id = @jobId AND attempt_id = @attemptId
                  AND status = N'processing'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId)])).recordset[0]
            if (!owned) return false

            await exec(transaction, `
                DELETE FROM dbo.mark_scheme_ocr_admissions
                WHERE started_at <= DATEADD(DAY, -1, SYSUTCDATETIME())
            `)
            const recentStarts = (await exec(transaction, `
                SELECT COUNT(*) AS total FROM dbo.mark_scheme_ocr_admissions
                WHERE started_at > DATEADD(SECOND, -60, SYSUTCDATETIME())
            `)).recordset[0].total
            if (recentStarts >= MARK_SCHEME_OCR_STARTS_PER_MINUTE) return 'rate_limited'

            const admitted = (await exec(transaction, `
                UPDATE dbo.mark_scheme_jobs
                SET status = N'ocr', ocr_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
                WHERE job_id = @jobId AND attempt_id = @attemptId
                  AND status = N'processing'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId)])).rowsAffected[0] === 1
            if (!admitted) return false
            await exec(transaction, `
                INSERT INTO dbo.mark_scheme_ocr_admissions (attempt_id)
                VALUES (@attemptId)
            `, [uuidParam('attemptId', attemptId)])
            return true
        }),

    finishAttemptWithError: async (jobId, attemptId, message) =>
        (await exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET status = CASE WHEN attempt_count >= @maxAttempts THEN N'failed' ELSE N'queued' END,
                owner_id = NULL, attempt_id = NULL, lease_expires_at = NULL,
                recovery_due_at = CASE WHEN attempt_count >= @maxAttempts
                    THEN NULL ELSE SYSUTCDATETIME() END,
                recovery_enqueued_at = NULL,
                error_message = @message, updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.status
            WHERE job_id = @jobId AND attempt_id = @attemptId
              AND status IN (N'processing', N'ocr')
        `, [
            uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
            textParam('message', 500, message),
            intParam('maxAttempts', MARK_SCHEME_MAX_ATTEMPTS),
        ])).recordset[0]?.status,

    recoverExpiredAttempts: async () =>
        exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET status = CASE WHEN attempt_count >= @maxAttempts THEN N'failed' ELSE N'queued' END,
                owner_id = NULL, attempt_id = NULL, lease_expires_at = NULL,
                recovery_due_at = CASE WHEN attempt_count >= @maxAttempts
                    THEN NULL ELSE SYSUTCDATETIME() END,
                recovery_enqueued_at = NULL,
                error_message = N'Previous mark scheme attempt stopped responding',
                updated_at = SYSUTCDATETIME()
            WHERE status IN (N'processing', N'ocr')
              AND lease_expires_at <= SYSUTCDATETIME()
        `, [intParam('maxAttempts', MARK_SCHEME_MAX_ATTEMPTS)]),

    failExhaustedQueued: async () =>
        exec(pool, `
            UPDATE dbo.mark_scheme_jobs
            SET status = N'failed', recovery_due_at = NULL,
                error_message = N'Mark scheme processing failed after maximum attempts',
                updated_at = SYSUTCDATETIME()
            WHERE status = N'queued' AND attempt_count >= @maxAttempts
        `, [intParam('maxAttempts', MARK_SCHEME_MAX_ATTEMPTS)]),

    reserveRecoveryJobs: async () =>
        (await exec(pool, `
            UPDATE TOP (25) dbo.mark_scheme_jobs
            SET recovery_enqueued_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
            OUTPUT CONVERT(NVARCHAR(36), INSERTED.job_id) AS job_id
            WHERE status = N'queued' AND recovery_due_at <= SYSUTCDATETIME()
              AND (recovery_enqueued_at IS NULL OR recovery_enqueued_at <=
                   DATEADD(SECOND, -@resendSeconds, SYSUTCDATETIME()))
        `, [
            intParam('resendSeconds', MARK_SCHEME_RECOVERY_RESEND_SECONDS),
        ])).recordset,

    completeWithLesson: async (jobId, attemptId, job, file, ocrResult) =>
        inTransaction(async (transaction) => {
            const current = (await exec(transaction, `
                SELECT status, lesson_id, attempt_id,
                    CASE WHEN attempt_deadline_at > SYSUTCDATETIME()
                          AND lease_expires_at > SYSUTCDATETIME()
                        THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS before_deadline
                FROM dbo.mark_scheme_jobs WITH (UPDLOCK, HOLDLOCK)
                WHERE job_id = @jobId AND teacher_id = @teacherId
            `, [uuidParam('jobId', jobId), intParam('teacherId', job.teacher_id)])).recordset[0]

            if (!current) throw new Error('Mark scheme job not found')
            if (current.status === 'complete') return current.lesson_id
            if (current.status !== 'ocr' ||
                String(current.attempt_id).toLowerCase() !== attemptId.toLowerCase() ||
                !current.before_deadline) {
                throw new Error('Mark scheme attempt no longer owns job')
            }

            const lessonId = await lessonDb.createLesson(
                file.originalname.replace(/\.[^.]+$/, ''),
                job.class_id,
                file.originalname,
                file.mimetype,
                ocrResult.text,
                ocrResult.structured_scheme,
                ocrResult.thread_scheme,
                transaction,
                { jobId, attemptId }
            )
            const hasMultiple = (() => {
                try {
                    const parsed = JSON.parse(ocrResult.structured_scheme || '{}')
                    return parsed.paper_type === 'multi' && (parsed.questions ?? []).length > 1
                } catch { return false }
            })()

            const completion = await exec(transaction, `
                UPDATE dbo.mark_scheme_jobs
                SET status = N'complete', lesson_id = @lessonId,
                    has_multiple_questions = @hasMultiple, error_message = NULL,
                    completed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(),
                    lease_expires_at = NULL, recovery_due_at = NULL,
                    recovery_enqueued_at = NULL
                WHERE job_id = @jobId AND teacher_id = @teacherId
                  AND attempt_id = @attemptId AND status = N'ocr'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `, [
                uuidParam('jobId', jobId), intParam('teacherId', job.teacher_id),
                uuidParam('attemptId', attemptId),
                intParam('lessonId', lessonId),
                { name: 'hasMultiple', type: sql.Bit, value: hasMultiple },
            ])
            if (completion.rowsAffected[0] !== 1) {
                throw new Error('Mark scheme attempt timed out before completion')
            }
            return lessonId
        }),
}

// Every class/student method keeps the same optional executor signature so the
// route layer can compose multiple accessors into one mssql transaction.
export const classDb = {
    listClasses: async (teacherId, e = pool) =>
        (await exec(e, `
            SELECT
                c.id,
                c.class_name,
                c.year_group_id,
                CAST(COUNT(s.id) AS INT) AS student_count
            FROM dbo.classes AS c
            LEFT JOIN dbo.students AS s ON s.class_id = c.id
            WHERE c.teacher_id = @teacherId
            GROUP BY c.id, c.class_name, c.year_group_id
            ORDER BY c.class_name
        `, [
            intParam('teacherId', teacherId),
        ])).recordset,

    findClassById: async (classId, teacherId, e = pool) =>
        (await exec(e, `
            SELECT id, class_name, year_group_id
            FROM dbo.classes
            WHERE id = @classId AND teacher_id = @teacherId
        `, [
            intParam('classId', classId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    findClassByName: async (className, teacherId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.classes
            WHERE class_name = @className AND teacher_id = @teacherId
        `, [
            textParam('className', 100, className),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    findClassByNameExcluding: async (className, teacherId, classId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.classes
            WHERE class_name = @className
              AND teacher_id = @teacherId
              AND id <> @classId
        `, [
            textParam('className', 100, className),
            intParam('teacherId', teacherId),
            intParam('classId', classId),
        ])).recordset[0],

    validateYear: async (yearId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.year_groups
            WHERE id = @yearId
        `, [
            intParam('yearId', yearId),
        ])).recordset[0],

    insertClass: async (className, yearGroupId, teacherId, e = pool) =>
        (await exec(e, `
            INSERT INTO dbo.classes (class_name, year_group_id, teacher_id)
            OUTPUT INSERTED.id
            VALUES (@className, @yearGroupId, @teacherId)
        `, [
            textParam('className', 100, className),
            intParam('yearGroupId', yearGroupId),
            intParam('teacherId', teacherId),
        ])).recordset[0],

    updateClass: async (className, yearGroupId, classId, e = pool) =>
        exec(e, `
            UPDATE dbo.classes
            SET class_name = @className, year_group_id = @yearGroupId
            WHERE id = @classId
        `, [
            textParam('className', 100, className),
            intParam('yearGroupId', yearGroupId),
            intParam('classId', classId),
        ]),

    listStudents: async (classId, e = pool) =>
        (await exec(e, `
            SELECT id, student_name
            FROM dbo.students
            WHERE class_id = @classId
            ORDER BY student_name
        `, [
            intParam('classId', classId),
        ])).recordset,

    findStudentByName: async (studentName, classId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.students
            WHERE student_name = @studentName AND class_id = @classId
        `, [
            textParam('studentName', 100, studentName),
            intParam('classId', classId),
        ])).recordset[0],

    findStudentByNameExcluding: async (studentName, classId, studentId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.students
            WHERE student_name = @studentName
              AND class_id = @classId
              AND id <> @studentId
        `, [
            textParam('studentName', 100, studentName),
            intParam('classId', classId),
            intParam('studentId', studentId),
        ])).recordset[0],

    findStudentById: async (studentId, classId, e = pool) =>
        (await exec(e, `
            SELECT id
            FROM dbo.students
            WHERE id = @studentId AND class_id = @classId
        `, [
            intParam('studentId', studentId),
            intParam('classId', classId),
        ])).recordset[0],

    insertStudent: async (studentName, classId, e = pool) =>
        (await exec(e, `
            INSERT INTO dbo.students (student_name, class_id)
            OUTPUT INSERTED.id
            VALUES (@studentName, @classId)
        `, [
            textParam('studentName', 100, studentName),
            intParam('classId', classId),
        ])).recordset[0],

    updateStudent: async (studentName, studentId, e = pool) =>
        exec(e, `
            UPDATE dbo.students
            SET student_name = @studentName
            WHERE id = @studentId
        `, [
            textParam('studentName', 100, studentName),
            intParam('studentId', studentId),
        ]),

    // Delete the student and their derived data in foreign-key-safe order.
    deleteStudent: async (studentId) =>
        inTransaction(async (transaction) => {
            await exec(transaction, `
                DELETE FROM dbo.marking_results
                WHERE student_id = @studentId
            `, [intParam('studentId', studentId)])

            await exec(transaction, `
                DELETE FROM dbo.student_ocr
                WHERE file_id IN (
                    SELECT id
                    FROM dbo.student_files
                    WHERE student_id = @studentId
                )
            `, [intParam('studentId', studentId)])

            await exec(transaction, `
                DELETE FROM dbo.student_files
                WHERE student_id = @studentId
            `, [intParam('studentId', studentId)])

            await exec(transaction, `
                DELETE FROM dbo.students
                WHERE id = @studentId
            `, [intParam('studentId', studentId)])
        }),

    // Execute fn atomically. fn receives an mssql Transaction which can be
    // passed unchanged to any accessor's optional executor argument.
    transaction: (fn) => inTransaction(fn),
}
