import sql from 'mssql'

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
    SELECT t.ocr_text, t.structured_scheme, t.selected_question_index
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
    markProcessing: async (jobId, teacherId, lessonId, studentId, executor = pool) => {
        const updated = (await exec(executor, `
            UPDATE dbo.marking_jobs
            SET status = N'processing',
                processing_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.status
            WHERE job_id = @jobId
              AND teacher_id = @teacherId
              AND lesson_id = @lessonId
              AND student_id = @studentId
              AND status <> N'complete'
        `, [
            uuidParam('jobId', jobId),
            intParam('teacherId', teacherId),
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
        ])).recordset[0]

        if (updated) return true

        const existing = (await exec(executor, `
            SELECT status
            FROM dbo.marking_jobs
            WHERE job_id = @jobId
              AND teacher_id = @teacherId
              AND lesson_id = @lessonId
              AND student_id = @studentId
        `, [
            uuidParam('jobId', jobId),
            intParam('teacherId', teacherId),
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
        ])).recordset[0]

        // A redelivered message whose SQL transaction already committed is
        // safe to settle without running the expensive AI call again.
        if (existing?.status === 'complete') return false

        throw new Error('Marking job not found')
    },

    markMarking: async (jobId, teacherId, lessonId, studentId, executor = pool) => {
        const result = await exec(executor, `
            UPDATE dbo.marking_jobs
            SET status = N'marking',
                marking_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
            WHERE job_id = @jobId
              AND teacher_id = @teacherId
              AND lesson_id = @lessonId
              AND student_id = @studentId
              AND status <> N'complete'
        `, [
            uuidParam('jobId', jobId),
            intParam('teacherId', teacherId),
            intParam('lessonId', lessonId),
            intParam('studentId', studentId),
        ])

        if (result.rowsAffected[0] !== 1) {
            throw new Error('Marking job could not enter marking state')
        }
    },
}

// The only write operation the marking worker needs: transactionally replace
// or create the already-authorised student's persisted marking result, then
// mark that same job complete in the same transaction.
export const markingDb = {
    markStudent: async (
        jobId,
        teacherId,
        studentId,
        lessonId,
        fileName,
        mimeType,
        ocrText,
        gradeJson
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
                INSERT INTO dbo.marking_results (lesson_id, student_id, ocr_id, student_grade)
                VALUES (@lessonId, @studentId, @ocrId, @grade)
            `, [
                intParam('lessonId', lessonId),
                intParam('studentId', studentId),
                intParam('ocrId', ocr.id),
                textParam('grade', sql.MAX, gradeJson),
            ])

            const completed = await exec(transaction, `
                UPDATE dbo.marking_jobs
                SET status = N'complete',
                    completed_at = SYSUTCDATETIME(),
                    updated_at = SYSUTCDATETIME()
                WHERE job_id = @jobId
                  AND teacher_id = @teacherId
                  AND lesson_id = @lessonId
                  AND student_id = @studentId
            `, [
                uuidParam('jobId', jobId),
                intParam('teacherId', teacherId),
                intParam('lessonId', lessonId),
                intParam('studentId', studentId),
            ])

            if (completed.rowsAffected[0] !== 1) {
                throw new Error('Marking result was produced for an unknown job')
            }
        }),
}
