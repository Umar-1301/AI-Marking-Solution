// Student marking has its own global SQL slots and attempt budget.
export const MARKING_MAX_CONCURRENT = 5
export const MARKING_MAX_ATTEMPTS = 3
export const MARKING_LEASE_SECONDS = 5 * 60
export const MARKING_TIMEOUT_MS = 5 * 60 * 1000
export const MARKING_HEARTBEAT_MS = 30 * 1000
export const MARKING_LOCK_RENEWAL_MS = 15 * 60 * 1000
export const MARKING_RECOVERY_RESEND_SECONDS = 60

function positiveInteger(name, fallback) {
    const value = Number(process.env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`)
    }
    return value
}

// Local experiment: leave MARKING_OCR_BATCH_SIZE unset for the existing flow.
export const MARKING_OCR_BATCH_SIZE = positiveInteger('MARKING_OCR_BATCH_SIZE', 1)
export const MARKING_OCR_BATCH_CONCURRENCY = positiveInteger('MARKING_OCR_BATCH_CONCURRENCY', 5)
export const MARKING_BATCH_FILL_TIMEOUT_MS = positiveInteger('MARKING_BATCH_FILL_TIMEOUT_MS', 30000)
export const MARKING_MODEL_CONCURRENCY = positiveInteger('MARKING_MODEL_CONCURRENCY', 6)
export const MARKING_BATCH_TIMEOUT_MS = positiveInteger('MARKING_BATCH_TIMEOUT_MS', 15 * 60 * 1000)
