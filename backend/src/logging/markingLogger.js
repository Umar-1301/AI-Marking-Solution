import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs')

// ─── Log format ────────────────────────────────────────────────────────────────
//
// 2026-08-23 10:23:45 | a3f2b1c4 | usr:1 | ── MARK REQUEST ───────────────────────────────────
// 2026-08-23 10:23:45 | a3f2b1c4 | usr:1 | START    | lesson 27        | student 8
// 2026-08-23 10:23:45 | a3f2b1c4 | usr:1 | BLOB     | retrieved        | umar.pdf         | 3254938 B (3.10 MB)
// 2026-08-23 10:23:45 | a3f2b1c4 | usr:1 | AI CALL  | dispatched to AI service
// 2026-08-23 10:23:48 | a3f2b1c4 | usr:1 | AI CALL  | returned         | 3280 ms
// 2026-08-23 10:23:48 | a3f2b1c4 | usr:1 | ✓ STORED | marking_results  | lesson 27        | student 8
// 2026-08-23 10:23:48 | a3f2b1c4 | usr:1 | ✗ FAILED | HTTP 500         | RuntimeError: Invalid buffer size

const lineFormat = winston.format.printf(({ timestamp, message, ...meta }) => {
    const rid    = (meta.requestId ?? '????????').padEnd(8)
    const uid    = `usr:${String(meta.userId ?? 'unknown').slice(0, 16)}`
    const prefix = `${timestamp} | ${rid} | ${uid}`

    switch (meta.event) {
        case 'mark_start':
            return `${prefix} | ── MARK REQUEST ${'─'.repeat(43)}`

        case 'mark_context':
            return `${prefix} | START    | lesson ${meta.lessonId}        | student ${meta.studentId}`

        case 'blob_retrieved': {
            const name = (meta.filename ?? '').padEnd(24).slice(0, 24)
            const mb   = (meta.bytes / 1024 / 1024).toFixed(2)
            const size = `${String(meta.bytes).padStart(8)} B (${mb} MB)`
            return `${prefix} | BLOB     | retrieved        | ${name} | ${size}`
        }

        case 'ai_dispatched':
            return `${prefix} | AI CALL  | dispatched to AI service`

        case 'ai_returned':
            return `${prefix} | AI CALL  | returned         | ${meta.ms} ms`

        case 'db_stored':
            return `${prefix} | ✓ STORED | marking_results  | lesson ${meta.lessonId}        | student ${meta.studentId}`

        case 'mark_failed': {
            const code   = (meta.aiErrorCode ?? meta.aiStatus ?? 'ERROR').toString().padEnd(16)
            const detail = (meta.detail ?? '').slice(0, 140)
            return `${prefix} | ✗ FAILED | ${code} | ${detail}`
        }

        default:
            return `${prefix} | ${message}`
    }
})

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        lineFormat
    ),
    transports: [
        new DailyRotateFile({
            dirname:     LOG_DIR,
            filename:    'marking-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles:    '30d',
            maxSize:     '20m',
            auditFile:   path.join(LOG_DIR, '.marking-audit.json'),
            level:       'info',
        }),
    ],
})

// ─── Exports ───────────────────────────────────────────────────────────────────

export function logMarkStart(req, lessonId, studentId) {
    logger.info('', { event: 'mark_start', requestId: req._requestId, userId: req.user?.id })
    logger.info('', { event: 'mark_context', requestId: req._requestId, userId: req.user?.id, lessonId, studentId })
}

export function logBlobRetrieved(req, filename, bytes) {
    logger.info('', {
        event:     'blob_retrieved',
        requestId: req._requestId,
        userId:    req.user?.id,
        filename,
        bytes,
    })
}

export function logMarkAiDispatched(req) {
    logger.info('', { event: 'ai_dispatched', requestId: req._requestId, userId: req.user?.id })
}

export function logMarkAiReturned(req, ms) {
    logger.info('', { event: 'ai_returned', requestId: req._requestId, userId: req.user?.id, ms })
}

export function logMarkStored(req, lessonId, studentId) {
    logger.info('', { event: 'db_stored', requestId: req._requestId, userId: req.user?.id, lessonId, studentId })
}

export function logMarkFailed(req, err) {
    logger.warn('', {
        event:       'mark_failed',
        requestId:   req._requestId,
        userId:      req.user?.id,
        aiStatus:    err.aiStatus ?? null,
        aiErrorCode: err.aiErrorCode ?? null,
        detail:      err.aiBody ?? err.message ?? String(err),
    })
}
