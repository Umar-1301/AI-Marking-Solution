import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { lessonDb, markingDb, markingJobDb, classDb } from '../db/index.js'
import { makeFileSecurity } from '../middleware/fileSecurity.js'
import { makeValidateFile } from '../middleware/validateFile.js'
import { getOcrFromAI, getMarkFromAIWithSchemeText } from '../services/aiService.js'
import { sanitizeAIResult } from '../utils/sanitize.js'
import { sanitiseOcrText } from '../middleware/inputSecurity.js'
import {
    logOcrStart, logFileInfo, logAiDispatched,
    logOcrFileType, logOcrDims, logOcrPage,
    logOcrDone, logOcrFailed, logSchemeStored,
} from '../logging/ocrLogger.js'
import { generateRequestId } from '../logging/fileLogger.js'
import {
    logMarkStart, logBlobRetrieved, logMarkAiDispatched,
    logMarkAiReturned, logMarkStored, logMarkFailed,
} from '../logging/markingLogger.js'
import {
    generateUploadUrl,
    findStudentUpload,
    downloadStudentWork,
} from '../services/blobService.js'
import { sendStudentMarkingRequest } from '../services/queueService.js'

const router = express.Router()

// TEMP DEBUG — ad-hoc inspection of the raw AI service response, before
// sanitizeAIResult() transforms anything. backend/.tmp/ is git-ignored.
// Remove this block (and its one call site below) once done inspecting.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEBUG_DIR = path.join(__dirname, '..', '..', '.tmp')
function debugDumpAiResult(label, data) {
    try {
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })
        const file = path.join(DEBUG_DIR, `${label}-${Date.now()}.json`)
        fs.writeFileSync(file, JSON.stringify(data, null, 2))
        console.log(`[debug] raw AI result written to ${file}`)
    } catch (err) {
        console.error('[debug] failed to write AI result dump:', err.message)
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
})

const SLOTS = [{ field: 'markScheme', label: 'Mark Scheme' }]
const STUDENT_MARK_SLOTS = [{ field: 'studentWork', label: 'Student Work' }]

// Parses structured_scheme and returns the Question object at
// selected_question_index (or the first question if none selected yet).
// Returns null if there's no usable structured_scheme at all — callers
// each decide their own fallback.
function getSelectedQuestion(ocrRow) {
    if (!ocrRow.structured_scheme) return null
    let parsed
    try { parsed = JSON.parse(ocrRow.structured_scheme) } catch { return null }

    const questions = parsed.questions
    if (!Array.isArray(questions) || questions.length === 0) return null

    const idx = ocrRow.selected_question_index ?? 0
    return questions[idx] ?? questions[0]
}

// Picks out the question-specific slice of structured_scheme the teacher
// selected on the question-picker page, so only that question's AOs/bands go
// to the LLM — not the whole paper — for multi-question mark schemes. Falls
// back to the raw OCR text if there's no structured_scheme to parse at all.
function resolveScheme(ocrRow) {
    const question = getSelectedQuestion(ocrRow)
    return question ? JSON.stringify(question) : ocrRow.ocr_text
}

// GET /lessons — all lessons belonging to the logged-in teacher, newest first.
router.get('/', async (req, res, next) => {
    try {
        res.json(await lessonDb.listLessons(req.user.id))
    } catch (err) {
        next(err)
    }
})

// GET /lessons/:id — return lesson metadata (title, class_id, class_name) for a lesson
// owned by this teacher. Used by StudentMarking to bootstrap itself from the URL alone.
router.get('/:id', async (req, res, next) => {
    try {
        const lesson = await lessonDb.findLesson(req.params.id, req.user.id)
        if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
        res.json(lesson)
    } catch (err) {
        next(err)
    }
})

// GET /lessons/:id/ocr — return the extracted mark scheme for the lesson's
// currently selected question, structured for display — not raw OCR text.
// Falls back to { scheme: null, ocr_text } if there's no usable
// structured_scheme yet (an older lesson, or extraction found nothing).
router.get('/:id/ocr', async (req, res, next) => {
    try {
        const row = await lessonDb.getOcrText(req.params.id, req.user.id)
        if (!row) return res.status(404).json({ error: 'Lesson not found' })

        const question = getSelectedQuestion(row)
        if (!question) return res.json({ scheme: null, ocr_text: row.ocr_text })

        res.json({
            scheme: {
                question_number:       question.question_number,
                marks:                 question.marks,
                description:           question.description,
                assessment_objectives: question.assessment_objectives ?? [],
            },
        })
    } catch (err) {
        next(err)
    }
})

