import { randomUUID } from 'node:crypto'
import serviceBusClient, { MARK_SCHEME_QUEUE, sendMarkSchemeRequest } from './queueService.js'
import { markSchemeJobDb } from '../db/index.js'
import { downloadMarkScheme } from './markSchemeBlobService.js'
import { getOcrFromAI } from './aiService.js'
import { sanitiseOcrText } from '../middleware/inputSecurity.js'
import { traceMarkScheme } from '../logging/markSchemeTrace.js'
import {
    MARK_SCHEME_HEARTBEAT_MS,
    MARK_SCHEME_MAX_ATTEMPTS,
    MARK_SCHEME_MAX_CONCURRENT,
    MARK_SCHEME_RECOVERY_SCAN_MS,
    MARK_SCHEME_TIMEOUT_MS,
} from '../config/markSchemeProcessing.js'

// A process ID is useful for diagnostics; the fresh attempt ID fences writes
// even when this same process receives a later delivery for the same job.
const WORKER_ID = randomUUID()

function throwIfAborted(signal) {
    if (signal.aborted) throw signal.reason ?? new Error('Mark scheme attempt stopped')
}

export async function processMarkSchemeJob(jobId, attemptId, job, signal) {
    throwIfAborted(signal)
    traceMarkScheme('blob_download_started', { job_id: jobId, attempt_id: attemptId })
    const buffer = await downloadMarkScheme(job.blob_name, job.blob_etag, signal)
    traceMarkScheme('blob_download_complete', { job_id: jobId, attempt_id: attemptId,
        bytes: buffer.length })
    throwIfAborted(signal)
    const file = {
        buffer,
        originalname: job.file_name,
        mimetype: job.mime_type,
        size: buffer.length,
    }
    while (true) {
        throwIfAborted(signal)
        const admitted = await markSchemeJobDb.markOcr(jobId, attemptId)
        if (admitted === true) break
        if (admitted !== 'rate_limited') {
            throw new Error('Mark scheme attempt lost ownership before OCR')
        }
        await new Promise(resolve => setTimeout(resolve, 5000))
    }
    throwIfAborted(signal)
    traceMarkScheme('ai_request_started', { job_id: jobId, attempt_id: attemptId })
    const result = await getOcrFromAI(file, {
        signal,
        deadlineAt: job.attempt_deadline_at,
        jobId,
        attemptId,
    })
    traceMarkScheme('ai_response_received', { job_id: jobId, attempt_id: attemptId })
    throwIfAborted(signal)
    await markSchemeJobDb.completeWithLesson(jobId, attemptId, job, file, {
        text: sanitiseOcrText(result.text ?? ''),
        structured_scheme: result.structured_scheme ? JSON.stringify(result.structured_scheme) : '',
        thread_scheme: result.thread_scheme ? JSON.stringify(result.thread_scheme) : '',
    })
    traceMarkScheme('job_completed', { job_id: jobId, attempt_id: attemptId })
}

async function runOwnedAttempt(jobId, attemptId, job) {
    const controller = new AbortController()
    const remainingMs = Math.max(0, new Date(job.attempt_deadline_at).getTime() - Date.now())
    const deadlineTimer = setTimeout(() => {
        controller.abort(new Error('Mark scheme processing exceeded three minutes'))
    }, Math.min(remainingMs, MARK_SCHEME_TIMEOUT_MS))

    let stopped = false
    let heartbeatTimer
    const heartbeat = async () => {
        if (stopped || controller.signal.aborted) return
        try {
            const renewed = await markSchemeJobDb.heartbeat(jobId, attemptId)
            if (!renewed) controller.abort(new Error('Mark scheme attempt lost ownership or timed out'))
        } catch (err) {
            controller.abort(err)
        } finally {
            if (!stopped && !controller.signal.aborted) {
                heartbeatTimer = setTimeout(heartbeat, MARK_SCHEME_HEARTBEAT_MS)
            }
        }
    }
    heartbeatTimer = setTimeout(heartbeat, MARK_SCHEME_HEARTBEAT_MS)

    try {
        await processMarkSchemeJob(jobId, attemptId, job, controller.signal)
    } finally {
        stopped = true
        clearTimeout(deadlineTimer)
        clearTimeout(heartbeatTimer)
    }
}

async function settle(receiver, message, action) {
    try {
        await receiver[action](message)
    } catch (err) {
        // A lost Service Bus lock cannot undo a committed SQL result. The next
        // delivery consults SQL; the recovery scan covers an unfinished job.
        traceMarkScheme('message_settlement_failed', {
            job_id: message.body?.jobId ?? null, action,
            error_type: err?.name ?? 'Error',
        })
        console.error(`Could not ${action} mark scheme message ${message.body?.jobId}:`, err)
    }
}

