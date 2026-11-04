import { randomUUID } from 'node:crypto'
import serviceBusClient from './index.js'
import { lessonDb, markingDb, markingJobDb } from './SQL/index.js'
import { findStudentUpload, downloadStudentWork } from './blob/index.js'
import {
    getMarkFromAIWithSchemeText,
    getMarkFromOcrText,
    getStudentOcrPdf,
} from './services/aiService.js'
import {
    checkStudentFile, checkUploadedSize, StudentFileValidationError,
} from './security/fileSecurity.js'
import { validateStudentFile } from './security/validateFile.js'
import { buildOcrPdfChunks, mapOcrPagesToJobs } from './utils/pdfBatch.js'
import { sanitizeAIResult } from './utils/sanitize.js'
import { createSemaphore } from './utils/semaphore.js'
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
    MARKING_OCR_BATCH_SIZE,
    MARKING_OCR_BATCH_CONCURRENCY,
    MARKING_BATCH_TIMEOUT_MS,
    MARKING_MODEL_CONCURRENCY,
} from './config/markingProcessing.js'

const QUEUE_NAME = 'student-marking'
const OCR_RETRY_QUEUE_NAME = 'student-ocr-retry'
const OCR_RETRY_LOCAL = MARKING_OCR_BATCH_SIZE > 1 &&
    Boolean(process.env.AZURE_SERVICEBUS_CONNECTION_STRING) &&
    Boolean(process.env.SQL_USER && process.env.SQL_PASSWORD) &&
    ['localhost', '127.0.0.1'].includes(process.env.SQL_SERVER)
const WORKER_ID = randomUUID()
const modelLimiter = createSemaphore(MARKING_MODEL_CONCURRENCY)

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

    checkUploadedSize(upload.size)
    const fileBuffer = await downloadStudentWork(upload.blobName, signal)
    logBlobRetrieved(job, upload.fileName, fileBuffer.length)
    throwIfAborted(signal)

    const file = await validateStudentFile(await checkStudentFile({
        buffer: fileBuffer,
        originalname: upload.fileName,
        mimetype: upload.mimeType,
    }))

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

    await saveMarkingResult(job, attemptId, file, aiResult)
}

async function saveMarkingResult(job, attemptId, file, aiResult) {
    const { jobId, teacherId, lessonId, studentId } = job
    const sanitized = sanitizeAIResult(aiResult)
    const { aggregation, finalResult, ...holisticGrade } = sanitized

    await markingDb.markStudent(
        jobId,
        attemptId,
        teacherId,
        studentId,
        lessonId,
        file.sourceName ?? file.originalname,
        file.mimetype,
        aiResult.student_ocr_text ?? '',
        JSON.stringify(holisticGrade),
        aggregation ? JSON.stringify(aggregation) : null,
        finalResult ? JSON.stringify(finalResult) : null
    )
    logMarkStored(job)
}