// GET /lessons/:id/questions — return the extracted {paper_type, questions[]} for
// a lesson owned by this teacher, read back from storage rather than trusting
// whatever was streamed at upload time. Backs the question-picker page so it
// works from a direct visit or a refresh, not just immediately after upload.
router.get('/:id/questions', async (req, res, next) => {
    try {
        const row = await lessonDb.getOcrText(req.params.id, req.user.id)
        if (!row) return res.status(404).json({ error: 'Lesson not found' })

        let parsedScheme = {}
        try { parsedScheme = row.structured_scheme ? JSON.parse(row.structured_scheme) : {} }
        catch { parsedScheme = {} }

        const paperType = parsedScheme.paper_type ?? 'single'
        const questionsList = (parsedScheme.questions ?? []).map(q => ({
            question_number: q.question_number,
            marks: q.marks,
            description: q.description,
        }))

        res.json({ paper_type: paperType, questions: questionsList })
    } catch (err) {
        next(err)
    }
})

// PATCH /lessons/:id/select-question — store which question from a multi-question
// paper this lesson marks. Ownership is enforced inside updateSelectedQuestion,
// via the same lessons -> classes -> teacher_id join every other lessonDb method uses.
router.patch('/:id/select-question', async (req, res, next) => {
    try {
        const lessonId = parseInt(req.params.id)
        const { selectedQuestionIndex } = req.body
        if (selectedQuestionIndex === undefined || selectedQuestionIndex === null) {
            return res.status(400).json({ error: 'selectedQuestionIndex is required' })
        }
        await lessonDb.updateSelectedQuestion(lessonId, req.user.id, selectedQuestionIndex)
        res.json({ ok: true })
    } catch (err) {
        next(err)
    }
})

