// Relative path — resolves against whatever origin served the frontend.
// In dev, Vite's server.proxy forwards /api to the backend (see vite.config.js).
// In production, the gateway/nginx routes /api to the backend container.
const API_BASE = '/api'

export async function getClasses() {
    const response = await fetch(`${API_BASE}/classes`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to fetch classes')
    return data
}

export async function getStudents(classId) {
    const response = await fetch(`${API_BASE}/classes/${classId}/students`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to fetch students')
    return data
}

export async function getLessons() {
    const response = await fetch(`${API_BASE}/lessons`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to fetch lessons')
    return data
}

export async function getLesson(lessonId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Lesson not found')
    return data
}

export async function getLessonOcr(lessonId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/ocr`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to load mark scheme')
    return data.ocr_text
}

export async function getLessonQuestions(lessonId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/questions`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to load questions')
    return data
}

// onEvent(event) fires for each streamed progress event:
//   { type: 'security_pass' }
//   { type: 'ai_dispatched' }
//   { type: 'ocr_file_type', fileType, pageCount }
//   { type: 'ocr_page', index, totalPages }
//   { type: 'done', data: { id, class_id, class_name, paper_type, questions } }
//   { type: 'error', message, detail, code, status }
export async function createLesson(classId, markSchemeFile, onEvent = () => { }) {
    const formData = new FormData()
    formData.append('markScheme', markSchemeFile)
    formData.append('classId', classId)

    const response = await fetch(`${API_BASE}/lessons`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
    })

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('ndjson')) {
        if (contentType.includes('json')) {
            const data = await response.json()
            throw new Error(data.error || 'Failed to create lesson')
        }
        throw new Error(`Server error (${response.status}) — is the backend running?`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result = null

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            onEvent(event)
            if (event.type === 'done') result = event.data
            if (event.type === 'error') throw new Error(event.message)
        }
    }

    if (!result) throw new Error('Lesson creation did not complete')
    return result
}

// Clones a previous lesson's already-extracted mark scheme into a new lesson
// for the given class — no re-OCR. Returns the same shape createLesson's
// streamed 'done' event does, so callers can branch on has_multiple_questions
// identically either way.
export async function reuseMarkScheme(sourceLessonId, classId) {
    const response = await fetch(`${API_BASE}/lessons/${sourceLessonId}/reuse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ classId }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to reuse mark scheme')
    return data
}

export async function selectQuestion(lessonId, selectedQuestionIndex) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/select-question`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selectedQuestionIndex }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to select question')
    return data
}

// Presence-only check — true/false, never the result content. Used to
// restore tick state on page load without pulling the full grade payload.
export async function getResultPresence(lessonId, studentId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/result_presence/${studentId}`, {
        credentials: 'include',
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to check result status')
    return data.present
}

export async function getMarkingResults(lessonId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/results`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to fetch results')
    return data.results
}

// Requests a short-lived, write-only SAS URL scoped to one student's blob
// path — the file itself is never sent to our backend, only its name.
export async function getUploadUrl(lessonId, studentId, fileName) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/students/${studentId}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ fileName }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to get upload URL')
    return data.uploadUrl
}

// PUTs straight to blob storage using the SAS URL above — bypasses our own
// backend entirely for the file bytes. Not our API, so no API_BASE and no
// credentials (auth is the SAS query string itself, not our session
// cookie). x-ms-blob-type is required by the Blob REST API for a block
// blob PUT.
export async function uploadToBlob(uploadUrl, file) {
    const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': file.type,
        },
        body: file,
    })
    if (!response.ok) throw new Error(`Blob upload failed (${response.status})`)

    // Browser-console only — there's no frontend logging pipeline in this
    // app, and this PUT goes straight to Azure, bypassing our backend
    // entirely, so no server-side log can see this event at all. If this
    // ever needs to be durable (queryable, retained), it'd need to be
    // reported back to the backend as its own call.
    console.info(`[blob] uploaded ${file.name} (${file.size} bytes)`)
}

// Triggers marking for work already stored in Blob Storage.
// Only identifiers cross this request; teacherId comes from the JWT cookie.
export async function markStudentWork(lessonId, studentId) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/mark-student`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ studentId }),
    })

    if (response.status === 401) {
        throw new Error('Your session has expired. Please log in again.')
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
        throw new Error(`Server error (${response.status}) — is the backend running?`)
    }

    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to mark student work')
    return data
}

export async function createClass(className, students) {
    const response = await fetch(`${API_BASE}/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ className, students }),
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
        throw new Error(`Server error (${response.status}) — is the backend running?`)
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to create class')
    return data
}

export async function renameClass(classId, className) {
    const response = await fetch(`${API_BASE}/classes/${classId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ class_name: className }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to rename class')
    return data
}

export async function addStudentToClass(classId, studentName) {
    const response = await fetch(`${API_BASE}/classes/${classId}/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ student_name: studentName }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to add student')
    return data
}

export async function renameStudent(classId, studentId, studentName) {
    const response = await fetch(`${API_BASE}/classes/${classId}/students/${studentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ student_name: studentName }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to rename student')
    return data
}

export async function deleteStudent(classId, studentId) {
    const response = await fetch(`${API_BASE}/classes/${classId}/students/${studentId}`, {
        method: 'DELETE',
        credentials: 'include',
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Failed to delete student')
    return data
}

// credentials: 'include' is required on every request so the browser
// attaches the httpOnly aimira_token cookie automatically.
// The token never touches JavaScript — it is set and cleared by the backend.

export async function refreshSession() {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
    })
    if (!response.ok) return null
    return response.json()
}

