import sql from 'mssql'
import {
    MARKING_BATCH_TIMEOUT_MS,
    MARKING_LEASE_SECONDS,
    MARKING_MAX_ATTEMPTS,
    MARKING_MAX_CONCURRENT,
    MARKING_OCR_BATCH_CONCURRENCY,
    MARKING_RECOVERY_RESEND_SECONDS,
} from '../config/markingProcessing.js'

function requireEnvironmentVariable(name) {
    const value = process.env[name]?.trim()
    if (!value) {
        throw new Error(`${name} environment variable is not set`)
    }
    return value
}

const sqlServer = requireEnvironmentVariable('SQL_SERVER')
const sqlDatabase = requireEnvironmentVariable('SQL_DATABASE')
const sqlUser = process.env.SQL_USER?.trim() || null
const sqlPassword = process.env.SQL_PASSWORD || null
const localOcrRetry = Boolean(
    process.env.AZURE_SERVICEBUS_CONNECTION_STRING && sqlUser && sqlPassword &&
    ['localhost', '127.0.0.1'].includes(sqlServer)
)

// SQL username and password are a pair. Supplying only one would otherwise
// silently select the production managed-identity path and make the resulting
// authentication failure difficult to diagnose.
if (Boolean(sqlUser) !== Boolean(sqlPassword)) {
    throw new Error('SQL_USER and SQL_PASSWORD must either both be set or both be unset')
}

// Local development connects to the docker-compose SQL Server with SQL
// authentication. In Azure, SQL_USER and SQL_PASSWORD remain unset and the
// worker's own managed identity is used instead, so no database secret is
// stored by the service.
const dbConfig = sqlUser
    ? {
        server: sqlServer,
        database: sqlDatabase,
        user: sqlUser,
        password: sqlPassword,
        options: {
            encrypt: true,
            trustServerCertificate: true,
        },
        connectionTimeout: 30000,
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    }
    : {
        server: sqlServer,
        database: sqlDatabase,
        authentication: { type: 'azure-active-directory-default' },
        options: {
            encrypt: true,
            trustServerCertificate: false,
        },
        connectionTimeout: 30000,
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

const exec = async (executor, queryText, params = []) => {
    const request = new sql.Request(executor)
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
        try {
            await transaction.rollback()
        } catch (rollbackErr) {
            err.rollbackError = rollbackErr
        }
        throw err
    }
}

const SQL_LESSON_OCR_TEXT = `
    SELECT t.ocr_text, t.structured_scheme, t.thread_extraction,
           t.selected_question_index
    FROM dbo.teacher_ocr AS t
    JOIN dbo.lessons AS l ON t.lesson_id = l.id
    JOIN dbo.classes AS c ON l.class_id = c.id
    WHERE l.id = @lessonId AND c.teacher_id = @teacherId
`

// The marking worker only needs the ownership-scoped mark-scheme read that
// the former mark-student route used; unrelated lesson operations stay in the
// backend.
export const lessonDb = {
    getOcrText: async (lessonId, teacherId, executor = pool) =>
        (await exec(executor, SQL_LESSON_OCR_TEXT, [
            intParam('lessonId', lessonId),
            intParam('teacherId', teacherId),
        ])).recordset[0],
}

