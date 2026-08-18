import rateLimit from 'express-rate-limit'

// Global limiter — covers all routes, keyed by IP
export const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 400,
    message: { error: 'Too many requests. Please wait 15 minutes and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
})
