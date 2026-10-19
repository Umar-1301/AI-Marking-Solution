import { randomUUID } from 'node:crypto'
import serviceBusClient from './index.js'
import { lessonDb, markingDb, markingJobDb } from './SQL/index.js'
import { findStudentUpload, downloadStudentWork } from './blob/index.js'
import { getMarkFromAIWithSchemeText } from './services/aiService.js'
import { sanitizeAIResult } from './utils/sanitize.js'
import {
    logInfo,
    logMarkStart,
    logBlobRetrieved,
    logMarkAiDispatched,
    logMarkAiReturned,
    logMarkStored,
    logMarkFailed,
} from './logging/workerLogger.js'
import {
    MARKING_HEARTBEAT_MS,
    MARKING_LOCK_RENEWAL_MS,
    MARKING_MAX_ATTEMPTS,
    MARKING_MAX_CONCURRENT,
    MARKING_TIMEOUT_MS,
} from './config/markingProcessing.js'

const QUEUE_NAME = 'student-marking'
const WORKER_ID = randomUUID()

function throwIfAborted(signal) {
    if (signal.aborted) throw signal.reason ?? new Error('Student marking attempt stopped')
}

function getSelectedQuestion(ocrRow) {
    if (!ocrRow.structured_scheme) return null

    let parsed
    try { parsed = JSON.parse(ocrRow.structured_scheme) } catch { return null }

    const questions = parsed.questions
    if (!Array.isArray(questions) || questions.length === 0) return null

    const index = ocrRow.selected_question_index ?? 0
    return questions[index] ?? questions[0]
}

function resolveScheme(ocrRow) {
    const question = getSelectedQuestion(ocrRow)
    return question ? JSON.stringify(question) : ocrRow.ocr_text
}

function resolveThreadExtraction(ocrRow) {
    if (!ocrRow.thread_extraction) return ''

    let extractedThreads
    try { extractedThreads = JSON.parse(ocrRow.thread_extraction) } catch { return '' }

    const questions = extractedThreads?.questions
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return ''

    const selectedQuestion = getSelectedQuestion(ocrRow)
    const selectedQuestionNumber = selectedQuestion?.question_number
    if (!selectedQuestionNumber) return ''

    const selectedThreadExtraction = questions[selectedQuestionNumber]
    return selectedThreadExtraction ? JSON.stringify(selectedThreadExtraction) : ''
}

export async function processMarkingRequest(job, attemptId, deadlineAt, signal) {
    const { jobId, teacherId, lessonId, studentId } = job ?? {}
    logMarkStart(job)
    throwIfAborted(signal)

    // This is the worker's sole SQL read: retrieve the already-authorised
    // lesson's stored mark scheme. Student/teacher validation remains in the
    // backend before the message is published.
    const ocrRow = await lessonDb.getOcrText(lessonId, teacherId)
    if (!ocrRow) throw new Error('Stored mark scheme not found')
    throwIfAborted(signal)

    const upload = await findStudentUpload(teacherId, lessonId, studentId)
    if (!upload) throw new Error('No uploaded work found for queued student')
    throwIfAborted(signal)

    const fileBuffer = await downloadStudentWork(upload.blobName, signal)
    logBlobRetrieved(job, upload.fileName, fileBuffer.length)
    throwIfAborted(signal)

    const file = {
        buffer: fileBuffer,
        originalname: upload.fileName,
        mimetype: upload.mimeType,
    }

    const scheme = resolveScheme(ocrRow)
    const threadExtraction = resolveThreadExtraction(ocrRow)

    await markingJobDb.markMarking(
        jobId,
        attemptId,
        teacherId,
        lessonId,
        studentId
    )

    logMarkAiDispatched(job)
    const aiStart = Date.now()
    const aiResult = await getMarkFromAIWithSchemeText(
        file,
        scheme,
        threadExtraction,
        { signal, deadlineAt, jobId, attemptId }
    )
    logMarkAiReturned(job, Date.now() - aiStart)
    throwIfAborted(signal)

    const sanitized = sanitizeAIResult(aiResult)
    const { aggregation, finalResult, ...holisticGrade } = sanitized

    await markingDb.markStudent(
        jobId,
        attemptId,
        teacherId,
        studentId,
        lessonId,
        file.originalname,
        file.mimetype,
        aiResult.student_ocr_text ?? '',
        JSON.stringify(holisticGrade),
        aggregation ? JSON.stringify(aggregation) : null,
        finalResult ? JSON.stringify(finalResult) : null
    )
    logMarkStored(job)
}

