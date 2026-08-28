// Entry point for the worker service. Standalone from backend/ (its own
// package.json and node_modules — see workers/package/) — and subscribes
// to the marking queue on boot for retrieval. Sending to that queue is the
// backend's concern, not this service's.
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { logWorkerStart, logInfo, LOG_DIR } from './logging/workerLogger.js'
import { startMarkingWorker } from './markingWorker.js'
import { poolConnect } from './SQL/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4000

const app = express()

app.use(express.static(path.join(__dirname, 'public')))

// GET /api/logs — today's log file as plain text. Polling, not a live
// stream (the frontend re-fetches this on an interval) — sufficient for
// local troubleshooting without adding a WebSocket/SSE layer this early.
app.get('/api/logs', (req, res) => {
    const today = new Date().toISOString().slice(0, 10)
    const logFile = path.join(LOG_DIR, `worker-${today}.log`)

    if (!fs.existsSync(logFile)) {
        return res.type('text/plain').send('No log entries yet today.')
    }

    res.type('text/plain').send(fs.readFileSync(logFile, 'utf8'))
})

// Fail fast before receiving queue messages if SQL is unavailable. This keeps
// a broken worker from accepting work that it cannot eventually persist.
try {
    await poolConnect
    logInfo('Connected to SQL database.')

    app.listen(PORT, () => {
        logWorkerStart(PORT)
        console.log(`Worker service listening on http://localhost:${PORT}`)
        startMarkingWorker()
    })
} catch (err) {
    console.error('Failed to connect to the database:', err.message)
    process.exit(1)
}
