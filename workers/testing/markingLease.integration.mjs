// Run against local SQL only, with backend/.env (includes backend config keys).
// Creates and drops an isolated database; never changes SQL_DATABASE.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import { MARKING_MAX_CONCURRENT } from '../config/markingProcessing.js'

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
    for (let n = 1; n <= MARKING_MAX_CONCURRENT + 1; n++) {
        const row = await appPool.request().input('classId', sql.Int, classId)
            .input('name', sql.NVarChar(100), `Student ${n}`)
            .query(`INSERT dbo.students (student_name, class_id)
                    OUTPUT INSERTED.id VALUES (@name, @classId)`)
        students.push(row.recordset[0].id)
    }
    const jobs = []
    for (const studentId of students) {
        jobs.push((await backendDb.markingJobDb.createQueued(teacherId, lessonId, studentId)).job_id)
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

    console.log('Student marking global slots, lease, deadline, fencing, recovery, and retries passed.')
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
