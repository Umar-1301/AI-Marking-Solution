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
