// Run against local SQL only, with backend/.env (includes backend config keys).
// Creates and drops an isolated database; never changes SQL_DATABASE.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import {
    MARKING_MAX_CONCURRENT,
    MARKING_OCR_BATCH_CONCURRENCY,
} from '../config/markingProcessing.js'

if (!process.env.SQL_USER || !process.env.SQL_PASSWORD ||
    !['localhost', '127.0.0.1'].includes(process.env.SQL_SERVER)) {
    throw new Error('This test requires local SQL credentials and SQL_SERVER=localhost')
}

const database = `StudentMarkingLeaseTest_${randomBytes(4).toString('hex')}`
const connection = {
    server: process.env.SQL_SERVER,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
}
const master = await new sql.ConnectionPool({ ...connection, database: 'master' }).connect()
let appPool
let workerPool
let backendPool

try {
    await master.request().batch(`CREATE DATABASE [${database}]`)
    appPool = await new sql.ConnectionPool({ ...connection, database }).connect()
    const schema = await readFile(new URL('../../backend/db/schema.sql', import.meta.url), 'utf8')
    for (const batch of schema.split(/^\s*GO\s*$/im).map(x => x.trim()).filter(Boolean)) {
        await appPool.request().batch(batch)
    }
    const migration = await readFile(
        new URL('../../backend/db/migrations/20261018-student-marking-processing.sql', import.meta.url),
        'utf8'
    )
    const migrationBatches = migration.split(/^\s*GO\s*$/im).map(x => x.trim()).filter(Boolean)
    for (let run = 0; run < 2; run++) {
        for (const batch of migrationBatches) await appPool.request().batch(batch)
    }

    process.env.SQL_DATABASE = database
    const workerDb = await import('../SQL/index.js')
    const backendDb = await import('../../backend/src/db/index.js')
    workerPool = workerDb.pool
    backendPool = backendDb.pool
    await Promise.all([workerDb.poolConnect, backendDb.poolConnect])

    const fixture = await appPool.request().query(`
        INSERT dbo.teachers (name, email_hash, password_hash)
        VALUES (N'Marking Lease Test', REPLICATE(N'b', 64), N'dummy');
        DECLARE @teacher INT = SCOPE_IDENTITY();
        INSERT dbo.classes (class_name, year_group_id, teacher_id)
        VALUES (N'Marking Lease Test', 7, @teacher);
        DECLARE @class INT = SCOPE_IDENTITY();
        INSERT dbo.lessons (lesson_title, class_id, mark_scheme_file_name,
                            mark_scheme_mime_type)
        VALUES (N'Marking Lease Test', @class, N'scheme.pdf', N'application/pdf');
        SELECT @teacher AS teacher_id, CAST(SCOPE_IDENTITY() AS INT) AS lesson_id,
               @class AS class_id;
    `)
    const { teacher_id: teacherId, lesson_id: lessonId, class_id: classId } = fixture.recordset[0]
    const students = []
    assert.equal(MARKING_MAX_CONCURRENT, 5)
    const batchSize = 6
    for (let n = 1; n <= (MARKING_OCR_BATCH_CONCURRENCY + 1) * batchSize; n++) {
        const row = await appPool.request().input('classId', sql.Int, classId)
            .input('name', sql.NVarChar(100), `Student ${n}`)
            .query(`INSERT dbo.students (student_name, class_id)
                    OUTPUT INSERTED.id VALUES (@name, @classId)`)
        students.push(row.recordset[0].id)
    }
    const jobs = []
    for (const studentId of students) {
        const jobId = (await backendDb.markingJobDb.createQueued(
            teacherId, lessonId, studentId
        )).job_id
        await backendDb.markingJobDb.markPublished(jobId)
        jobs.push(jobId)
    }

    const batches = []
    const claimedIds = new Set()
    for (let index = 0; index < MARKING_OCR_BATCH_CONCURRENCY; index++) {
        const leader = jobs.findIndex(jobId => !claimedIds.has(jobId.toLowerCase()))
        const attemptId = randomUUID()
        const batch = await workerDb.markingJobDb.claimBatch({
            jobId: jobs[leader], teacherId, lessonId, studentId: students[leader],
        }, 'batch-worker', attemptId, batchSize)
        assert.equal(batch.length, batchSize)
        assert.equal(batch[0].jobId.toLowerCase(), jobs[leader].toLowerCase())
        assert.equal(new Set(batch.map(row => row.studentId)).size, batchSize)
        for (const member of batch) claimedIds.add(member.jobId.toLowerCase())
        batches.push({ batch, attemptId })
    }
    const sixthLeader = jobs.findIndex(jobId => !claimedIds.has(jobId.toLowerCase()))
    const sixthJob = {
        jobId: jobs[sixthLeader], teacherId, lessonId, studentId: students[sixthLeader],
    }
    assert.deepEqual(await workerDb.markingJobDb.claimBatch(
        sixthJob, 'batch-worker', randomUUID(), batchSize
    ), { capacityBusy: true })

    // Once OCR finishes, the first batch moves into the marking stage and
    // another OCR batch can start while its six markings are still active.
    for (const member of batches[0].batch) {
        await workerDb.markingJobDb.markMarking(member.jobId, batches[0].attemptId,
            teacherId, lessonId, member.studentId)
    }
    const sixthAttempt = randomUUID()
    const sixthBatch = await workerDb.markingJobDb.claimBatch(
        sixthJob, 'batch-worker', sixthAttempt, batchSize
    )
    assert.equal(sixthBatch.length, batchSize)
    batches.push({ batch: sixthBatch, attemptId: sixthAttempt })

    for (const [index, { batch, attemptId }] of batches.entries()) {
        for (const member of batch) {
            if (index !== 0) {
                await workerDb.markingJobDb.markMarking(member.jobId, attemptId,
                    teacherId, lessonId, member.studentId)
            }
            await workerDb.markingDb.markStudent(member.jobId, attemptId,
                teacherId, member.studentId, lessonId, 'batch.jpg', 'image/jpeg',
                `OCR for ${member.studentId}`, '{}', null)
            assert.equal((await workerDb.markingJobDb.getProcessingState(member.jobId)).status,
                'complete')
        }
    }

    // An empty OCR page leaves its peers complete and takes the next batch's
    // first available companion place. Each OCR try has its own durable ID.
    const retryJobs = []
    for (let index = 0; index < batchSize; index++) {
        const jobId = (await backendDb.markingJobDb.createQueued(
            teacherId, lessonId, students[index]
        )).job_id
        await backendDb.markingJobDb.markPublished(jobId)
        retryJobs.push(jobId)
    }
    const firstOcrAttempt = randomUUID()
    const firstOcrBatch = await workerDb.markingJobDb.claimBatch({
        jobId: retryJobs[0], teacherId, lessonId, studentId: students[0],
    }, 'batch-worker', firstOcrAttempt, batchSize)
    const firstTryId = firstOcrBatch[0].tryId
    assert.equal(await workerDb.markingJobDb.markOcrEmpty(
        retryJobs[0], firstOcrAttempt
    ), 'queued')
    for (const member of firstOcrBatch.slice(1)) {
        await workerDb.markingJobDb.markMarking(member.jobId, firstOcrAttempt,
            teacherId, lessonId, member.studentId)
        await workerDb.markingDb.markStudent(member.jobId, firstOcrAttempt,
            teacherId, member.studentId, lessonId, 'batch.jpg', 'image/jpeg',
            'usable OCR', '{}', null)
    }
    const retryState = await appPool.request()
        .input('id', sql.UniqueIdentifier, retryJobs[0])
        .query('SELECT status, ocr_retry_pending, ocr_try_count FROM dbo.marking_jobs WHERE job_id = @id')
    assert.equal(retryState.recordset[0].status, 'queued')
    assert.equal(retryState.recordset[0].ocr_retry_pending, true)
    assert.equal(retryState.recordset[0].ocr_try_count, 1)

    const normalJobs = []
    for (let index = 0; index < batchSize; index++) {
        const jobId = (await backendDb.markingJobDb.createQueued(
            teacherId, lessonId, students[index + batchSize]
        )).job_id
        await backendDb.markingJobDb.markPublished(jobId)
        normalJobs.push(jobId)
    }
    const secondOcrAttempt = randomUUID()
    const priorityBatch = await workerDb.markingJobDb.claimBatch({
        jobId: normalJobs[0], teacherId, lessonId,
        studentId: students[batchSize],
    }, 'batch-worker', secondOcrAttempt, batchSize)
    assert.equal(priorityBatch.length, batchSize)
    assert.ok(priorityBatch.some(member => member.jobId.toLowerCase() ===
        retryJobs[0].toLowerCase()))
    assert.notEqual(priorityBatch.find(member => member.jobId.toLowerCase() ===
        retryJobs[0].toLowerCase()).tryId, firstTryId)
    assert.equal(await workerDb.markingJobDb.markOcrEmpty(
        retryJobs[0], secondOcrAttempt
    ), 'queued')
    for (const member of priorityBatch.filter(member =>
        member.jobId.toLowerCase() !== retryJobs[0].toLowerCase())) {
        await workerDb.markingJobDb.markMarking(member.jobId, secondOcrAttempt,
            teacherId, lessonId, member.studentId)
        await workerDb.markingDb.markStudent(member.jobId, secondOcrAttempt,
            teacherId, member.studentId, lessonId, 'batch.jpg', 'image/jpeg',
            'usable OCR', '{}', null)
    }
    const remainingNormal = normalJobs.find(id => !priorityBatch.some(
        member => member.jobId.toLowerCase() === id.toLowerCase()
    ))
    const remainingAttempt = randomUUID()
    const remainingBatch = await workerDb.markingJobDb.claimBatch({
        jobId: remainingNormal, teacherId, lessonId,
        studentId: students[batchSize + normalJobs.indexOf(remainingNormal)],
    }, 'batch-worker', remainingAttempt, 1)
    await workerDb.markingJobDb.markMarking(remainingBatch[0].jobId,
        remainingAttempt, teacherId, lessonId, remainingBatch[0].studentId)
    await workerDb.markingDb.markStudent(remainingBatch[0].jobId, remainingAttempt,
        teacherId, remainingBatch[0].studentId, lessonId,
        'batch.jpg', 'image/jpeg', 'usable OCR', '{}', null)

    const finalOcrAttempt = randomUUID()
    const soloRetry = await workerDb.markingJobDb.claimBatch({
        jobId: retryJobs[0], teacherId, lessonId, studentId: students[0], retry: true,
    }, 'batch-worker', finalOcrAttempt, batchSize)
    assert.equal(soloRetry.length, 1)
    assert.equal(await workerDb.markingJobDb.markOcrEmpty(
        retryJobs[0], finalOcrAttempt
    ), 'failed')
    const tries = (await appPool.request()
        .input('id', sql.UniqueIdentifier, retryJobs[0])
        .query('SELECT try_id, try_number, outcome FROM dbo.marking_ocr_tries WHERE job_id = @id ORDER BY try_number'))
        .recordset
    assert.equal(tries.length, 3)
    assert.deepEqual(tries.map(row => row.outcome), ['empty', 'empty', 'empty'])

    // The bulk insert is visible as one queued set. Each claim recalculates
    // the size from remaining jobs and free OCR slots, so partial batches run.
    for (const [count, expected] of [
        [1, [1]],
        [5, [1, 1, 1, 1, 1]],
        [6, [2, 1, 1, 1, 1]],
        [9, [2, 2, 2, 2, 1]],
        [10, [2, 2, 2, 2, 2]],
        [30, [6, 6, 6, 6, 6]],
    ]) {
        const rows = await backendDb.markingJobDb.createQueuedBulk(
            teacherId, lessonId, students.slice(0, count)
        )
        assert.equal(rows.length, count)
        const claimed = new Set()
        const groups = []
        for (const size of expected) {
            const leader = rows.find(row => !claimed.has(row.job_id.toLowerCase()))
            const attemptId = randomUUID()
            const batch = await workerDb.markingJobDb.claimBatch({
                jobId: leader.job_id, teacherId, lessonId,
                studentId: leader.student_id,
            }, 'dynamic-batch-worker', attemptId, batchSize, true)
            assert.equal(batch.length, size, `batch size for ${count} students`)
            for (const member of batch) {
                assert.ok(!claimed.has(member.jobId.toLowerCase()))
                claimed.add(member.jobId.toLowerCase())
            }
            groups.push({ batch, attemptId })
        }
        assert.equal(claimed.size, count)
        for (const { batch, attemptId } of groups) {
            for (const member of batch) {
                await workerDb.markingJobDb.markMarking(member.jobId, attemptId,
                    teacherId, lessonId, member.studentId)
                await workerDb.markingDb.markStudent(member.jobId, attemptId,
                    teacherId, member.studentId, lessonId, 'batch.jpg', 'image/jpeg',
                    'usable OCR', '{}', null)
            }
        }
    }

    const retryCandidate = (await backendDb.markingJobDb.createQueuedBulk(
        teacherId, lessonId, [students[0]]
    ))[0]
    const retryAttempt = randomUUID()
    const initialRetryBatch = await workerDb.markingJobDb.claimBatch({
        jobId: retryCandidate.job_id, teacherId, lessonId,
        studentId: students[0],
    }, 'dynamic-batch-worker', retryAttempt, batchSize, true)
    assert.equal(initialRetryBatch.length, 1)
    assert.equal(await workerDb.markingJobDb.markOcrEmpty(
        retryCandidate.job_id, retryAttempt
    ), 'queued')
    const freshRows = await backendDb.markingJobDb.createQueuedBulk(
        teacherId, lessonId, students.slice(1, 6)
    )
    const priorityAttempt = randomUUID()
    const firstDynamicBatch = await workerDb.markingJobDb.claimBatch({
        jobId: freshRows[0].job_id, teacherId, lessonId,
        studentId: freshRows[0].student_id,
    }, 'dynamic-batch-worker', priorityAttempt, batchSize, true)
    assert.equal(firstDynamicBatch.length, 2)
    assert.ok(firstDynamicBatch.some(member =>
        member.jobId.toLowerCase() === retryCandidate.job_id.toLowerCase()))
    for (const member of firstDynamicBatch) {
        await workerDb.markingJobDb.markMarking(member.jobId, priorityAttempt,
            teacherId, lessonId, member.studentId)
        await workerDb.markingDb.markStudent(member.jobId, priorityAttempt,
            teacherId, member.studentId, lessonId, 'batch.jpg', 'image/jpeg',
            'usable OCR', '{}', null)
    }
    for (const row of freshRows.slice(1)) {
        const attemptId = randomUUID()
        const batch = await workerDb.markingJobDb.claimBatch({
            jobId: row.job_id, teacherId, lessonId, studentId: row.student_id,
        }, 'dynamic-batch-worker', attemptId, batchSize, true)
        assert.equal(batch.length, 1)
        await workerDb.markingJobDb.markMarking(row.job_id, attemptId,
            teacherId, lessonId, row.student_id)
        await workerDb.markingDb.markStudent(row.job_id, attemptId,
            teacherId, row.student_id, lessonId, 'batch.jpg', 'image/jpeg',
            'usable OCR', '{}', null)
    }

    const validationRows = await backendDb.markingJobDb.createQueuedBulk(
        teacherId, lessonId, students.slice(0, 2)
    )
    const validationAttempt = randomUUID()
    const validationBatch = await workerDb.markingJobDb.claimBatch({
        jobId: validationRows[0].job_id, teacherId, lessonId,
        studentId: validationRows[0].student_id,
    }, 'validation-worker', validationAttempt, 2)
    assert.equal(validationBatch.length, 2)
    await workerDb.markingJobDb.rejectInvalidFile(
        validationBatch[0].jobId, validationAttempt, 'Student file type is unsupported'
    )
    await workerDb.markingJobDb.markMarking(validationBatch[1].jobId,
        validationAttempt, teacherId, lessonId, validationBatch[1].studentId)
    await workerDb.markingDb.markStudent(validationBatch[1].jobId, validationAttempt,
        teacherId, validationBatch[1].studentId, lessonId,
        'good.jpg', 'image/jpeg', 'usable OCR', '{}', null)
    const validationStates = await appPool.request()
        .input('first', sql.UniqueIdentifier, validationBatch[0].jobId)
        .input('second', sql.UniqueIdentifier, validationBatch[1].jobId)
        .query(`SELECT job_id, status, error_message FROM dbo.marking_jobs
                WHERE job_id IN (@first, @second)`)
    const byJob = new Map(validationStates.recordset.map(row =>
        [String(row.job_id).toLowerCase(), row]))
    assert.equal(byJob.get(validationBatch[0].jobId.toLowerCase()).status, 'failed')
    assert.equal(byJob.get(validationBatch[1].jobId.toLowerCase()).status, 'complete')
    const invalidTry = await appPool.request()
        .input('id', sql.UniqueIdentifier, validationBatch[0].jobId)
        .query('SELECT outcome FROM dbo.marking_ocr_tries WHERE job_id = @id')
    assert.equal(invalidTry.recordset[0].outcome, 'invalid_file')

    for (let index = 0; index < jobs.length; index++) {
        jobs[index] = (await backendDb.markingJobDb.createQueued(
            teacherId, lessonId, students[index]
        )).job_id
    }
    await backendDb.markingJobDb.markPublished(jobs[5])
    const published = await appPool.request().input('id', sql.UniqueIdentifier, jobs[5])
        .query('SELECT recovery_due_at FROM dbo.marking_jobs WHERE job_id = @id')
    assert.equal(published.recordset[0].recovery_due_at, null)
    const claim = (index, attemptId = randomUUID()) =>
        workerDb.markingJobDb.claimProcessing(jobs[index], 'worker-a', attemptId,
            teacherId, lessonId, students[index])

    const attempts = Array.from({ length: MARKING_MAX_CONCURRENT }, () => randomUUID())
    const firstFive = await Promise.all(attempts.map((attemptId, n) => claim(n, attemptId)))
    assert.ok(firstFive.every(Boolean))
    assert.equal(await claim(5), null) // sixth cannot pass the global SQL gate
    assert.equal(await claim(0), null) // same job cannot be claimed twice

    const deadlineBefore = firstFive[0].attempt_deadline_at.getTime()
    assert.equal(await workerDb.markingJobDb.heartbeat(jobs[0], attempts[0]), true)
    const deadlineAfter = (await appPool.request()
        .input('id', sql.UniqueIdentifier, jobs[0])
        .query('SELECT attempt_deadline_at FROM dbo.marking_jobs WHERE job_id = @id'))
        .recordset[0].attempt_deadline_at.getTime()
    assert.equal(deadlineAfter, deadlineBefore) // heartbeat never moves the deadline

    await workerDb.markingJobDb.markMarking(jobs[0], attempts[0],
        teacherId, lessonId, students[0])
    await appPool.request().input('id', sql.UniqueIdentifier, jobs[0]).query(`
        UPDATE dbo.marking_jobs SET attempt_deadline_at = DATEADD(SECOND, -1, SYSUTCDATETIME())
        WHERE job_id = @id`)
    await assert.rejects(() => workerDb.markingDb.markStudent(
        jobs[0], attempts[0], teacherId, students[0], lessonId,
        'student.jpg', 'image/jpeg', 'text', '{}', null
    ), /no longer owns job/)
    await backendDb.markingJobDb.recoverExpiredAttempts()
    assert.equal((await workerDb.markingJobDb.getProcessingState(jobs[0])).status, 'queued')
    assert.equal(await workerDb.markingJobDb.heartbeat(jobs[0], attempts[0]), false)

    const nextAttempt = randomUUID()
    assert.equal((await claim(0, nextAttempt)).attempt_count, 2)
    assert.equal(await workerDb.markingJobDb.finishAttemptWithError(jobs[0], attempts[0]), undefined)
    await workerDb.markingJobDb.markMarking(jobs[0], nextAttempt,
        teacherId, lessonId, students[0])
    await workerDb.markingDb.markStudent(jobs[0], nextAttempt,
        teacherId, students[0], lessonId, 'student.jpg', 'image/jpeg',
        'text', '{}', null)
    assert.equal((await workerDb.markingJobDb.getProcessingState(jobs[0])).status, 'complete')
    assert.equal(await workerDb.markingJobDb.heartbeat(jobs[0], nextAttempt), false)
    assert.ok(await claim(5))

    // After three business attempts, SQL exposes a final failure and will not
    // claim the job even if another broker delivery arrives.
    await workerDb.markingJobDb.finishAttemptWithError(jobs[1], attempts[1])
    await backendDb.markingJobDb.markPublished(jobs[1], 0)
    const retryDue = await appPool.request().input('id', sql.UniqueIdentifier, jobs[1])
        .query('SELECT recovery_due_at FROM dbo.marking_jobs WHERE job_id = @id')
    assert.ok(retryDue.recordset[0].recovery_due_at)
    for (let number = 2; number <= 3; number++) {
        const attemptId = randomUUID()
        assert.equal((await claim(1, attemptId)).attempt_count, number)
        assert.equal(await workerDb.markingJobDb.finishAttemptWithError(jobs[1], attemptId),
            number === 3 ? 'failed' : 'queued')
    }
    assert.equal(await claim(1), null)
    assert.equal((await workerDb.markingJobDb.getProcessingState(jobs[1])).status, 'failed')
    await appPool.request().input('id', sql.UniqueIdentifier, jobs[2]).query(`
        UPDATE dbo.marking_jobs SET lease_expires_at = DATEADD(SECOND, -1, SYSUTCDATETIME())
        WHERE job_id = @id`)
    await backendDb.markingJobDb.recoverExpiredAttempts()
    const recovery = await backendDb.markingJobDb.reserveRecoveryJobs()
    assert.ok(recovery.some(row => row.job_id.toLowerCase() === jobs[2].toLowerCase()))

    console.log('Student marking batch claim, global slots, lease, deadline, fencing, recovery, and retries passed.')
} finally {
    if (workerPool) await workerPool.close()
    if (backendPool) await backendPool.close()
    if (appPool) await appPool.close()
    await master.request().batch(`
        IF DB_ID(N'${database}') IS NOT NULL
        BEGIN
            ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
            DROP DATABASE [${database}];
        END`)
    await master.close()
}
