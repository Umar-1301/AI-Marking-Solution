import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs')

// ─── Log format ────────────────────────────────────────────────────────────────
//
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | ── OCR REQUEST ──────────────────────────────────
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | STUDENT  | IMG_3682.HEIC    | 3254938 B (3.10 MB) | image/jpeg
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | SCHEME   | scheme.pdf       |   79030 B (0.08 MB) | application/pdf
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | AI CALL  | dispatched to AI service
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | FILETYPE | image            | 1 page
// 2026-05-09 10:23:45 | a3f2b1c4 | usr:abc123 | DIMS     | page 1           | original 4032×3024 → model 1280×960  ↓ downscaled
// 2026-05-09 10:23:48 | a3f2b1c4 | usr:abc123 | PAGE 1   | 1280×960         | 523 chars | 3241 ms
// 2026-05-09 10:23:48 | a3f2b1c4 | usr:abc123 | ✓ DONE   | 1 page           | 523 chars | 3280 ms total
// 2026-05-09 10:23:48 | a3f2b1c4 | usr:abc123 | ✗ FAILED | ECONNREFUSED     | AI service unreachable — connect ECONNREFUSED 127.0.0.1:8000
// 2026-05-09 10:23:48 | a3f2b1c4 | usr:abc123 | ✗ FAILED | HTTP 500         | RuntimeError: Invalid buffer size: 34.68 GiB

const lineFormat = winston.format.printf(({ timestamp, message, ...meta }) => {
    const rid    = (meta.requestId ?? '????????').padEnd(8)
    const uid    = `usr:${String(meta.userId ?? 'unknown').slice(0, 16)}`
    const prefix = `${timestamp} | ${rid} | ${uid}`

    switch (meta.event) {
        case 'ocr_start':
            return `${prefix} | ── OCR REQUEST ${'─'.repeat(45)}`

        case 'file_info': {
            const slot = (meta.slot ?? '').padEnd(8)
            const name = (meta.filename ?? '').padEnd(24).slice(0, 24)
            const mb   = (meta.bytes / 1024 / 1024).toFixed(2)
            const size = `${String(meta.bytes).padStart(8)} B (${mb} MB)`
            return `${prefix} | ${slot} | ${name} | ${size} | ${meta.mime ?? ''}`
        }

        case 'ai_dispatched':
            return `${prefix} | AI CALL  | dispatched to AI service`

        case 'ocr_file_type': {
            const pages = `${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'}`
            return `${prefix} | FILETYPE | ${(meta.fileType ?? '').padEnd(16)} | ${pages}`
        }

        case 'ocr_dims': {
            const orig  = `${meta.originalWidth}×${meta.originalHeight}`
            const model = `${meta.modelWidth}×${meta.modelHeight}`
            const flag  = meta.downscaled ? '  ↓ downscaled' : ''
            return `${prefix} | DIMS     | page ${meta.index}           | original ${orig.padEnd(10)} → model ${model}${flag}`
        }

        case 'ocr_page': {
            const label = `PAGE ${meta.index}  `
            const dims  = `${meta.modelWidth}×${meta.modelHeight}`
            const chars = `${meta.charCount} chars`
            return `${prefix} | ${label} | ${dims.padEnd(10)} | ${chars.padEnd(10)} | ${meta.ms} ms`
        }

        case 'scheme_stored':
            return `${prefix} | ✓ STORED | lessons          | lesson ${meta.lessonId}`

        case 'ocr_done': {
            const pages = `${meta.pages} page${meta.pages === 1 ? '' : 's'}`
            return `${prefix} | ✓ DONE   | ${pages.padEnd(10)} | ${meta.totalChars} chars | ${meta.ms} ms total`
        }

        case 'ocr_failed': {
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
            filename:    'ocr-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles:    '30d',
            maxSize:     '20m',
            auditFile:   path.join(LOG_DIR, '.ocr-audit.json'),
            level:       'info',
        }),
    ],
})

// ─── Exports ───────────────────────────────────────────────────────────────────

export function logOcrStart(req) {
    logger.info('', { event: 'ocr_start', requestId: req._requestId, userId: req.user?.id })
}

export function logFileInfo(req, slot, file) {
    logger.info('', {
        event:     'file_info',
        requestId: req._requestId,
        userId:    req.user?.id,
        slot,
        filename:  file.originalname,
        bytes:     file.size,
        mime:      file.mimetype,
    })
}

export function logAiDispatched(req) {
    logger.info('', { event: 'ai_dispatched', requestId: req._requestId, userId: req.user?.id })
}

export function logOcrFileType(req, meta) {
    logger.info('', {
        event:     'ocr_file_type',
        requestId: req._requestId,
        userId:    req.user?.id,
        fileType:  meta.file_type,
        pageCount: meta.page_count,
    })
}

export function logOcrDims(req, pageMeta) {
    logger.info('', {
        event:          'ocr_dims',
        requestId:      req._requestId,
        userId:         req.user?.id,
        index:          pageMeta.index,
        originalWidth:  pageMeta.original_width,
        originalHeight: pageMeta.original_height,
        modelWidth:     pageMeta.model_width,
        modelHeight:    pageMeta.model_height,
        downscaled:     pageMeta.downscaled,
    })
}

export function logOcrPage(req, stage, pageMeta) {
    logger.info('', {
        event:      'ocr_page',
        requestId:  req._requestId,
        userId:     req.user?.id,
        index:      pageMeta?.index ?? '?',
        modelWidth: pageMeta?.model_width,
        modelHeight:pageMeta?.model_height,
        charCount:  pageMeta?.char_count ?? 0,
        ms:         stage.ms,
    })
}

export function logOcrDone(req, pageCount, totalChars, totalMs) {
    logger.info('', {
        event:      'ocr_done',
        requestId:  req._requestId,
        userId:     req.user?.id,
        pages:      pageCount,
        totalChars,
        ms:         totalMs,
    })
}

export function logSchemeStored(req, lessonId) {
    logger.info('', { event: 'scheme_stored', requestId: req._requestId, userId: req.user?.id, lessonId })
}

export function logOcrFailed(req, err) {
    logger.warn('', {
        event:        'ocr_failed',
        requestId:    req._requestId,
        userId:       req.user?.id,
        aiStatus:     err.aiStatus ?? null,
        aiErrorCode:  err.aiErrorCode ?? null,
        detail:       err.aiBody ?? err.message ?? String(err),
    })
}
