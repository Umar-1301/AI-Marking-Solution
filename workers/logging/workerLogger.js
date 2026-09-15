// Same daily-rotating-file convention as backend/src/logging/ — a separate
// log file per day, kept for 30 days. This service has no marking logic
// wired up yet, so only lifecycle events exist to log right now; the named
// per-event function pattern (mirroring ocrLogger.js/markingLogger.js) is
// kept anyway so future events slot in without changing the shape.
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOG_DIR = path.resolve(__dirname, '..', 'logs')

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) =>
            `${timestamp} | ${level.toUpperCase().padEnd(5)} | ${message}`
        )
    ),
    transports: [
        new DailyRotateFile({
            dirname:     LOG_DIR,
            filename:    'worker-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles:    '30d',
            maxSize:     '20m',
            // Use worker-specific rotation metadata. The previous audit file
            // was created before `worker/` was renamed to `workers/` and its
            // embedded absolute path kept recreating the obsolete directory.
            auditFile:   path.join(LOG_DIR, '.marking-worker-audit.json'),
            level:       'info',
        }),
    ],
})

export function logWorkerStart(port) {
    logger.info(`Worker service started on port ${port}.`)
}

export function logInfo(message) {
    logger.info(message)
}

function jobContext(job = {}) {
    const context = job ?? {}
    return `teacher ${context.teacherId ?? '?'} | lesson ${context.lessonId ?? '?'} | student ${context.studentId ?? '?'}`
}

export function logMarkStart(job) {
    logger.info(`Marking started | ${jobContext(job)}`)
}

export function logBlobRetrieved(job, filename, bytes) {
    logger.info(`Blob retrieved | ${jobContext(job)} | ${filename} | ${bytes} bytes`)
}

export function logMarkAiDispatched(job) {
    logger.info(`AI call dispatched | ${jobContext(job)}`)
}

export function logMarkAiReturned(job, milliseconds) {
    logger.info(`AI call returned | ${jobContext(job)} | ${milliseconds} ms`)
}

export function logMarkStored(job) {
    logger.info(`Marking stored | ${jobContext(job)}`)
}

export function logMarkFailed(job, err) {
    const code = err?.aiErrorCode ?? err?.aiStatus ?? 'ERROR'
    const detail = err?.aiBody ?? err?.message ?? String(err)
    logger.warn(`Marking failed | ${jobContext(job)} | ${code} | ${String(detail).slice(0, 300)}`)
}