async function handleMessage(receiver, message) {
    const jobId = message.body?.jobId
    if (typeof jobId !== 'string') {
        console.error('Mark scheme message has no job ID')
        await settle(receiver, message, 'completeMessage')
        return
    }

    const attemptId = randomUUID()
    const queueWaitDeadline = Date.now() + 14 * 60 * 1000
    let reportedQueueWait = false
    let job
    while (!job) {
        try {
            job = await markSchemeJobDb.claimProcessing(jobId, WORKER_ID, attemptId)
            if (job) {
                traceMarkScheme('attempt_claimed', { job_id: jobId, attempt_id: attemptId,
                    attempt_count: job.attempt_count })
                break
            }
            const state = await markSchemeJobDb.getProcessingState(jobId)
            if (state?.status === 'queued' && state.attempt_count < MARK_SCHEME_MAX_ATTEMPTS) {
                if (!reportedQueueWait) {
                    traceMarkScheme('waiting_for_slot', { job_id: jobId })
                    reportedQueueWait = true
                }
                if (Date.now() >= queueWaitDeadline) {
                    await settle(receiver, message, 'abandonMessage')
                    return
                }
                // All three global SQL slots may be occupied. Keep the broker
                // lock renewed while waiting rather than repeatedly abandoning
                // and consuming the message's delivery allowance.
                await new Promise(resolve => setTimeout(resolve, MARK_SCHEME_RECOVERY_SCAN_MS))
            } else {
                // An active attempt has its own heartbeat; SQL recovery will
                // send a new message if it dies. Do not occupy a handler slot.
                traceMarkScheme('delivery_not_claimed', { job_id: jobId,
                    current_status: state?.status ?? 'missing' })
                await settle(receiver, message, 'completeMessage')
                return
            }
        } catch (err) {
            traceMarkScheme('claim_failed', { job_id: jobId,
                error_type: err?.name ?? 'Error' })
            console.error(`Could not claim mark scheme job ${jobId}:`, err)
            await settle(receiver, message, 'abandonMessage')
            return
        }
    }

    try {
        await runOwnedAttempt(jobId, attemptId, job)
    } catch (err) {
        traceMarkScheme('attempt_failed', { job_id: jobId, attempt_id: attemptId,
            error_type: err?.name ?? 'Error', error: String(err?.message ?? err).slice(0, 200) })
        console.error(`Mark scheme job ${jobId} attempt ${attemptId} failed:`, err)
        try {
            const status = await markSchemeJobDb.finishAttemptWithError(
                jobId, attemptId, 'Mark scheme processing failed or timed out'
            )
            traceMarkScheme('attempt_settled', { job_id: jobId, attempt_id: attemptId,
                next_status: status })
            await settle(receiver, message, status === 'queued' ? 'abandonMessage' : 'completeMessage')
        } catch (dbErr) {
            traceMarkScheme('failure_record_failed', { job_id: jobId, attempt_id: attemptId,
                error_type: dbErr?.name ?? 'Error' })
            console.error(`Could not record mark scheme failure for ${jobId}:`, dbErr)
            await settle(receiver, message, 'abandonMessage')
        }
        return
    }

    // Keep settlement outside the processing try/catch: a lost broker lock is
    // not a failed OCR job once the lesson is committed in SQL.
    await settle(receiver, message, 'completeMessage')
}

let recoveryRunning = false
async function recoverMarkSchemeJobs() {
    if (recoveryRunning) return
    recoveryRunning = true
    try {
        await markSchemeJobDb.recoverExpiredAttempts()
        await markSchemeJobDb.failExhaustedQueued()
        const jobs = await markSchemeJobDb.reserveRecoveryJobs()
        for (const { job_id: jobId } of jobs) {
            try {
                await sendMarkSchemeRequest(jobId)
            } catch (err) {
                // The reservation expires after one minute, so the next scan
                // retries even if sending failed or this process crashed.
                traceMarkScheme('requeue_failed', { job_id: jobId,
                    error_type: err?.name ?? 'Error' })
                console.error(`Could not requeue mark scheme job ${jobId}:`, err)
            }
        }
    } catch (err) {
        console.error('Mark scheme recovery scan failed:', err)
    } finally {
        recoveryRunning = false
    }
}

export function startMarkSchemeConsumer() {
    const receiver = serviceBusClient.createReceiver(MARK_SCHEME_QUEUE, {
        maxAutoLockRenewalDurationInMs: 15 * 60 * 1000,
    })
    receiver.subscribe({
        processMessage: (message) => handleMessage(receiver, message),
        processError: async ({ error }) => {
            console.error(`Mark scheme queue error: ${error.message}`)
        },
    }, {
        autoCompleteMessages: false,
        maxConcurrentCalls: MARK_SCHEME_MAX_CONCURRENT,
    })

    void recoverMarkSchemeJobs()
    setInterval(recoverMarkSchemeJobs, MARK_SCHEME_RECOVERY_SCAN_MS).unref()
    return receiver
}
