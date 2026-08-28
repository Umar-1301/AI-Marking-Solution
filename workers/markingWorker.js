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

const QUEUE_NAME = 'student-marking'

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

export async function processMarkingRequest(job) {
    const { jobId, teacherId, lessonId, studentId } = job ?? {}
    logMarkStart(job)

    const shouldProcess = await markingJobDb.markProcessing(
        jobId,
        teacherId,
        lessonId,
        studentId
    )

    if (!shouldProcess) {
        logInfo(`Job ${jobId} is already complete; skipping duplicate delivery.`)
        return
    }

    // This is the worker's sole SQL read: retrieve the already-authorised
    // lesson's stored mark scheme. Student/teacher validation remains in the
    // backend before the message is published.
    const ocrRow = await lessonDb.getOcrText(lessonId, teacherId)
    if (!ocrRow) throw new Error('Stored mark scheme not found')

    const upload = await findStudentUpload(teacherId, lessonId, studentId)
    if (!upload) throw new Error('No uploaded work found for queued student')

    const fileBuffer = await downloadStudentWork(upload.blobName)
    logBlobRetrieved(job, upload.fileName, fileBuffer.length)

    const file = {
        buffer: fileBuffer,
        originalname: upload.fileName,
        mimetype: upload.mimeType,
    }

    const question = ocrRow.question ?? ''
    const scheme = resolveScheme(ocrRow)

    await markingJobDb.markMarking(
        jobId,
        teacherId,
        lessonId,
        studentId
    )

    logMarkAiDispatched(job)
    const aiStart = Date.now()
    const aiResult = await getMarkFromAIWithSchemeText(file, scheme, question)
    logMarkAiReturned(job, Date.now() - aiStart)

    const sanitized = sanitizeAIResult(aiResult)

    await markingDb.markStudent(
        jobId,
        teacherId,
        studentId,
        lessonId,
        file.originalname,
        file.mimetype,
        aiResult.student_ocr_text ?? '',
        JSON.stringify(sanitized)
    )
    logMarkStored(job)
}

export function startMarkingWorker() {
    const receiver = serviceBusClient.createReceiver(QUEUE_NAME)

    receiver.subscribe({
        processMessage: async (message) => {
            logInfo(`Retrieved message from "${QUEUE_NAME}": ${JSON.stringify(message.body)}`)

            try {
                await processMarkingRequest(message.body)
                await receiver.completeMessage(message)
            } catch (err) {
                logMarkFailed(message.body, err)
                await receiver.abandonMessage(message)
            }
        },
        processError: async (args) => {
            logInfo(`Error receiving from "${QUEUE_NAME}": ${args.error.message}`)
        },
    }, { autoCompleteMessages: false })

    logInfo(`Subscribed to "${QUEUE_NAME}" — listening for messages.`)

    return receiver
}
