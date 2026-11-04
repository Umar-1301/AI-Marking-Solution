export const STUDENT_MARKING_MAX_ATTEMPTS = 3
export const STUDENT_MARKING_RECOVERY_SCAN_MS = 15 * 1000
export const STUDENT_MARKING_RECOVERY_RESEND_SECONDS = 60
export const STUDENT_OCR_RETRY_LOCAL = Boolean(
    process.env.AZURE_SERVICEBUS_CONNECTION_STRING &&
    process.env.SQL_USER && process.env.SQL_PASSWORD &&
    ['localhost', '127.0.0.1'].includes(process.env.SQL_SERVER)
)
