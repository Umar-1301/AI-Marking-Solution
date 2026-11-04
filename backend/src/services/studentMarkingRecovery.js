import { markingJobDb } from '../db/index.js'
import {
    sendStudentMarkingRequest,
    sendStudentOcrRetryRequest,
} from './queueService.js'
import { STUDENT_MARKING_RECOVERY_SCAN_MS } from '../config/studentMarkingProcessing.js'

let running = false

async function scan() {
    if (running) return
    running = true
    try {
        await markingJobDb.recoverExpiredAttempts()
        await markingJobDb.failExhaustedQueued()
        const jobs = await markingJobDb.reserveRecoveryJobs()
        for (const job of jobs) {
            try {
                const send = job.ocr_retry_pending
                    ? sendStudentOcrRetryRequest : sendStudentMarkingRequest
                await send({
                    jobId: job.job_id,
                    teacherId: job.teacher_id,
                    lessonId: job.lesson_id,
                    studentId: job.student_id,
                    attemptCount: job.attempt_count,
                })
                await markingJobDb.markPublished(job.job_id, job.attempt_count)
            } catch (err) {
                // The SQL reservation expires, so a later scan can resend.
                console.error(`Could not republish student marking job ${job.job_id}:`, err)
            }
        }
    } catch (err) {
        console.error('Student marking recovery scan failed:', err)
    } finally {
        running = false
    }
}

export function startStudentMarkingRecovery() {
    void scan()
    setInterval(scan, STUDENT_MARKING_RECOVERY_SCAN_MS).unref()
}
