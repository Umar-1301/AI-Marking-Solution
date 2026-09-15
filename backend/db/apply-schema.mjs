// Applies schema.sql to a local SQL Server instance (the docker-compose mssql
// container) — the local-dev equivalent of the manual step described at the
// top of schema.sql for Azure, which the app itself never runs there.
//
// Uses the same `mssql` package the app connects with, not a separate tool
// (sqlcmd) — nothing extra to install, and no risk of it parsing T-SQL any
// differently than the app does.
//
// GO is not real T-SQL — it's a client-side batch separator that tools like
// sqlcmd/SSMS parse and split on before sending each batch to the server
// separately. The mssql package's .batch() does NOT do this splitting for
// you; sending the whole file (with literal "GO" lines in it) as one batch
// fails with a syntax error the first time the server hits a GO line. So
// schema.sql is split on GO here, the same way sqlcmd would, and each
// resulting batch is executed in order.
//
// Run after `docker compose up -d mssql`:
//     npm run db:init
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sql from 'mssql'
import config from '../src/config/index.js'

if (!config.SQL_USER || !config.SQL_PASSWORD) {
    throw new Error(
        'SQL_USER/SQL_PASSWORD are not set. This script is for the local ' +
        'docker-compose SQL Server container only, never for Azure — set ' +
        'them in .env first (see .env.example).'
    )
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

// GO must stand alone on its line (the standard convention) — this avoids
// splitting on the word appearing incidentally inside a string or comment.
const batches = schemaSql
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

const baseConfig = {
    server:   config.SQL_SERVER,
    user:     config.SQL_USER,
    password: config.SQL_PASSWORD,
    options: {
        encrypt: true,
        // The container's TLS cert is self-signed — there's no CA to
        // validate it against locally, unlike Azure SQL's real certificate.
        trustServerCertificate: true,
    },
}

async function runBatches(pool, statements) {
    for (const statement of statements) {
        await pool.request().batch(statement);
    }
}

async function main() {
    // Connect to master first — unlike Azure SQL, where the database itself
    // is the resource you provision, a fresh SQL Server instance only has
    // its system databases until one is created explicitly.
    const masterPool = await new sql.ConnectionPool({ ...baseConfig, database: 'master' }).connect()
    await runBatches(masterPool, [
        `IF DB_ID(N'${config.SQL_DATABASE}') IS NULL CREATE DATABASE [${config.SQL_DATABASE}];`,
    ])
    await masterPool.close()

    const dbPool = await new sql.ConnectionPool({ ...baseConfig, database: config.SQL_DATABASE }).connect()
    await runBatches(dbPool, batches)
    await dbPool.close()

    console.log(`Schema applied to ${config.SQL_DATABASE} on ${config.SQL_SERVER} (${batches.length} batches).`)
}

main().catch((err) => {
    console.error('Failed to apply schema:', err)
    process.exit(1)
})
