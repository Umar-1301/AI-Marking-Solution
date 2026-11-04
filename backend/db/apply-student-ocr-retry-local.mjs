// Applies only the local OCR retry experiment's SQL additions.
import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import config from '../src/config/index.js'

if (!['localhost', '127.0.0.1'].includes(config.SQL_SERVER) ||
    !config.SQL_USER || !config.SQL_PASSWORD) {
    throw new Error('This command only applies the OCR retry migration to local SQL Server')
}

const script = await readFile(
    new URL('./migrations/20261103-student-ocr-retry-local.sql', import.meta.url),
    'utf8'
)
const batches = script.split(/^\s*GO\s*$/im).map(batch => batch.trim()).filter(Boolean)
const pool = new sql.ConnectionPool({
    server: config.SQL_SERVER,
    database: config.SQL_DATABASE,
    user: config.SQL_USER,
    password: config.SQL_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
})

try {
    await pool.connect()
    for (const batch of batches) await pool.request().batch(batch)
    console.log(`Student OCR retry migration applied to local database ${config.SQL_DATABASE}.`)
} finally {
    await pool.close()
}
