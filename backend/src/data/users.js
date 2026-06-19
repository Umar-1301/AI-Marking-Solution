import { createHmac } from 'crypto'
import bcrypt from 'bcrypt'
import { teacherDb } from '../db/index.js'
import config from '../config/index.js'

const BCRYPT_COST = 12
const NAME_MAX    = 100

const { PASSWORD_PEPPER, EMAIL_PEPPER } = config

// Emails use HMAC-SHA256 (deterministic) so login lookup remains possible.
function hashEmail(email) {
    return createHmac('sha256', EMAIL_PEPPER).update(email.toLowerCase()).digest('hex')
}

// Passwords use HMAC-SHA256 as input to bcrypt (which adds a random salt on top).
function applyPasswordPepper(password) {
    return createHmac('sha256', PASSWORD_PEPPER).update(password).digest('hex')
}

export function findByEmail(email) {
    return teacherDb.findByEmailHash(hashEmail(email))
}

export async function createUser({ name, email, password }) {
    if (name.length > NAME_MAX) throw new Error('Name must not exceed 100 characters')
    const passwordHash = await bcrypt.hash(applyPasswordPepper(password), BCRYPT_COST)
    const result = teacherDb.insert(name.trim(), hashEmail(email), passwordHash)
    return { id: result.lastInsertRowid, name: name.trim() }
}

export async function verifyPassword(plaintext, hash) {
    return bcrypt.compare(applyPasswordPepper(plaintext), hash)
}
