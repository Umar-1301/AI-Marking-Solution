import FormData from 'form-data'
import fetch from 'node-fetch'
import config from '../config/index.js'

function logThreadExtraction(stage, payload) {
    console.log(`\n[THREAD EXTRACTION][BACKEND] ${stage}`)
    console.log(JSON.stringify(payload, null, 2))
}

// POST /ocr — single-file OCR only, no marking.
// Used for mark scheme processing at lesson start (first in the marking queue).
// Returns { text, structured_scheme, thread_scheme } from the Python service.
export async function getOcrFromAI(file) {
    const form = new FormData()
    form.append('file', file.buffer, {
        filename:    file.originalname,
        contentType: file.mimetype,
    })

    logThreadExtraction('Sending mark scheme to AI service', {
        endpoint: `${config.AI_SERVICE_URL}/ocr`,
        filename: file.originalname,
        mimetype: file.mimetype,
        bytes: file.size,
    })

    let response
    try {
        response = await fetch(`${config.AI_SERVICE_URL}/ocr`, {
            method:  'POST',
            body:    form,
            headers: form.getHeaders(),
        })
    } catch (fetchErr) {
        const err = new Error('AI service unreachable')
        err.aiStatus    = null
        err.aiErrorCode = fetchErr.code ?? 'FETCH_ERROR'
        err.aiBody      = fetchErr.message
        throw err
    }

    if (!response.ok) {
        let body = ''
        try { body = await response.text() } catch (_) {}
        const err = new Error(`AI service returned HTTP ${response.status}`)
        err.aiStatus    = response.status
        err.aiErrorCode = `HTTP_${response.status}`
        err.aiBody      = body.slice(0, 300)
        throw err
    }

    const result = await response.json()
    logThreadExtraction('Received AI-service response', {
        response_keys: Object.keys(result),
        thread_scheme: result.thread_scheme ?? null,
    })

    return {
        ...result,
        thread_scheme: result.thread_scheme ?? null,
    }
}

// POST /mark-with-scheme-text — mark one student's work against an
// already-extracted mark scheme (avoids re-OCRing/re-extracting the scheme
// on every student). Returns the raw AI-service response as-is — callers
// (lessons.js) currently pass this straight through with no allowlist or
// re-validation step.
export async function getMarkFromAIWithSchemeText(
    studentWorkFile,
    schemeText,
    threadExtraction = '',
    question = ''
) {
    const form = new FormData()
    form.append('student_work', studentWorkFile.buffer, {
        filename:    studentWorkFile.originalname,
        contentType: studentWorkFile.mimetype,
    })
    form.append('scheme_text', schemeText)
    form.append('thread_extraction', threadExtraction)
    form.append('question',    question)

    let response
    try {
        response = await fetch(`${config.AI_SERVICE_URL}/mark-with-scheme-text`, {
            method:  'POST',
            body:    form,
            headers: form.getHeaders(),
        })
    } catch (fetchErr) {
        const err = new Error('AI service unreachable')
        err.aiStatus    = null
        err.aiErrorCode = fetchErr.code ?? 'FETCH_ERROR'
        err.aiBody      = fetchErr.message
        throw err
    }

    if (!response.ok) {
        let body = ''
        try { body = await response.text() } catch (_) {}
        const err = new Error(`AI service returned HTTP ${response.status}`)
        err.aiStatus    = response.status
        err.aiErrorCode = `HTTP_${response.status}`
        err.aiBody      = body.slice(0, 300)
        throw err
    }

    return response.json()
}
