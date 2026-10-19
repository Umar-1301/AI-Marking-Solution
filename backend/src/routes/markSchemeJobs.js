import express from 'express'
import { lessonDb, markSchemeJobDb } from '../db/index.js'
import {
    generateMarkSchemeUploadUrl, getMarkSchemeProperties, markSchemeBlobName,
} from '../services/markSchemeBlobService.js'
import { sendMarkSchemeRequest } from '../services/queueService.js'
import { testFlowId, traceMarkScheme } from '../logging/markSchemeTrace.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

router.post('/', async (req, res, next) => {
    const classId = Number(req.body?.classId)
    const { fileName, mimeType } = req.body ?? {}
    if (!Number.isSafeInteger(classId) || classId <= 0) {
        return res.status(400).json({ error: 'Valid class ID is required' })
    }
    if (typeof fileName !== 'string' || !fileName || typeof mimeType !== 'string' || !mimeType) {
        return res.status(400).json({ error: 'File name and MIME type are required' })
    }
    try {
        const cls = await lessonDb.findClass(classId, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const job = await markSchemeJobDb.createPending(req.user.id, classId, fileName, mimeType)
        req.markSchemeJobId = job.job_id
        const blobName = markSchemeBlobName(req.user.id, job.job_id)
        await markSchemeJobDb.setBlobName(job.job_id, req.user.id, blobName)
        const uploadUrl = await generateMarkSchemeUploadUrl(blobName)
        res.status(201).json({ jobId: job.job_id, uploadUrl })
    } catch (err) {
        next(err)
    }
})

router.post('/:jobId/queue', async (req, res, next) => {
    const { jobId } = req.params
    if (!UUID.test(jobId)) return res.status(400).json({ error: 'Invalid job ID' })

    try {
        const job = await markSchemeJobDb.findOwned(jobId, req.user.id)
        if (!job) return res.status(404).json({ error: 'Job not found' })
        if (job.status === 'queued' || job.status === 'processing' || job.status === 'ocr' || job.status === 'complete') {
            return res.status(202).json({ jobId, status: job.status })
        }
        if (job.status !== 'awaiting_upload' || !job.blob_name) {
            return res.status(409).json({ error: 'Job cannot be queued' })
        }

        const properties = await getMarkSchemeProperties(job.blob_name)
        if (!properties) {
            return res.status(400).json({ error: 'Mark scheme upload has not completed' })
        }

        const queued = await markSchemeJobDb.markQueued(jobId, req.user.id, properties.etag)
        if (!queued) return res.status(409).json({ error: 'Job was already queued' })
        try {
            await sendMarkSchemeRequest(jobId)
            traceMarkScheme('queued', { flow_id: testFlowId(req), job_id: jobId })
        } catch (err) {
            await markSchemeJobDb.restorePending(jobId, req.user.id)
            throw err
        }
        res.status(202).json({ jobId, status: 'queued' })
    } catch (err) {
        next(err)
    }
})

router.get('/:jobId', async (req, res, next) => {
    if (!UUID.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID' })
    try {
        const job = await markSchemeJobDb.findOwned(req.params.jobId, req.user.id)
        if (!job) return res.status(404).json({ error: 'Job not found' })
        res.json({
            jobId: job.job_id,
            status: job.status,
            lessonId: job.lesson_id,
            hasMultipleQuestions: job.has_multiple_questions === true,
            error: job.status === 'failed' ? job.error_message : null,
            createdAt: job.created_at,
            queuedAt: job.queued_at,
            processingAt: job.processing_at,
            ocrAt: job.ocr_at,
            completedAt: job.completed_at,
        })
    } catch (err) {
        next(err)
    }
})

export default router
