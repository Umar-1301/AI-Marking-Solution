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
export async function createLesson(classId, markSchemeFile, onEvent = () => {}) {
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

    const reader  = response.body.getReader()
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
            if (event.type === 'done')  result = event.data
            if (event.type === 'error') throw new Error(event.message)
        }
    }

    if (!result) throw new Error('Lesson creation did not complete')
    return result
}

export async function selectQuestion(lessonId, selectedQuestionIndex) {
    const response = await fetch(`${API_BASE}/lessons/${lessonId}/select-question`, {
        method:  'PATCH',
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

// Plain request/response — the backend route only ever returns one terminal
// result (never intermediate progress), and the caller re-fetches the actual
// result from GET /results afterward rather than trust this response's
// payload directly. See refreshResults() in StudentMarking.jsx.
export async function submitStudentWork(lessonId, studentId, studentWorkFile) {
    const formData = new FormData()
    formData.append('studentWork', studentWorkFile)
    formData.append('studentId', String(studentId))

    const response = await fetch(`${API_BASE}/lessons/${lessonId}/mark-student`, {
        method:      'POST',
        credentials: 'include',
        body:        formData,
    })

    if (response.status === 401) throw new Error('Your session has expired. Please sign in again.')

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
        throw new Error(`Server error (${response.status}) — is the backend running?`)
    }

    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Marking failed')
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

