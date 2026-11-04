import FormData from 'form-data'
import fetch from 'node-fetch'

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000'

export async function getMarkFromAIWithSchemeText(
    studentWorkFile,
    schemeText,
    threadExtraction = '',
    { signal, deadlineAt, jobId, attemptId } = {}
) {
    const form = new FormData()
    form.append('student_work', studentWorkFile.buffer, {
        filename: studentWorkFile.originalname,
        contentType: studentWorkFile.mimetype,
    })
    form.append('scheme_text', schemeText)
    form.append('thread_extraction', threadExtraction)

    let response
    try {
        response = await fetch(`${AI_SERVICE_URL}/mark-with-scheme-text`, {
            method: 'POST',
            body: form,
            headers: {
                ...form.getHeaders(),
                ...(deadlineAt ? { 'X-Student-Marking-Deadline': new Date(deadlineAt).toISOString() } : {}),
                ...(jobId ? { 'X-Student-Marking-Job-Id': jobId } : {}),
                ...(attemptId ? { 'X-Student-Marking-Attempt-Id': attemptId } : {}),
            },
            signal,
        })
    } catch (fetchErr) {
        if (signal?.aborted) throw signal.reason ?? fetchErr
        const err = new Error('AI service unreachable')
        err.aiStatus = null
        err.aiErrorCode = fetchErr.code ?? 'FETCH_ERROR'
        err.aiBody = fetchErr.message
        throw err
    }

    if (!response.ok) {
        let body = ''
        try { body = await response.text() } catch (_) {}
        const err = new Error(`AI service returned HTTP ${response.status}`)
        err.aiStatus = response.status
        err.aiErrorCode = `HTTP_${response.status}`
        err.aiBody = body.slice(0, 300)
        throw err
    }

    return response.json()
}

async function postBatchForm(path, form, { signal, deadlineAt } = {}) {
    let response
    try {
        response = await fetch(`${AI_SERVICE_URL}${path}`, {
            method: 'POST', body: form,
            headers: {
                ...form.getHeaders(),
                ...(deadlineAt ? {
                    'X-Student-Marking-Deadline': new Date(deadlineAt).toISOString(),
                } : {}),
            },
            signal,
        })
    } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        throw new Error(`AI service request failed: ${err.message}`)
    }
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`AI service ${path} returned HTTP ${response.status}: ${detail}`)
    }
    return response.json()
}

export async function getStudentOcrBatch(entries, options = {}) {
    const form = new FormData()
    for (const { job, file } of entries) {
        form.append('student_works', file.buffer, {
            filename: file.originalname, contentType: file.mimetype,
        })
        form.append('slot_keys', job.jobId)
    }
    return postBatchForm('/student-ocr-batch', form, options)
}

export async function getStudentOcrPdf(chunk, options = {}) {
    const form = new FormData()
    form.append('batch_pdf', chunk.buffer, {
        filename: 'student-batch.pdf', contentType: 'application/pdf',
    })
    for (const page of chunk.pages) {
        form.append('page_keys', page.key)
        form.append('source_names', page.sourceName)
    }
    return postBatchForm('/student-ocr-pdf-batch', form, options)
}

export async function getMarkFromOcrText(
    studentOcrText, schemeText, threadExtraction, options = {}
) {
    const form = new FormData()
    form.append('student_ocr_text', studentOcrText)
    form.append('scheme_text', schemeText)
    form.append('thread_extraction', threadExtraction)
    return postBatchForm('/mark-with-ocr-text', form, options)
}
