// Run against the local SQL Server only:
//   node --env-file=.env testing/markSchemeLease.integration.mjs
// Creates and removes an isolated database; it never touches SQL_DATABASE.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import { MARK_SCHEME_MAX_CONCURRENT } from '../src/config/markSchemeProcessing.js'

if (!process.env.SQL_USER || !process.env.SQL_PASSWORD ||
    !['localhost', '127.0.0.1'].includes(process.env.SQL_SERVER)) {
    throw new Error('This test requires local SQL credentials and SQL_SERVER=localhost')
}

const database = `MarkSchemeLeaseTest_${randomBytes(4).toString('hex')}`
const connection = {
    server: process.env.SQL_SERVER,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
}
const master = await new sql.ConnectionPool({ ...connection, database: 'master' }).connect()
let appPool
let jobPool

try {
    await master.request().batch(`CREATE DATABASE [${database}]`)
    appPool = await new sql.ConnectionPool({ ...connection, database }).connect()
    const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
    for (const batch of schema.split(/^\s*GO\s*$/im).map(x => x.trim()).filter(Boolean)) {
        await appPool.request().batch(batch)
    }

    process.env.SQL_DATABASE = database
    const { markSchemeJobDb, pool, poolConnect } = await import('../src/db/index.js')
    jobPool = pool
    await poolConnect

    const fixture = await appPool.request().query(`
        INSERT dbo.teachers (name, email_hash, password_hash)
        VALUES (N'Lease Test', REPLICATE(N'a', 64), N'dummy');
        DECLARE @teacher INT = SCOPE_IDENTITY();
        INSERT dbo.classes (class_name, year_group_id, teacher_id)
        VALUES (N'Lease Test', 7, @teacher);
        SELECT @teacher AS teacher_id, CAST(SCOPE_IDENTITY() AS INT) AS class_id;
    `)
    const { teacher_id: teacherId, class_id: classId } = fixture.recordset[0]
    const job = { teacher_id: teacherId, class_id: classId }
    const file = { originalname: 'scheme.pdf', mimetype: 'application/pdf' }
    const ocr = { text: 'test', structured_scheme: '{}', thread_scheme: '{}' }

    const pending = await markSchemeJobDb.createPending(teacherId, classId, 'pending.pdf', 'application/pdf')
    await markSchemeJobDb.setBlobName(pending.job_id, teacherId, 'pending.pdf')
    assert.equal(await markSchemeJobDb.markQueued(pending.job_id, teacherId, 'etag'), true)
    const pendingRecovery = await appPool.request()
        .input('id', sql.UniqueIdentifier, pending.job_id)
        .query('SELECT recovery_due_at FROM dbo.mark_scheme_jobs WHERE job_id = @id')
    assert.ok(pendingRecovery.recordset[0].recovery_due_at)
    await markSchemeJobDb.restorePending(pending.job_id, teacherId)
    assert.equal((await markSchemeJobDb.getProcessingState(pending.job_id)).status, 'awaiting_upload')

    async function insertJob() {
        const id = randomUUID()
        await appPool.request().input('id', sql.UniqueIdentifier, id)
            .input('teacher', sql.Int, teacherId).input('class', sql.Int, classId)
            .query(`INSERT dbo.mark_scheme_jobs
                (job_id, teacher_id, class_id, file_name, mime_type, status, blob_name, blob_etag)
                VALUES (@id, @teacher, @class, N'scheme.pdf', N'application/pdf',
                    N'queued', N'test.pdf', N'etag')`)
        return id
    }

    const firstJob = await insertJob()
    const firstAttempt = randomUUID()
    const claimed = await markSchemeJobDb.claimProcessing(firstJob, 'worker-a', firstAttempt)
    assert.equal(claimed.attempt_count, 1)
    assert.equal(await markSchemeJobDb.claimProcessing(firstJob, 'worker-b', randomUUID()), undefined)
    assert.equal(await markSchemeJobDb.heartbeat(firstJob, firstAttempt), true)

    await appPool.request().input('id', sql.UniqueIdentifier, firstJob).query(`
        UPDATE dbo.mark_scheme_jobs
        SET lease_expires_at = DATEADD(SECOND, -1, SYSUTCDATETIME())
        WHERE job_id = @id`)
    await markSchemeJobDb.recoverExpiredAttempts()
    assert.equal((await markSchemeJobDb.getProcessingState(firstJob)).status, 'queued')
    assert.equal(await markSchemeJobDb.markOcr(firstJob, firstAttempt), false)
    assert.equal((await markSchemeJobDb.reserveRecoveryJobs()).length, 1)

    const secondAttempt = randomUUID()
    assert.equal((await markSchemeJobDb.claimProcessing(firstJob, 'worker-b', secondAttempt)).attempt_count, 2)
    assert.equal(await markSchemeJobDb.finishAttemptWithError(firstJob, firstAttempt, 'stale'), undefined)
    assert.equal(await markSchemeJobDb.markOcr(firstJob, secondAttempt), true)
    const lessonId = await markSchemeJobDb.completeWithLesson(firstJob, secondAttempt, job, file, ocr)
    assert.ok(lessonId > 0)
    assert.equal((await markSchemeJobDb.getProcessingState(firstJob)).status, 'complete')
    assert.equal(await markSchemeJobDb.heartbeat(firstJob, secondAttempt), false)

    const failedJob = await insertJob()
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber++) {
        const attemptId = randomUUID()
        assert.equal((await markSchemeJobDb.claimProcessing(failedJob, 'worker', attemptId)).attempt_count, attemptNumber)
        assert.equal(await markSchemeJobDb.finishAttemptWithError(failedJob, attemptId, 'failure'),
            attemptNumber === 3 ? 'failed' : 'queued')
    }
    assert.equal(await markSchemeJobDb.claimProcessing(failedJob, 'worker', randomUUID()), undefined)

    const raceJob = await insertJob()
    const winners = await Promise.all([
        markSchemeJobDb.claimProcessing(raceJob, 'worker-a', randomUUID()),
        markSchemeJobDb.claimProcessing(raceJob, 'worker-b', randomUUID()),
    ])
    assert.equal(winners.filter(Boolean).length, 1)

    const expiredJob = await insertJob()
    const expiredAttempt = randomUUID()
    await markSchemeJobDb.claimProcessing(expiredJob, 'worker', expiredAttempt)
    assert.equal(await markSchemeJobDb.markOcr(expiredJob, expiredAttempt), true)
    await appPool.request().input('id', sql.UniqueIdentifier, expiredJob).query(`
        UPDATE dbo.mark_scheme_jobs
        SET attempt_deadline_at = DATEADD(SECOND, -1, SYSUTCDATETIME())
        WHERE job_id = @id`)
    await assert.rejects(() => markSchemeJobDb.completeWithLesson(
        expiredJob, expiredAttempt, job, file, ocr
    ), /no longer owns job/)

    // Earlier lease checks leave active jobs behind; isolate the slot limit.
    await appPool.request().query(`
        UPDATE dbo.mark_scheme_jobs SET status = N'failed'
        WHERE status IN (N'processing', N'ocr')
    `)
    assert.equal(MARK_SCHEME_MAX_CONCURRENT, 5)
    const slotJobs = []
    for (let n = 0; n < MARK_SCHEME_MAX_CONCURRENT; n++) {
        const jobId = await insertJob()
        const attemptId = randomUUID()
        assert.ok(await markSchemeJobDb.claimProcessing(jobId, 'worker', attemptId))
        slotJobs.push({ jobId, attemptId })
    }
    const waitingJob = await insertJob()
    assert.equal(await markSchemeJobDb.claimProcessing(waitingJob, 'worker', randomUUID()), undefined)
    await markSchemeJobDb.finishAttemptWithError(
        slotJobs[0].jobId, slotJobs[0].attemptId, 'release slot'
    )
    assert.ok(await markSchemeJobDb.claimProcessing(waitingJob, 'worker', randomUUID()))

    // Isolate the rolling-minute gate from the earlier ownership checks.
    await appPool.request().query(`
        UPDATE dbo.mark_scheme_jobs SET status = N'failed'
        WHERE status IN (N'processing', N'ocr');
        DELETE FROM dbo.mark_scheme_ocr_admissions;
    `)
    for (let n = 0; n < 10; n++) {
        const rateJob = await insertJob()
        const rateAttempt = randomUUID()
        assert.ok(await markSchemeJobDb.claimProcessing(rateJob, 'worker', rateAttempt))
        assert.equal(await markSchemeJobDb.markOcr(rateJob, rateAttempt), true)
        await markSchemeJobDb.finishAttemptWithError(rateJob, rateAttempt, 'release slot')
    }
    const rateLimitedJob = await insertJob()
    const rateLimitedAttempt = randomUUID()
    assert.ok(await markSchemeJobDb.claimProcessing(rateLimitedJob, 'worker', rateLimitedAttempt))
    assert.equal(await markSchemeJobDb.markOcr(rateLimitedJob, rateLimitedAttempt), 'rate_limited')
    await appPool.request().query(`
        UPDATE TOP (1) dbo.mark_scheme_ocr_admissions
        SET started_at = DATEADD(SECOND, -61, SYSUTCDATETIME());
    `)
    assert.equal(await markSchemeJobDb.markOcr(rateLimitedJob, rateLimitedAttempt), true)

    console.log('Mark scheme queue, lease, fencing, recovery, deadline, retry, slot, and OCR rate checks passed.')
} finally {
    if (jobPool) await jobPool.close()
    if (appPool) await appPool.close()
    await master.request().batch(`
        IF DB_ID(N'${database}') IS NOT NULL
        BEGIN
            ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
            DROP DATABASE [${database}];
        END`)
    await master.close()
}
