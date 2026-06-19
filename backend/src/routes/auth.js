import express from 'express'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { findByEmail, createUser, verifyPassword } from '../data/users.js'
import { sanitiseString, MAX_STRING_LENGTH } from '../middleware/inputSecurity.js'
import config from '../config/index.js'

const router = express.Router()

const TOKEN_EXPIRY = '1h'

// Cookie issued with every token — httpOnly keeps it off the JavaScript heap.
// secure:true requires HTTPS, but browsers treat http://localhost as a secure
// context, so this also works for local dev. sameSite:lax gives CSRF
// protection while allowing top-level navigations — frontend and backend sit
// behind the same domain, so this is also a same-site request either way.
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000, // 1 hour — mirrors JWT TTL
    path: '/',
}

// ─── Login attempt tracking ───────────────────────────────────────────────────
// In-memory store: emailKey → { attempts, lockedUntil }
// Resets on server restart — sufficient for session-based brute-force protection.
const loginAttempts = new Map()
const MAX_LOGIN_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes

function getAttemptRecord(emailKey) {
    const record = loginAttempts.get(emailKey)
    if (!record) return { attempts: 0, lockedUntil: null }
    // If the lockout window has passed, treat as a fresh start
    if (record.lockedUntil && Date.now() >= record.lockedUntil) {
        loginAttempts.delete(emailKey)
        return { attempts: 0, lockedUntil: null }
    }
    return record
}

function recordFailedAttempt(emailKey) {
    const record = getAttemptRecord(emailKey)
    const attempts = record.attempts + 1
    loginAttempts.set(emailKey, {
        attempts,
        lockedUntil: attempts >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : null,
    })
}

function clearAttempts(emailKey) {
    loginAttempts.delete(emailKey)
}

// Load blacklist once at startup into a Set for O(1) lookups
const __dirname = dirname(fileURLToPath(import.meta.url))
const blacklist = new Set(
    readFileSync(join(__dirname, '../data/10k-most-common.txt'), 'utf-8')
        .split('\n')
        .map(p => p.trim().toLowerCase())
        .filter(Boolean)
)

// RFC 5321-compliant email format check (max 254 chars, no leading/trailing/consecutive dots)
const EMAIL_REGEX = /^[a-zA-Z0-9_%+\-]+(\.[a-zA-Z0-9_%+\-]+)*@[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}$/

function isValidEmail(email) {
    return email.length <= 254 && EMAIL_REGEX.test(email)
}

function signToken(user) {
    return jwt.sign(
        { id: user.id, name: user.name },
        config.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: TOKEN_EXPIRY }
    )
}

// POST /auth/signup
router.post('/signup', async (req, res, next) => {
    try {
        const { name: rawName, email, password, confirmPassword } = req.body

        if (!rawName?.trim() || !email?.trim() || !password) {
            return res.status(400).json({ error: 'Name, email and password are required' })
        }

        const name = sanitiseString(rawName)
        if (!name) {
            return res.status(400).json({ error: 'Name, email and password are required' })
        }
        if (name.length > MAX_STRING_LENGTH) {
            return res.status(400).json({ error: `Name must not exceed ${MAX_STRING_LENGTH} characters` })
        }
        if (!isValidEmail(email.trim())) {
            return res.status(400).json({ error: 'Please enter a valid email address' })
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' })
        }
        if (password.length < 10) {
            return res.status(400).json({ error: 'Password must be at least 10 characters' })
        }
        if (Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ error: 'Password must not exceed 72 characters' })
        }
        if (!/[0-9]/.test(password)) {
            return res.status(400).json({ error: 'Password must contain at least one number' })
        }
        if ((password.match(/[^a-zA-Z0-9]/g) || []).length < 2) {
            return res.status(400).json({ error: 'Password must contain at least 2 special characters' })
        }
        if (blacklist.has(password.toLowerCase())) {
            return res.status(400).json({ error: 'This password is too common. Please choose a more unique password.' })
        }
        if (findByEmail(email)) {
            return res.status(400).json({ error: 'Unable to create account. Please check your details.' })
        }

        const user = await createUser({ name: name.trim(), email, password })
        const token = signToken(user)

        res.status(201).cookie('aimira_token', token, COOKIE_OPTIONS).json({ user })
    } catch (err) {
        next(err)
    }
})

// POST /auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body

        if (!email?.trim() || !password) {
            return res.status(400).json({ error: 'Email and password are required' })
        }
        if (!isValidEmail(email.trim())) {
            return res.status(400).json({ error: 'Please enter a valid email address' })
        }

        const emailKey = email.trim().toLowerCase()

        // Check lockout before doing any expensive work
        const attemptRecord = getAttemptRecord(emailKey)
        if (attemptRecord.lockedUntil) {
            return res.status(429).json({ error: 'Account temporarily locked. Please try again in 15 minutes.' })
        }

        // Passwords over 72 bytes cannot exist in the store (blocked at signup)
        // and bcrypt would silently truncate them — reject early to prevent DoS
        if (Buffer.byteLength(password, 'utf8') > 72) {
            recordFailedAttempt(emailKey)
            return res.status(401).json({ error: 'Invalid email or password' })
        }

        const record = findByEmail(email)
        if (!record) {
            recordFailedAttempt(emailKey)
            return res.status(401).json({ error: 'Invalid email or password' })
        }

        const match = await verifyPassword(password, record.password_hash)
        if (!match) {
            recordFailedAttempt(emailKey)
            return res.status(401).json({ error: 'Invalid email or password' })
        }

        // Successful login — clear the failure counter
        clearAttempts(emailKey)

        const user = { id: record.id, name: record.name }
        const token = signToken(user)

        res.cookie('aimira_token', token, COOKIE_OPTIONS).json({ user })
    } catch (err) {
        next(err)
    }
})

// POST /auth/refresh
// Reads the httpOnly cookie (sent automatically by the browser).
// Verifies the signature with ignoreExpiration:true so a just-expired token
// can be exchanged for a fresh one without re-entering credentials.
// A tampered or entirely absent token is rejected.
router.post('/refresh', (req, res) => {
    const token = req.cookies?.aimira_token
    if (!token) {
        return res.status(401).json({ error: 'No token provided' })
    }

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: true })
        const newToken = signToken({ id: decoded.id, name: decoded.name })
        const user = { id: decoded.id, name: decoded.name }
        res.cookie('aimira_token', newToken, COOKIE_OPTIONS).json({ user })
    } catch {
        return res.status(401).json({ error: 'Invalid token — cannot refresh' })
    }
})

// POST /auth/logout — clears the httpOnly cookie server-side
router.post('/logout', (_req, res) => {
    res.clearCookie('aimira_token', { path: '/' }).json({ ok: true })
})

export default router