// Service Bus carries the job id created by the backend. The worker owns the
// lifecycle transitions after queueing; SQL remains the durable source of
// truth read by the backend's status endpoint.
export const markingJobDb = {
    // Count OCR-stage attempts, not student rows: one attempt can own several
    // rows, and marking-stage rows no longer occupy an OCR slot.
    claimBatch: async (leader, ownerId, attemptId, batchSize, dynamic = false) =>
        inTransaction(async transaction => {
            const lock = (await exec(transaction, `
                DECLARE @result INT;
                EXEC @result = sys.sp_getapplock
                    @Resource = N'student-marking-processing-slots',
                    @LockMode = N'Exclusive', @LockOwner = N'Transaction',
                    @LockTimeout = 10000;
                SELECT @result AS result;
            `)).recordset[0]?.result
            if (typeof lock !== 'number' || lock < 0) {
                throw new Error('Could not reserve student marking batch')
            }
            const active = (await exec(transaction, `
                SELECT COUNT(DISTINCT attempt_id) AS total FROM dbo.marking_jobs
                WHERE status = N'processing'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `)).recordset[0].total
            if (active >= MARKING_OCR_BATCH_CONCURRENCY) return { capacityBusy: true }
            const freeSlots = MARKING_OCR_BATCH_CONCURRENCY - active

            const leaderRow = (await exec(transaction, `
                SELECT job_id, teacher_id, lesson_id, student_id
                FROM dbo.marking_jobs WITH (UPDLOCK, HOLDLOCK)
                WHERE job_id = @jobId AND teacher_id = @teacherId
                  AND lesson_id = @lessonId AND student_id = @studentId
                  AND status = N'queued' AND attempt_count < @maxAttempts
                  ${localOcrRetry ? 'AND ocr_retry_pending = @retryLeader' : ''}
                  ${localOcrRetry
        ? 'AND (recovery_due_at IS NULL OR recovery_due_at <= SYSUTCDATETIME())' : ''}
            `, [uuidParam('jobId', leader.jobId),
                intParam('teacherId', leader.teacherId),
                intParam('lessonId', leader.lessonId),
                intParam('studentId', leader.studentId),
                intParam('maxAttempts', MARKING_MAX_ATTEMPTS),
                ...(localOcrRetry
                    ? [intParam('retryLeader', leader.retry ? 1 : 0)] : [])])).recordset[0]
            if (!leaderRow) return null

            const eligible = dynamic ? (await exec(transaction, `
                SELECT COUNT(*) AS total FROM dbo.marking_jobs
                WHERE teacher_id = @teacherId AND lesson_id = @lessonId
                  AND status = N'queued' AND attempt_count < @maxAttempts
                  ${localOcrRetry
        ? 'AND (recovery_due_at IS NULL OR recovery_due_at <= SYSUTCDATETIME())' : ''}
            `, [intParam('teacherId', leader.teacherId),
                intParam('lessonId', leader.lessonId),
                intParam('maxAttempts', MARKING_MAX_ATTEMPTS)])).recordset[0].total : batchSize
            // Recalculate after every claim: 9 jobs and 5 free slots become
            // 2,2,2,2,1; one job starts as a one-page OCR request.
            const targetSize = dynamic
                ? Math.min(batchSize, Math.ceil(eligible / freeSlots)) : batchSize

            const companions = targetSize === 1 ? [] : (await exec(transaction, `
                SELECT TOP (@companionCount) job_id, teacher_id, lesson_id, student_id
                FROM dbo.marking_jobs WITH (UPDLOCK, HOLDLOCK)
                WHERE teacher_id = @teacherId AND lesson_id = @lessonId
                  AND job_id <> @jobId AND status = N'queued'
                  AND attempt_count < @maxAttempts
                  ${localOcrRetry
        ? 'AND (recovery_due_at IS NULL OR recovery_due_at <= SYSUTCDATETIME())' : ''}
                ORDER BY ${localOcrRetry ? 'ocr_retry_pending DESC,' : ''}
                         queued_at, job_id
            `, [intParam('companionCount', targetSize - 1),
                intParam('teacherId', leader.teacherId),
                intParam('lessonId', leader.lessonId),
                uuidParam('jobId', leader.jobId),
                intParam('maxAttempts', MARKING_MAX_ATTEMPTS)])).recordset
            if (companions.length !== targetSize - 1 &&
                !(leader.retry && companions.length === 0)) return null

            const rows = [leaderRow, ...companions]
            const ids = rows.map((row, index) => uuidParam(`batchJob${index}`, String(row.job_id)))
            const placeholders = ids.map(({ name }) => `@${name}`).join(', ')
            const claimed = (await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = N'processing', owner_id = @ownerId,
                    attempt_id = @attemptId, attempt_count = attempt_count + 1,
                    ${localOcrRetry
        ? 'try_id = NEWID(), ocr_try_count = ocr_try_count + 1,' : ''}
                    processing_at = SYSUTCDATETIME(), marking_at = NULL,
                    heartbeat_at = SYSUTCDATETIME(),
                    lease_expires_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                    attempt_deadline_at = DATEADD(SECOND, @deadlineSeconds, SYSUTCDATETIME()),
                    recovery_due_at = NULL, recovery_enqueued_at = NULL,
                    error_message = NULL, updated_at = SYSUTCDATETIME()
                OUTPUT INSERTED.job_id, INSERTED.attempt_count,
                       INSERTED.attempt_deadline_at
                       ${localOcrRetry ? ', INSERTED.try_id, INSERTED.ocr_try_count' : ''}
                WHERE job_id IN (${placeholders}) AND status = N'queued'
            `, [...ids, textParam('ownerId', 128, ownerId),
                uuidParam('attemptId', attemptId),
                intParam('leaseSeconds', MARKING_LEASE_SECONDS),
                intParam('deadlineSeconds', Math.ceil(MARKING_BATCH_TIMEOUT_MS / 1000))])).recordset
            if (claimed.length !== rows.length) throw new Error('Could not claim marking batch')

            if (localOcrRetry) {
                await exec(transaction, `
                    INSERT INTO dbo.marking_ocr_tries (try_id, job_id, attempt_id, try_number)
                    SELECT try_id, job_id, attempt_id, ocr_try_count
                    FROM dbo.marking_jobs
                    WHERE job_id IN (${placeholders}) AND attempt_id = @attemptId
                `, [...ids, uuidParam('attemptId', attemptId)])
            }

            const byId = new Map(claimed.map(row => [String(row.job_id).toLowerCase(), row]))
            return rows.map(row => {
                const claimedRow = byId.get(String(row.job_id).toLowerCase())
                return {
                    jobId: String(row.job_id),
                    teacherId: row.teacher_id,
                    lessonId: row.lesson_id,
                    studentId: row.student_id,
                    attemptCount: claimedRow.attempt_count,
                    tryId: claimedRow.try_id ? String(claimedRow.try_id) : null,
                    ocrTryCount: claimedRow.ocr_try_count,
                    deadlineAt: claimedRow.attempt_deadline_at,
                }
            })
        }),

    claimProcessing: async (jobId, ownerId, attemptId, teacherId, lessonId, studentId) =>
        inTransaction(async transaction => {
            const lock = (await exec(transaction, `
                DECLARE @result INT;
                EXEC @result = sys.sp_getapplock
                    @Resource = N'student-marking-processing-slots',
                    @LockMode = N'Exclusive', @LockOwner = N'Transaction',
                    @LockTimeout = 10000;
                SELECT @result AS result;
            `)).recordset[0]?.result
            if (typeof lock !== 'number' || lock < 0) {
                throw new Error('Could not reserve student marking slot')
            }
            const active = (await exec(transaction, `
                SELECT COUNT(*) AS total FROM dbo.marking_jobs
                WHERE status IN (N'processing', N'marking')
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `)).recordset[0].total
            if (active >= MARKING_MAX_CONCURRENT) return null

            return (await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = N'processing', owner_id = @ownerId,
                    attempt_id = @attemptId, attempt_count = attempt_count + 1,
                    processing_at = SYSUTCDATETIME(), marking_at = NULL,
                    heartbeat_at = SYSUTCDATETIME(),
                    lease_expires_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                    attempt_deadline_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                    recovery_due_at = NULL, recovery_enqueued_at = NULL,
                    error_message = NULL, updated_at = SYSUTCDATETIME()
                OUTPUT INSERTED.attempt_count, INSERTED.attempt_deadline_at
                WHERE job_id = @jobId AND teacher_id = @teacherId
                  AND lesson_id = @lessonId AND student_id = @studentId
                  AND status = N'queued' AND attempt_count < @maxAttempts
            `, [
                uuidParam('jobId', jobId), textParam('ownerId', 128, ownerId),
                uuidParam('attemptId', attemptId), intParam('teacherId', teacherId),
                intParam('lessonId', lessonId), intParam('studentId', studentId),
                intParam('leaseSeconds', MARKING_LEASE_SECONDS),
                intParam('maxAttempts', MARKING_MAX_ATTEMPTS),
            ])).recordset[0] ?? null
        }),

    getProcessingState: async jobId =>
        (await exec(pool, `
            SELECT status, attempt_count
                   ${localOcrRetry ? ', ocr_retry_pending' : ''}
            FROM dbo.marking_jobs WHERE job_id = @jobId
        `, [uuidParam('jobId', jobId)])).recordset[0],

    scheduleRecovery: async jobId =>
        exec(pool, `
            UPDATE dbo.marking_jobs
            SET recovery_due_at = SYSUTCDATETIME(),
                recovery_enqueued_at = NULL, updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND status = N'queued'
        `, [uuidParam('jobId', jobId)]),

    heartbeat: async (jobId, attemptId) =>
        (await exec(pool, `
            UPDATE dbo.marking_jobs
            SET heartbeat_at = SYSUTCDATETIME(),
                lease_expires_at = DATEADD(SECOND, @leaseSeconds, SYSUTCDATETIME()),
                updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId AND attempt_id = @attemptId
              AND status IN (N'processing', N'marking')
              AND lease_expires_at > SYSUTCDATETIME()
              AND attempt_deadline_at > SYSUTCDATETIME()
        `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
            intParam('leaseSeconds', MARKING_LEASE_SECONDS)])).rowsAffected[0] === 1,

    markMarking: async (jobId, attemptId, teacherId, lessonId, studentId, executor = pool) => {
        const result = await exec(executor, `
            UPDATE dbo.marking_jobs
            SET status = N'marking',
                ${localOcrRetry ? 'ocr_retry_pending = 0,' : ''}
                marking_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId
              AND attempt_id = @attemptId
              AND teacher_id = @teacherId
              AND lesson_id = @lessonId
              AND student_id = @studentId
              AND status = N'processing'
              AND lease_expires_at > SYSUTCDATETIME()
              AND attempt_deadline_at > SYSUTCDATETIME()
        `, [
            uuidParam('jobId', jobId),
            uuidParam('attemptId', attemptId),
            intParam('teacherId', teacherId),
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
        ])

        if (result.rowsAffected[0] !== 1) {
            throw new Error('Student marking attempt lost ownership before AI call')
        }
        if (localOcrRetry) {
            await exec(executor, `
                UPDATE dbo.marking_ocr_tries
                SET outcome = N'succeeded', finished_at = SYSUTCDATETIME()
                WHERE try_id = (SELECT try_id FROM dbo.marking_jobs WHERE job_id = @jobId)
                  AND outcome = N'processing'
            `, [uuidParam('jobId', jobId)])
        }
    },

    markOcrEmpty: async (jobId, attemptId) =>
        inTransaction(async transaction => {
            const row = (await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = CASE WHEN attempt_count >= @maxAttempts
                        THEN N'failed' ELSE N'queued' END,
                    ocr_retry_pending = CASE WHEN attempt_count >= @maxAttempts
                        THEN 0 ELSE 1 END,
                    owner_id = NULL, attempt_id = NULL, lease_expires_at = NULL,
                    recovery_due_at = CASE WHEN attempt_count >= @maxAttempts
                        THEN NULL ELSE SYSUTCDATETIME() END,
                    recovery_enqueued_at = NULL,
                    error_message = N'Empty student OCR text',
                    updated_at = SYSUTCDATETIME()
                OUTPUT INSERTED.status, INSERTED.try_id
                WHERE job_id = @jobId AND attempt_id = @attemptId
                  AND status = N'processing'
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
                intParam('maxAttempts', MARKING_MAX_ATTEMPTS)])).recordset[0]
            if (!row) throw new Error('Student OCR try no longer owns job')
            await exec(transaction, `
                UPDATE dbo.marking_ocr_tries
                SET outcome = N'empty', finished_at = SYSUTCDATETIME()
                WHERE try_id = @tryId
            `, [uuidParam('tryId', String(row.try_id))])
            return row.status
        }),

    rejectInvalidFile: async (jobId, attemptId, reason) =>
        inTransaction(async transaction => {
            const row = (await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = N'failed', owner_id = NULL, attempt_id = NULL,
                    lease_expires_at = NULL, recovery_due_at = NULL,
                    recovery_enqueued_at = NULL,
                    ${localOcrRetry ? 'ocr_retry_pending = 0,' : ''}
                    error_message = @reason, updated_at = SYSUTCDATETIME()
                OUTPUT INSERTED.job_id ${localOcrRetry ? ', INSERTED.try_id' : ''}
                WHERE job_id = @jobId AND attempt_id = @attemptId
                  AND status = N'processing'
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
                textParam('reason', 500, reason.slice(0, 500))])).recordset[0]
            if (!row) throw new Error('Student file validation lost job ownership')
            if (localOcrRetry && row.try_id) {
                await exec(transaction, `
                    UPDATE dbo.marking_ocr_tries
                    SET outcome = N'invalid_file', finished_at = SYSUTCDATETIME()
                    WHERE try_id = @tryId AND outcome = N'processing'
                `, [uuidParam('tryId', String(row.try_id))])
            }
        }),

    finishAttemptWithError: async (jobId, attemptId) =>
        inTransaction(async transaction => {
            const row = (await exec(transaction, `
            UPDATE dbo.marking_jobs
            SET status = CASE WHEN attempt_count >= @maxAttempts THEN N'failed' ELSE N'queued' END,
                owner_id = NULL, attempt_id = NULL, lease_expires_at = NULL,
                recovery_due_at = CASE WHEN attempt_count >= @maxAttempts
                    THEN NULL ELSE DATEADD(SECOND, @resendSeconds, SYSUTCDATETIME()) END,
                recovery_enqueued_at = NULL,
                error_message = N'Student marking failed or timed out',
                updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.status, DELETED.status AS previous_status
                   ${localOcrRetry ? ', INSERTED.try_id' : ''}
            WHERE job_id = @jobId AND attempt_id = @attemptId
              AND status IN (N'processing', N'marking')
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
            intParam('maxAttempts', MARKING_MAX_ATTEMPTS),
            intParam('resendSeconds', MARKING_RECOVERY_RESEND_SECONDS)])).recordset[0]
            if (localOcrRetry && row?.previous_status === 'processing' && row.try_id) {
                await exec(transaction, `
                    UPDATE dbo.marking_ocr_tries
                    SET outcome = N'error', finished_at = SYSUTCDATETIME()
                    WHERE try_id = @tryId AND outcome = N'processing'
                `, [uuidParam('tryId', String(row.try_id))])
            }
            return row?.status
        }),
}

// The only write operation the marking worker needs: transactionally replace
// or create the already-authorised student's persisted marking result, then
// mark that same job complete in the same transaction.
export const markingDb = {
    markStudent: async (
        jobId,
        attemptId,
        teacherId,
        studentId,
        lessonId,
        fileName,
        mimeType,
        ocrText,
        gradeJson,
        aggregationResultJson,
        finalResultJson = null
    ) =>
        inTransaction(async (transaction) => {
            const owned = (await exec(transaction, `
                SELECT 1 AS owned FROM dbo.marking_jobs WITH (UPDLOCK, HOLDLOCK)
                WHERE job_id = @jobId AND attempt_id = @attemptId
                  AND teacher_id = @teacherId AND lesson_id = @lessonId
                  AND student_id = @studentId AND status = N'marking'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `, [uuidParam('jobId', jobId), uuidParam('attemptId', attemptId),
                intParam('teacherId', teacherId), intParam('lessonId', lessonId),
                intParam('studentId', studentId)])).recordset[0]
            if (!owned) throw new Error('Student marking attempt no longer owns job')

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

            const completed = await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = N'complete',
                    completed_at = SYSUTCDATETIME(),
                    lease_expires_at = NULL, recovery_due_at = NULL,
                    recovery_enqueued_at = NULL, error_message = NULL,
                    updated_at = SYSUTCDATETIME()
                WHERE job_id = @jobId
                  AND attempt_id = @attemptId
                  AND teacher_id = @teacherId
                  AND lesson_id = @lessonId
                  AND student_id = @studentId
                  AND status = N'marking'
                  AND lease_expires_at > SYSUTCDATETIME()
                  AND attempt_deadline_at > SYSUTCDATETIME()
            `, [
                uuidParam('jobId', jobId),
                uuidParam('attemptId', attemptId),
                intParam('teacherId', teacherId),
                intParam('lessonId', lessonId),
                intParam('studentId', studentId),
            ])

            if (completed.rowsAffected[0] !== 1) {
                throw new Error('Student marking attempt timed out before result commit')
            }
        }),
}
