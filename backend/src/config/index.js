export default {
    PORT: process.env.PORT || 3001,
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
    AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://localhost:8000',
    JWT_SECRET: (() => {
        if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
        return process.env.JWT_SECRET
    })(),
    MAX_FILE_SIZE_MB: 5,
    MAX_PDF_PAGES: 30,
    ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
}
