// Local SQL only. Apply the SQL file to Azure SQL with an admin query tool.
import { readFile } from 'node:fs/promises'
import sql from 'mssql'
import config from '../src/config/index.js'

if (!['localhost', '127.0.0.1'].includes(config.SQL_SERVER) ||
    !config.SQL_USER || !config.SQL_PASSWORD) {
    throw new Error('This command only applies the student marking migration to local SQL Server')
}

const schema = await readFile(
    new URL('./migrations/20261018-student-marking-processing.sql', import.meta.url),
    'utf8'
)
const batches = schema.split(/^\s*GO\s*$/im).map(batch => batch.trim()).filter(Boolean)
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
    console.log(`Student marking migration applied to local database ${config.SQL_DATABASE}.`)
} finally {
    await pool.close()
}
