// These limits apply only to mark-scheme jobs. Service Bus delivery counts are
// transport retries, so business attempts are counted separately in SQL.
export const MARK_SCHEME_LEASE_SECONDS = 3 * 60
export const MARK_SCHEME_TIMEOUT_MS = 3 * 60 * 1000
export const MARK_SCHEME_HEARTBEAT_MS = 30 * 1000
export const MARK_SCHEME_MAX_CONCURRENT = 5
export const MARK_SCHEME_OCR_STARTS_PER_MINUTE = 10
export const MARK_SCHEME_MAX_ATTEMPTS = 3
export const MARK_SCHEME_RECOVERY_SCAN_MS = 15 * 1000
export const MARK_SCHEME_RECOVERY_RESEND_SECONDS = 60