async function runOwnedAttempt(job, attemptId, deadlineAt) {
    const controller = new AbortController()
    const remainingMs = Math.max(0, new Date(deadlineAt).getTime() - Date.now())
    const deadlineTimer = setTimeout(() => {
        controller.abort(new Error('Student marking exceeded five minutes'))
    }, Math.min(remainingMs, MARKING_TIMEOUT_MS))

    let stopped = false
    let heartbeatTimer
    const heartbeat = async () => {
        if (stopped || controller.signal.aborted) return
        try {
            const renewed = await markingJobDb.heartbeat(job.jobId, attemptId)
            if (!renewed) controller.abort(new Error('Student marking attempt lost ownership'))
        } catch (err) {
            controller.abort(err)
        } finally {
            if (!stopped && !controller.signal.aborted) {
                heartbeatTimer = setTimeout(heartbeat, MARKING_HEARTBEAT_MS)
            }
        }
    }
    heartbeatTimer = setTimeout(heartbeat, MARKING_HEARTBEAT_MS)

    try {
        await processMarkingRequest(job, attemptId, deadlineAt, controller.signal)
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
        logInfo(`Could not ${action} student marking job ${message.body?.jobId}: ${err.message}`)
    }
}

async function handleMessage(receiver, message) {
    const job = message.body
    if (typeof job?.jobId !== 'string' ||
        ![job.teacherId, job.lessonId, job.studentId].every(Number.isSafeInteger)) {
        logInfo('Student marking message has invalid identifiers; settling it')
        await settle(receiver, message, 'completeMessage')
        return
    }

    const attemptId = randomUUID()
    const queueWaitDeadline = Date.now() + 14 * 60 * 1000
    let claim
    while (!claim) {
        try {
            claim = await markingJobDb.claimProcessing(
                job.jobId, WORKER_ID, attemptId,
                job.teacherId, job.lessonId, job.studentId
            )
            if (claim) break

            const state = await markingJobDb.getProcessingState(job.jobId)
            if (state?.status === 'queued' && state.attempt_count < MARKING_MAX_ATTEMPTS) {
                if (Date.now() >= queueWaitDeadline) {
                    // Keep the durable job queued without burning a broker
                    // delivery just because all three SQL slots were busy.
                    await markingJobDb.scheduleRecovery(job.jobId)
                    await settle(receiver, message, 'completeMessage')
                    return
                }
                await new Promise(resolve => setTimeout(resolve, 5000))
            } else {
                // Complete duplicate delivery; the active SQL owner or the
                // backend recovery scan is responsible for the job.
                await settle(receiver, message, 'completeMessage')
                return
            }
        } catch (err) {
            logMarkFailed(job, err)
            await settle(receiver, message, 'abandonMessage')
            return
        }
    }

    logInfo(`Claimed student marking job ${job.jobId}, attempt ${attemptId}, number ${claim.attempt_count}`)
    try {
        await runOwnedAttempt(job, attemptId, claim.attempt_deadline_at)
    } catch (err) {
        logMarkFailed(job, err)
        try {
            const status = await markingJobDb.finishAttemptWithError(job.jobId, attemptId)
            await settle(receiver, message,
                status === 'queued' ? 'abandonMessage' : 'completeMessage')
        } catch (dbErr) {
            logMarkFailed(job, dbErr)
            await settle(receiver, message, 'abandonMessage')
        }
        return
    }

    // A lock-settlement error after SQL commit is not a failed marking job.
    await settle(receiver, message, 'completeMessage')
}

export function startMarkingWorker() {
    const receiver = serviceBusClient.createReceiver(QUEUE_NAME, {
        maxAutoLockRenewalDurationInMs: MARKING_LOCK_RENEWAL_MS,
    })

    receiver.subscribe({
        processMessage: message => handleMessage(receiver, message),
        processError: async (args) => {
            logInfo(`Error receiving from "${QUEUE_NAME}": ${args.error.message}`)
        },
    }, { autoCompleteMessages: false, maxConcurrentCalls: MARKING_MAX_CONCURRENT })

    logInfo(`Subscribed to "${QUEUE_NAME}" — listening for messages.`)

    return receiver
}
