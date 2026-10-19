// Student marking has its own global SQL slots and attempt budget.
export const MARKING_MAX_CONCURRENT = 5
export const MARKING_MAX_ATTEMPTS = 3
export const MARKING_LEASE_SECONDS = 5 * 60
export const MARKING_TIMEOUT_MS = 5 * 60 * 1000
export const MARKING_HEARTBEAT_MS = 30 * 1000
export const MARKING_LOCK_RENEWAL_MS = 15 * 60 * 1000
export const MARKING_RECOVERY_RESEND_SECONDS = 60
