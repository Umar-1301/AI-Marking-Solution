import serviceBusClient, { MARK_SCHEME_QUEUE } from './queueService.js'
import { markSchemeJobDb } from '../db/index.js'
import { downloadMarkScheme } from './markSchemeBlobService.js'
import { getOcrFromAI } from './aiService.js'
import { sanitiseOcrText } from '../middleware/inputSecurity.js'

const MAX_DELIVERIES = 3 // Matches backend/servicebus/config.json.

export async function processMarkSchemeJob(jobId) {
    const job = await markSchemeJobDb.claimProcessing(jobId)
    if (!job) return // Already completed or permanently failed.

    const buffer = await downloadMarkScheme(job.blob_name, job.blob_etag)
    const file = {
        buffer,
        originalname: job.file_name,
        mimetype: job.mime_type,
        size: buffer.length,
    }
    await markSchemeJobDb.markOcr(jobId)
    const result = await getOcrFromAI(file)
    await markSchemeJobDb.completeWithLesson(jobId, job, file, {
        text: sanitiseOcrText(result.text ?? ''),
        structured_scheme: result.structured_scheme ? JSON.stringify(result.structured_scheme) : '',
        thread_scheme: result.thread_scheme ? JSON.stringify(result.thread_scheme) : '',
    })
}

export function startMarkSchemeConsumer() {
    const receiver = serviceBusClient.createReceiver(MARK_SCHEME_QUEUE)
    receiver.subscribe({
        processMessage: async (message) => {
            const jobId = message.body?.jobId
            if (typeof jobId !== 'string') {
                console.error('Mark scheme message has no job ID')
                await receiver.completeMessage(message)
                return
            }
            try {
                await processMarkSchemeJob(jobId)
                await receiver.completeMessage(message)
            } catch (err) {
                console.error(`Mark scheme job ${jobId} failed:`, err)
                try {
                    if (message.deliveryCount >= MAX_DELIVERIES) {
                        await markSchemeJobDb.fail(jobId, 'Mark scheme processing failed')
                        await receiver.completeMessage(message)
                    } else {
                        await markSchemeJobDb.retry(jobId, 'Processing will retry')
                        await receiver.abandonMessage(message)
                    }
                } catch (settleError) {
                    console.error(`Could not settle mark scheme job ${jobId}:`, settleError)
                    throw settleError
                }
            }
        },
        processError: async (args) => {
            console.error(`Mark scheme queue error: ${args.error.message}`)
        },
    }, {
        autoCompleteMessages: false,
        maxConcurrentCalls: 1,
        maxAutoLockRenewalDurationInMs: 15 * 60 * 1000,
    })
    return receiver
}
