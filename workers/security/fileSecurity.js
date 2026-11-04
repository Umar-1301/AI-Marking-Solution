import { PDFDocument } from 'pdf-lib'

export const MAX_STUDENT_FILE_BYTES = 5 * 1024 * 1024
const MAX_PDF_PAGES = 30
const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'image/heif', 'application/pdf',
])
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'])

export class StudentFileValidationError extends Error {
    constructor(message) {
        super(message)
        this.name = 'StudentFileValidationError'
    }
}

export function checkUploadedSize(size) {
    if (Number.isFinite(size) && size > MAX_STUDENT_FILE_BYTES) {
        throw new StudentFileValidationError('Student file exceeds the 5 MB limit')
    }
}

export async function checkStudentFile(file) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw new StudentFileValidationError('Student file is missing or empty')
    }
    checkUploadedSize(file.buffer.length)
    const name = file.originalname
    if (typeof name !== 'string' || name.length > 255 ||
        name.includes('%00') || /[\x00-\x1F/\\]/.test(name) ||
        !name.replace(/[ ./\\]+$/, '').trim()) {
        throw new StudentFileValidationError('Student filename is invalid')
    }
    const parts = name.split('.')
    if (parts.length !== 2 || !ALLOWED_EXTENSIONS.has(parts[1].toLowerCase())) {
        throw new StudentFileValidationError('Student filename must have one supported extension')
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
        throw new StudentFileValidationError('Student file type is unsupported')
    }
    if (file.mimetype === 'application/pdf') {
        try {
            const pdf = await PDFDocument.load(file.buffer)
            const count = pdf.getPageCount()
            if (count < 1 || count > MAX_PDF_PAGES) {
                throw new StudentFileValidationError('Student PDF must contain 1 to 30 pages')
            }
            return { ...file, pageCount: count }
        } catch (err) {
            if (err instanceof StudentFileValidationError) throw err
            throw new StudentFileValidationError('Student PDF cannot be opened')
        }
    }
    return { ...file, pageCount: 1 }
}
