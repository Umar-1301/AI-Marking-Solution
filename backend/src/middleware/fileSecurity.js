import { PDFDocument } from 'pdf-lib'
import config from '../config/index.js'
import { generateRequestId, logUploadStart, logCheck } from '../logging/fileLogger.js'

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'])

function secLog(req, slot, check, status, detail) {
    logCheck(req, slot, check, status, detail)
    if (process.env.NODE_ENV !== 'production') {
        req._securityLog.push({ source: 'backend', slot, check, status, detail })
    }
}

function validateFilename(original) {
    if (original.length > 255)
        return 'Filename must not exceed 255 characters'
    if (original.includes('\0') || original.includes('%00'))
        return 'Filename contains invalid characters'
    if (/[\x00-\x1F]/.test(original))
        return 'Filename contains invalid characters'
    if (original.includes('/') || original.includes('\\'))
        return 'Filename contains invalid characters'
    const cleaned = original.replace(/[ ./\\]+$/, '').trim()
    if (!cleaned)
        return 'Filename is invalid'
    const parts = cleaned.split('.')
    if (parts.length < 2)
        return 'Filename must have an extension'
    if (parts.length > 2)
        return 'Filename must not have multiple extensions'
    const ext = parts[parts.length - 1].toLowerCase()
    if (!ext)
        return 'Filename must have an extension'
    if (!ALLOWED_EXTENSIONS.has(ext))
        return 'Only PDF and image files are accepted'
    return null
}

// Factory — pass the slots (file fields) you want checked.
// Keeps the upload route (two slots) and the lessons route (one slot) DRY.
export function makeFileSecurity(slots) {
    return async function fileSecurity(req, res, next) {
        req._requestId   = generateRequestId()
        req._securityLog = []
        logUploadStart(req)

        for (const { field, label } of slots) {
            const file = req.files?.[field]?.[0]

            // 1. Presence
            if (!file) {
                secLog(req, label, 'presence', 'fail', 'file missing')
                return res.status(400).json({ error: `${label} file is required` })
            }
            secLog(req, label, 'presence', 'pass', file.originalname)

            // 2. Size
            const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
            if (parseFloat(sizeMB) > config.MAX_FILE_SIZE_MB) {
                secLog(req, label, 'size', 'fail', `${sizeMB} MB — exceeds ${config.MAX_FILE_SIZE_MB} MB limit`)
                return res.status(400).json({ error: `Files must be under ${config.MAX_FILE_SIZE_MB} MB` })
            }
            secLog(req, label, 'size', 'pass', `${sizeMB} MB`)

            // 3. Filename
            const filenameError = validateFilename(file.originalname)
            if (filenameError) {
                secLog(req, label, 'filename', 'fail', filenameError)
                return res.status(400).json({ error: filenameError })
            }
            const ext = file.originalname.split('.').pop().toLowerCase()
            secLog(req, label, 'filename', 'pass', `${file.originalname} (.${ext})`)

            // 4. Declared MIME type
            if (!config.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
                secLog(req, label, 'declared MIME', 'fail', file.mimetype)
                return res.status(400).json({ error: 'Only PDF and image files are accepted' })
            }
            secLog(req, label, 'declared MIME', 'pass', file.mimetype)

            // 5. PDF page count
            if (file.mimetype === 'application/pdf') {
                const doc = await PDFDocument.load(file.buffer, { ignoreEncryption: true })
                const pageCount = doc.getPageCount()
                if (pageCount > config.MAX_PDF_PAGES) {
                    secLog(req, label, 'page count', 'fail', `${pageCount} pages — exceeds ${config.MAX_PDF_PAGES} limit`)
                    return res.status(400).json({ error: `PDF must not exceed ${config.MAX_PDF_PAGES} pages` })
                }
                secLog(req, label, 'page count', 'pass', `${pageCount} pages`)
            }
        }

        next()
    }
}
