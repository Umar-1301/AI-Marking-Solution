import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { lessonDb, markingDb, classDb } from '../db/index.js'
import { makeFileSecurity } from '../middleware/fileSecurity.js'
import { makeValidateFile } from '../middleware/validateFile.js'
import { getOcrFromAI, getMarkFromAIWithSchemeText } from '../services/aiService.js'
import { generateUploadUrl } from '../services/blobService.js'
import { sanitizeAIResult } from '../utils/sanitize.js'
import { sanitiseOcrText } from '../middleware/inputSecurity.js'
import {
    logOcrStart, logFileInfo, logAiDispatched,
    logOcrFileType, logOcrDims, logOcrPage,
    logOcrDone, logOcrFailed,
} from '../logging/ocrLogger.js'

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

// Picks out the question-specific slice of structured_scheme the teacher
// selected on the question-picker page, so only that question's AOs/bands go
// to the LLM — not the whole paper — for multi-question mark schemes. Falls
// back to the raw OCR text if there's no structured_scheme to parse at all.
function resolveScheme(ocrRow) {
    if (!ocrRow.structured_scheme) return ocrRow.ocr_text
    let parsed
    try { parsed = JSON.parse(ocrRow.structured_scheme) } catch { return ocrRow.structured_scheme }

    const questions = parsed.questions
    if (!Array.isArray(questions) || questions.length === 0) return ocrRow.structured_scheme

    const idx = ocrRow.selected_question_index ?? 0
    const question = questions[idx] ?? questions[0]
    return JSON.stringify(question)
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

// GET /lessons/:id/ocr — return the stored OCR text for a lesson owned by this teacher.
router.get('/:id/ocr', async (req, res, next) => {
    try {
        const row = await lessonDb.getOcrText(req.params.id, req.user.id)
        if (!row) return res.status(404).json({ error: 'Lesson not found' })
        res.json({ ocr_text: row.ocr_text })
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

        const paperType     = parsedScheme.paper_type ?? 'single'
        const questionsList = (parsedScheme.questions ?? []).map(q => ({
            question_number: q.question_number,
            marks:           q.marks,
            description:     q.description,
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

        res.setHeader('Content-Type',     'application/x-ndjson')
        res.setHeader('Transfer-Encoding', 'chunked')
        res.setHeader('Cache-Control',     'no-cache')

        const emit  = (obj) => res.write(JSON.stringify(obj) + '\n')
        const isDev = process.env.NODE_ENV !== 'production'

        if (isDev && req._securityLog?.length) {
            emit({ type: 'security', checks: req._securityLog })
        }

        const file       = req.files.markScheme[0]
        const ocrStart   = Date.now()

        logOcrStart(req)
        logFileInfo(req, 'SCHEME', file)
        emit({ type: 'security_pass' })

        try {
            logAiDispatched(req)
            emit({ type: 'ai_dispatched' })

            const ocrResult = await getOcrFromAI(file)

            const stages = ocrResult.stages ?? []
            const meta   = ocrResult.meta

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

            const lessonTitle      = file.originalname.replace(/\.[^.]+$/, '')
            const cleanOcrText     = sanitiseOcrText(ocrResult.text ?? '')
            const structuredScheme = ocrResult.structured_scheme
                ? JSON.stringify(ocrResult.structured_scheme)
                : ''

            const lessonId = await lessonDb.createLesson(
                lessonTitle, classId, file.originalname, file.mimetype, cleanOcrText, structuredScheme
            )

            // Just enough to decide where Home.jsx navigates next — the full
            // question list itself lives in structured_scheme (already
            // persisted above) and is read back DB-side by SelectQuestion.jsx
            // via GET /:id/questions, not carried through this one-time stream.
            const parsedScheme         = ocrResult.structured_scheme ?? {}
            const hasMultipleQuestions = parsedScheme.paper_type === 'multi'
                && (parsedScheme.questions ?? []).length > 1

            emit({
                type: 'done',
                data: {
                    id:                     lessonId,
                    class_id:               classId,
                    class_name:             cls.class_name,
                    has_multiple_questions: hasMultipleQuestions,
                },
            })
        } catch (err) {
            logOcrFailed(req, err)
            emit({
                type:    'error',
                message: 'An unexpected error occurred',
                detail:  err.aiBody      ?? err.message ?? null,
                code:    err.aiErrorCode ?? null,
                status:  err.aiStatus    ?? null,
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
        const rows      = await markingDb.getResults(lessonId, req.user.id)
        const results   = rows.map(r => ({
            studentId: r.student_id,
            markedAt:  r.marked_at,
            result:    JSON.parse(r.student_grade),
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
        const lessonId  = parseInt(req.params.lessonId)
        const studentId = parseInt(req.params.studentId)
        const present   = await markingDb.checkResultPresence(studentId, lessonId, req.user.id)
        res.json({ present })
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
        const lessonId  = parseInt(req.params.lessonId)
        const studentId = parseInt(req.params.studentId)
        const fileName  = req.body.fileName

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

// POST /lessons/:lessonId/mark-student — upload one student's work, get AI
// marking against the already-extracted scheme, persist the result.
router.post('/:lessonId/mark-student',
    upload.fields([{ name: 'studentWork', maxCount: 1 }]),
    makeFileSecurity(STUDENT_MARK_SLOTS),
    makeValidateFile(STUDENT_MARK_SLOTS),
    async (req, res) => {
        const lessonId  = parseInt(req.params.lessonId)
        const studentId = parseInt(req.body.studentId)

        if (!studentId) return res.status(400).json({ error: 'Student ID is required' })

        const ocrRow = await lessonDb.getOcrText(lessonId, req.user.id)
        if (!ocrRow) return res.status(404).json({ error: 'Lesson not found' })
        // ocrRow.question: no source column for this in the current schema
        // yet (see lessons table) — always empty until one exists. Ported
        // as Andeep had it rather than silently dropped, so this activates
        // for free the moment that column and a capture path are added.
        const question = ocrRow.question ?? ''
        const scheme    = resolveScheme(ocrRow)

        const valid = await markingDb.validateStudent(studentId, lessonId, req.user.id)
        if (!valid) return res.status(404).json({ error: 'Student not found in this lesson' })

        const file = req.files.studentWork[0]

        // Plain request/response, not streamed — this route only ever
        // produces one terminal event (result or error), never intermediate
        // progress, so there was nothing streaming actually bought here. The
        // frontend already re-fetches from GET /results after this resolves
        // rather than trust a payload carried over a stream; see
        // refreshResults() in StudentMarking.jsx.
        try {
            const aiResult = await getMarkFromAIWithSchemeText(file, scheme, question)
            debugDumpAiResult('mark-student', aiResult)

            // sanitizeAIResult()'s field allowlist now matches the real
            // response shape (was stale, silently dropping strengths/
            // improvements/annotations/etc. — fixed in utils/sanitize.js).
            const sanitized = sanitizeAIResult(aiResult)

            await markingDb.markStudent(
                studentId, lessonId,
                file.originalname, file.mimetype,
                aiResult.student_ocr_text ?? '',
                JSON.stringify(sanitized)
            )

            res.json({ ok: true })
        } catch (err) {
            res.status(err.aiStatus ?? 500).json({
                error:  'Marking failed',
                detail: err.aiBody      ?? err.message ?? null,
                code:   err.aiErrorCode ?? null,
            })
        }
    }
)

export default router