async function runBatchWork(batch, attemptId, deadlineAt, signal, pending) {
    const { teacherId, lessonId } = batch[0]
    const ocrRow = await lessonDb.getOcrText(lessonId, teacherId)
    if (!ocrRow) throw new Error('Stored mark scheme not found for marking batch')
    const scheme = resolveScheme(ocrRow)
    const threadExtraction = resolveThreadExtraction(ocrRow)

    const prepared = await Promise.all(batch.map(async job => {
        try {
            throwIfAborted(signal)
            const upload = await findStudentUpload(job.teacherId, job.lessonId, job.studentId)
            if (!upload) throw new Error(`No uploaded work found for job ${job.jobId}`)
            checkUploadedSize(upload.size)
            const buffer = await downloadStudentWork(upload.blobName, signal)
            logBlobRetrieved(job, upload.fileName, buffer.length)
            const file = await validateStudentFile(await checkStudentFile({
                buffer, originalname: upload.fileName, mimetype: upload.mimeType,
            }))
            return { job, file }
        } catch (err) {
            if (!(err instanceof StudentFileValidationError)) throw err
            await markingJobDb.rejectInvalidFile(job.jobId, attemptId, err.message)
            pending.delete(job.jobId)
            logInfo(`Rejected invalid student file for job ${job.jobId}: ${err.message}`)
            return null
        }
    }))
    const entries = prepared.filter(Boolean)
    throwIfAborted(signal)
    if (!entries.length) return { marked: 0, empty: 0, invalid: batch.length }

    const chunks = await buildOcrPdfChunks(entries)
    const textByPage = new Map()
    const emptyPages = new Set()
    const ocrStarted = Date.now()
    for (const chunk of chunks) {
        let response
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                response = await getStudentOcrPdf(chunk, { signal, deadlineAt })
                if (response?.page_count !== chunk.pages.length) {
                    throw new Error(`Batch OCR returned ${response?.page_count ?? 'no'} pages for ${chunk.pages.length} PDF pages`)
                }
                break
            } catch (err) {
                if (attempt === 2 || signal.aborted ||
                    !/returned HTTP 5\d\d|AI service request failed/.test(err.message)) throw err
                logInfo(`Batch OCR attempt ${attempt} failed; retrying once: ${err.message}`)
                await new Promise(resolve => setTimeout(resolve, 1000))
            }
        }
        const students = response?.students
        const emptyKeys = response?.empty_slot_keys ?? []
        if (!Array.isArray(students) || !Array.isArray(emptyKeys) ||
            students.length + emptyKeys.length !== chunk.pages.length) {
            throw new Error('Batch OCR did not account for every PDF page')
        }
        const expected = new Set(chunk.pages.map(page => page.key))
        for (const row of students) {
            if (typeof row?.slot_key !== 'string' ||
                typeof row.handwritten_work !== 'string' ||
                !row.handwritten_work.trim() || textByPage.has(row.slot_key) ||
                !expected.has(row.slot_key)) {
                throw new Error('Batch OCR returned an invalid page mapping')
            }
            textByPage.set(row.slot_key, row.handwritten_work)
        }
        for (const key of emptyKeys) {
            if (typeof key !== 'string' || !expected.has(key) ||
                textByPage.has(key) || emptyPages.has(key)) {
                throw new Error('Batch OCR returned an invalid empty page mapping')
            }
            emptyPages.add(key)
        }
        if (chunk.pages.some(page => !textByPage.has(page.key) && !emptyPages.has(page.key))) {
            throw new Error('Batch OCR omitted a PDF page')
        }
    }
    const { textByJob, emptyByJob } = mapOcrPagesToJobs(entries, textByPage)
    if (!OCR_RETRY_LOCAL && emptyByJob.size) {
        throw new Error('Batch OCR returned empty student text')
    }
    logInfo(`Batch OCR complete: ${chunks.length} requests, ${textByJob.size} student texts, ${emptyByJob.size} empty files in ${Date.now() - ocrStarted} ms`)
    throwIfAborted(signal)

    for (const { job } of entries.filter(({ job }) => emptyByJob.has(job.jobId))) {
        const status = await markingJobDb.markOcrEmpty(job.jobId, attemptId)
        pending.delete(job.jobId)
        logInfo(`Empty OCR for job ${job.jobId}, try ${job.tryId}: ${status === 'queued'
            ? 'queued for priority OCR retry' : 'failed after maximum tries'}`)
    }

    const validEntries = entries.filter(({ job }) => textByJob.has(job.jobId))
    await Promise.all(validEntries.map(({ job }) => markingJobDb.markMarking(
        job.jobId, attemptId, job.teacherId, job.lessonId, job.studentId
    )))

    let cursor = 0
    const failures = []
    async function markNext() {
        while (cursor < validEntries.length) {
            const { job, file } = validEntries[cursor++]
            try {
                throwIfAborted(signal)
                const result = await modelLimiter.run(async () => {
                    throwIfAborted(signal)
                    logInfo(`Downstream model calls in flight: ${modelLimiter.active}/${MARKING_MODEL_CONCURRENCY}`)
                    logMarkAiDispatched(job)
                    const started = Date.now()
                    const marked = await getMarkFromOcrText(
                        textByJob.get(job.jobId), scheme, threadExtraction,
                        { signal, deadlineAt }
                    )
                    logMarkAiReturned(job, Date.now() - started)
                    return marked
                }, signal)
                throwIfAborted(signal)
                await saveMarkingResult(job, attemptId, file, result)
                pending.delete(job.jobId)
            } catch (err) {
                failures.push({ job, err })
                logMarkFailed(job, err)
            }
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(MARKING_MODEL_CONCURRENCY, validEntries.length) },
        () => markNext()
    ))
    if (failures.length) {
        throw new Error(`${failures.length} of ${batch.length} batch markings failed`)
    }
    return { marked: validEntries.length, empty: emptyByJob.size,
        invalid: batch.length - entries.length }
}