// POST /lessons/:sourceLessonId/reuse — clone a previous lesson's already-
// extracted mark scheme into a brand-new lesson for the given class. No
// getOcrFromAI() call — the text is read back from teacher_ocr rather than
// re-OCR'd. Only ever touches lessons/teacher_ocr (source lookup) and
// classes (ownership checks) — never students or marking_results, since
// this creates a new session rather than resuming the old one.
router.post('/:sourceLessonId/reuse', async (req, res, next) => {
    try {
        const classId = parseInt(req.body.classId)
        if (!classId) return res.status(400).json({ error: 'Class is required' })

        const cls = await lessonDb.findClass(classId, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        const source = await lessonDb.getSchemeForReuse(req.params.sourceLessonId, req.user.id)
        if (!source) return res.status(404).json({ error: 'Lesson not found' })

        const lessonId = await lessonDb.createLesson(
            source.lesson_title,
            classId,
            source.mark_scheme_file_name,
            source.mark_scheme_mime_type,
            source.ocr_text,
            source.structured_scheme
        )

        // Same has_multiple_questions computation POST / uses, so the
        // frontend can branch on this response identically either way.
        let parsedScheme = {}
        try { parsedScheme = source.structured_scheme ? JSON.parse(source.structured_scheme) : {} }
        catch { parsedScheme = {} }
        const hasMultipleQuestions = parsedScheme.paper_type === 'multi'
            && (parsedScheme.questions ?? []).length > 1

        res.json({
            id: lessonId,
            class_id: classId,
            class_name: cls.class_name,
            has_multiple_questions: hasMultipleQuestions,
        })
    } catch (err) {
        next(err)
    }
})

// POST /lessons — security-check the mark scheme, OCR it, store the result.
// Streams newline-delimited JSON so the frontend can drive a progress bar.
router.post('/',
    upload.fields([{ name: 'markScheme', maxCount: 1 }]),
    makeFileSecurity(SLOTS),
    makeValidateFile(SLOTS),
    async (req, res) => {
        const classId = parseInt(req.body.classId)
        if (!classId) return res.status(400).json({ error: 'Class is required' })

        const cls = await lessonDb.findClass(classId, req.user.id)
        if (!cls) return res.status(404).json({ error: 'Class not found' })

        res.setHeader('Content-Type', 'application/x-ndjson')
        res.setHeader('Transfer-Encoding', 'chunked')
        res.setHeader('Cache-Control', 'no-cache')

        const emit = (obj) => res.write(JSON.stringify(obj) + '\n')
        const isDev = process.env.NODE_ENV !== 'production'

        if (isDev && req._securityLog?.length) {
            emit({ type: 'security', checks: req._securityLog })
        }

        const file = req.files.markScheme[0]
        const ocrStart = Date.now()

        logOcrStart(req)
        logFileInfo(req, 'SCHEME', file)
        emit({ type: 'security_pass' })

        try {
            logAiDispatched(req)
            emit({ type: 'ai_dispatched' })

            const ocrResult = await getOcrFromAI(file)

            const stages = ocrResult.stages ?? []
            const meta = ocrResult.meta

            if (meta) {
                logOcrFileType(req, meta)
                emit({ type: 'ocr_file_type', fileType: meta.file_type, pageCount: meta.page_count })
            }

            if (meta?.pages) {
                for (const pageMeta of meta.pages) {
                    logOcrDims(req, pageMeta)
                    const matchingStage = stages[pageMeta.index - 1]
                    if (matchingStage) logOcrPage(req, matchingStage, pageMeta)
                    emit({ type: 'ocr_page', index: pageMeta.index, totalPages: meta.page_count })
                }
            }

            logOcrDone(req, meta?.page_count ?? stages.length, meta?.total_chars ?? 0, Date.now() - ocrStart)

            const lessonTitle = file.originalname.replace(/\.[^.]+$/, '')
            const cleanOcrText = sanitiseOcrText(ocrResult.text ?? '')
            const structuredScheme = ocrResult.structured_scheme
                ? JSON.stringify(ocrResult.structured_scheme)
                : ''

            const lessonId = await lessonDb.createLesson(
                lessonTitle, classId, file.originalname, file.mimetype, cleanOcrText, structuredScheme
            )
            logSchemeStored(req, lessonId)

            // Just enough to decide where Home.jsx navigates next — the full
            // question list itself lives in structured_scheme (already
            // persisted above) and is read back DB-side by SelectQuestion.jsx
            // via GET /:id/questions, not carried through this one-time stream.
            const parsedScheme = ocrResult.structured_scheme ?? {}
            const hasMultipleQuestions = parsedScheme.paper_type === 'multi'
                && (parsedScheme.questions ?? []).length > 1

            emit({
                type: 'done',
                data: {
                    id: lessonId,
                    class_id: classId,
                    class_name: cls.class_name,
                    has_multiple_questions: hasMultipleQuestions,
                },
            })
        } catch (err) {
            logOcrFailed(req, err)
            emit({
                type: 'error',
                message: 'An unexpected error occurred',
                detail: err.aiBody ?? err.message ?? null,
                code: err.aiErrorCode ?? null,
                status: err.aiStatus ?? null,
            })
        }

        res.end()
    }
)

// GET /lessons/:lessonId/results — all marking results for this lesson,
// scoped to the teacher's own classes via markingDb.getResults' join.
router.get('/:lessonId/results', async (req, res, next) => {
    try {
        const lessonId = parseInt(req.params.lessonId)
        const rows = await markingDb.getResults(lessonId, req.user.id)
        const results = rows.map(r => ({
            studentId: r.student_id,
            markedAt: r.marked_at,
            result: JSON.parse(r.student_grade),
        }))
        res.json({ results })
    } catch (err) {
        next(err)
    }
})

// GET /lessons/:lessonId/result_presence/:studentId — true/false check for
// whether a marking result already exists for this student in this lesson.
// Deliberately returns presence only, never the result itself — kept
// separate from GET /results so pages that only need to restore tick state
// (e.g. StudentMarking on refresh) don't have to pull the full grade payload.
router.get('/:lessonId/result_presence/:studentId', async (req, res, next) => {
    try {
        const lessonId = parseInt(req.params.lessonId)
        const studentId = parseInt(req.params.studentId)
        const present = await markingDb.checkResultPresence(studentId, lessonId, req.user.id)
        res.json({ present })
    } catch (err) {
        next(err)
    }
})

// GET /lessons/:lessonId/job-status — latest asynchronous marking attempt for
// each student in this lesson. This is a short-lived authenticated status read;
// the frontend calls it periodically while one or more jobs are active.
router.get('/:lessonId/job-status', async (req, res, next) => {
    const lessonId = Number(req.params.lessonId)

    if (!Number.isSafeInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Valid lesson ID is required' })
    }

    try {
        const jobs = await markingJobDb.listLatestForLesson(lessonId, req.user.id)

        res.json({
            jobs: jobs.map(job => ({
                jobId: job.job_id,
                studentId: job.student_id,
                status: job.status,
                queuedAt: job.queued_at,
                processingAt: job.processing_at,
                markingAt: job.marking_at,
                completedAt: job.completed_at,
            })),
        })
    } catch (err) {
        next(err)
    }
})

// POST /lessons/:lessonId/students/:studentId/upload-url — mint a
// short-lived, write-only SAS URL scoped to exactly this student's blob
// path. The frontend PUTs the file straight to blob storage with it; the
// file bytes never pass through this server (see services/blobService.js).
router.post('/:lessonId/students/:studentId/upload-url', async (req, res, next) => {
    try {
        const lessonId = parseInt(req.params.lessonId)
        const studentId = parseInt(req.params.studentId)
        const fileName = req.body.fileName

        if (!fileName || typeof fileName !== 'string' || fileName.length > 255) {
            return res.status(400).json({ error: 'fileName is required' })
        }

        const valid = await markingDb.validateStudent(studentId, lessonId, req.user.id)
        if (!valid) return res.status(404).json({ error: 'Student not found in this lesson' })

        const uploadUrl = await generateUploadUrl(req.user.id, lessonId, studentId, fileName)
        res.json({ uploadUrl })
    } catch (err) {
        next(err)
    }
})

// POST /lessons/:lessonId/mark-student — verify the authenticated teacher,
// lesson, student and uploaded work, then hand the request to the marking
// worker through Service Bus. Marking is deliberately no longer performed by
// the HTTP request.
router.post('/:lessonId/mark-student', async (req, res, next) => {
    const lessonId = Number(req.params.lessonId)
    const studentId = Number(req.body.studentId)
    const teacherId = req.user.id

    if (!Number.isSafeInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Valid lesson ID is required' })
    }
    if (!Number.isSafeInteger(studentId) || studentId <= 0) {
        return res.status(400).json({ error: 'Valid student ID is required' })
    }

    // No fileSecurity middleware runs on this route anymore (no file in the
    // request body to check), so nothing else sets req._requestId — done
    // here instead, same generator every other route's logging uses.
    req._requestId = generateRequestId()
    logMarkStart(req, lessonId, studentId)

    // ownership of lesson id to teacher id is checked against db
    try {
        const ocrRow = await lessonDb.getOcrText(
            lessonId,
            teacherId
        )
        if (!ocrRow) {
            return res.status(404).json({
                error: 'Lesson not found'
            })
        }

        const validStudent = await markingDb.validateStudent(
            studentId,
            lessonId,
            teacherId
        )
        if (!validStudent) {
            return res.status(404).json({
                error: 'Student not found in this lesson'
            })
        }

        const upload = await findStudentUpload(
            teacherId,
            lessonId,
            studentId
        )
        if (!upload) {
            return res.status(404).json({
                error: 'No uploaded work found for this student'
            })
        }

        // Create the durable row first so the worker can update it immediately
        // even if it receives the Service Bus message before this route returns.
        // If publication fails, remove the still-queued row below.
        const job = await markingJobDb.createQueued(
            teacherId,
            lessonId,
            studentId
        )

        try {
            await sendStudentMarkingRequest({
                jobId: job.job_id,
                teacherId,
                lessonId,
                studentId,
            })
        } catch (queueError) {
            try {
                await markingJobDb.deleteQueued(job.job_id)
            } catch (cleanupError) {
                queueError.jobCleanupError = cleanupError
            }
            throw queueError
        }

        res.status(202).json({
            ok: true,
            queued: true,
            jobId: job.job_id,
            status: 'queued',
            requestId: req._requestId,
            studentId,
        })

    } catch (err) {
        logMarkFailed(req, err)

        // Preserve the structured error information supplied by aiService.
        if (
            err &&
            typeof err === 'object' &&
            ('aiStatus' in err || 'aiErrorCode' in err)
        ) {
            return res.status(err.aiStatus ?? 502).json({
                error: 'Marking failed',
                detail: err.aiBody ?? null,
                code: err.aiErrorCode ?? null,
            })
        }

        // Database and Blob infrastructure errors go through the central
        // handler, which logs them without exposing internals to the browser.
        next(err)
    }
})

export default router