async function runOwnedBatch(batch, attemptId) {
    const controller = new AbortController()
    const pending = new Set(batch.map(job => job.jobId))
    const deadlineAt = batch[0].deadlineAt
    const remainingMs = Math.max(0, new Date(deadlineAt).getTime() - Date.now())
    const deadlineTimer = setTimeout(() => {
        controller.abort(new Error('Student marking batch timed out'))
    }, Math.min(remainingMs, MARKING_BATCH_TIMEOUT_MS))

    let stopped = false
    let heartbeatTimer
    const heartbeat = async () => {
        if (stopped || controller.signal.aborted) return
        try {
            const current = batch.filter(job => pending.has(job.jobId))
            const renewed = await Promise.all(current.map(job =>
                markingJobDb.heartbeat(job.jobId, attemptId)
            ))
            const notRenewed = current.filter((_, index) => !renewed[index])
            const states = await Promise.all(notRenewed.map(job =>
                markingJobDb.getProcessingState(job.jobId)
            ))
            if (states.some(state => state?.status !== 'complete')) {
                controller.abort(new Error('Student marking batch lost ownership'))
            }
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
        return await runBatchWork(batch, attemptId, deadlineAt, controller.signal, pending)
    } finally {
        stopped = true
        clearTimeout(deadlineTimer)
        clearTimeout(heartbeatTimer)
    }
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

async function handleBatchMessage(receiver, message, retry = false) {
    const job = { ...message.body, retry }
    if (typeof job?.jobId !== 'string' ||
        ![job.teacherId, job.lessonId, job.studentId].every(Number.isSafeInteger)) {
        logInfo('Student marking batch message has invalid identifiers; settling it')
        await settle(receiver, message, 'completeMessage')
        return
    }

    const attemptId = randomUUID()
    const capacityDeadline = Date.now() + MARKING_BATCH_TIMEOUT_MS
    let batch = null
    while (!batch) {
        try {
            const claimed = await markingJobDb.claimBatch(
                job, WORKER_ID, attemptId, MARKING_OCR_BATCH_SIZE, true
            )
            if (claimed?.capacityBusy) {
                const state = await markingJobDb.getProcessingState(job.jobId)
                if (state?.status !== 'queued' || state.attempt_count >= MARKING_MAX_ATTEMPTS ||
                    Boolean(state.ocr_retry_pending) !== retry) {
                    await settle(receiver, message, 'completeMessage')
                    return
                }
                if (Date.now() >= capacityDeadline) {
                    await markingJobDb.scheduleRecovery(job.jobId)
                    await settle(receiver, message, 'completeMessage')
                    return
                }
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }
            batch = claimed
            if (batch) break
            const state = await markingJobDb.getProcessingState(job.jobId)
            if (state?.status !== 'queued' || state.attempt_count >= MARKING_MAX_ATTEMPTS ||
                Boolean(state.ocr_retry_pending) !== retry) {
                await settle(receiver, message, 'completeMessage')
                return
            }
            // A queued leader with eligible work should always form at least
            // a one-page batch. Let recovery republish unexpected races.
            await markingJobDb.scheduleRecovery(job.jobId)
            await settle(receiver, message, 'completeMessage')
            return
        } catch (err) {
            logMarkFailed(job, err)
            await settle(receiver, message, 'abandonMessage')
            return
        }
    }

    logInfo(`Claimed OCR batch of ${batch.length} students for teacher ${job.teacherId}, lesson ${job.lessonId}`)
    try {
        const result = await runOwnedBatch(batch, attemptId)
        logInfo(`Batch stored ${result.marked} results; ${result.empty} empty OCR jobs and ${result.invalid} invalid files isolated`)
        await settle(receiver, message, 'completeMessage')
    } catch (err) {
        logMarkFailed(job, err)
        // Keep other in-flight batches running. The existing recovery scan
        // republishes unfinished student jobs for another batch attempt.
        for (const member of batch) {
            try { await markingJobDb.finishAttemptWithError(member.jobId, attemptId) }
            catch (finishErr) { logMarkFailed(member, finishErr) }
        }
        await settle(receiver, message, 'completeMessage')
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
            let status
            if (err instanceof StudentFileValidationError) {
                await markingJobDb.rejectInvalidFile(job.jobId, attemptId, err.message)
                status = 'failed'
            } else {
                status = await markingJobDb.finishAttemptWithError(job.jobId, attemptId)
            }
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
        maxAutoLockRenewalDurationInMs: MARKING_OCR_BATCH_SIZE > 1
            ? MARKING_BATCH_TIMEOUT_MS + 5 * 60 * 1000
            : MARKING_LOCK_RENEWAL_MS,
    })

    receiver.subscribe({
        processMessage: message => MARKING_OCR_BATCH_SIZE > 1
            ? handleBatchMessage(receiver, message)
            : handleMessage(receiver, message),
        processError: async (args) => {
            logInfo(`Error receiving from "${QUEUE_NAME}": ${args.error.message}`)
        },
    }, { autoCompleteMessages: false,
        maxConcurrentCalls: MARKING_OCR_BATCH_SIZE > 1
            ? MARKING_OCR_BATCH_CONCURRENCY + MARKING_MODEL_CONCURRENCY
            : MARKING_MAX_CONCURRENT })

    logInfo(`Subscribed to "${QUEUE_NAME}" — batch size ${MARKING_OCR_BATCH_SIZE}, OCR batch concurrency ${MARKING_OCR_BATCH_CONCURRENCY}, global model concurrency ${MARKING_MODEL_CONCURRENCY}.`)

    if (OCR_RETRY_LOCAL) {
        const retryReceiver = serviceBusClient.createReceiver(OCR_RETRY_QUEUE_NAME, {
            maxAutoLockRenewalDurationInMs: MARKING_BATCH_TIMEOUT_MS + 5 * 60 * 1000,
        })
        retryReceiver.subscribe({
            processMessage: message => handleBatchMessage(retryReceiver, message, true),
            processError: async (args) => {
                logInfo(`Error receiving from "${OCR_RETRY_QUEUE_NAME}": ${args.error.message}`)
            },
        }, { autoCompleteMessages: false,
            maxConcurrentCalls: MARKING_OCR_BATCH_CONCURRENCY })
        logInfo(`Subscribed to local OCR retry queue "${OCR_RETRY_QUEUE_NAME}".`)
    }

    return receiver
}
