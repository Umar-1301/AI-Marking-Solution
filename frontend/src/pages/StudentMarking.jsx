import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getLesson, getStudents, getLessonOcr,
  getResultPresence, submitStudentWork,
} from '../services/api'

const CIRCUMFERENCE = 2 * Math.PI * 26 // r=26 → ≈163.4

function ProgressRing({ marked, total }) {
  const progress = total > 0 ? (marked / total) * CIRCUMFERENCE : 0

  return (
    <div className="progress-ring">
      <svg viewBox="0 0 60 60" className="progress-ring-svg">
        <circle cx="30" cy="30" r="26" fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle
          cx="30" cy="30" r="26"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${CIRCUMFERENCE}`}
          transform="rotate(-90 30 30)"
        />
      </svg>
      <div className="progress-ring-label">
        <span className="progress-ring-count">{marked}</span>
        <span className="progress-ring-sep">/</span>
        <span className="progress-ring-total">{total}</span>
      </div>
    </div>
  )
}

function StudentMarking() {
  const { lessonId } = useParams()
  const navigate     = useNavigate()

  const [lesson,   setLesson]   = useState(null)
  const [students, setStudents] = useState([])
  const [ocrText,  setOcrText]  = useState(null)
  const [ocrError, setOcrError] = useState(null)
  const [notFound, setNotFound] = useState(false)

  // { [studentId]: { status: 'marking'|'done'|'error', error? } }
  // In-memory only, for this page visit — the actual result is persisted
  // server-side and intentionally not read back here. See StudentFeedback.
  const [markStates, setMarkStates] = useState({})

  const fileInputRef   = useRef(null)
  const pendingStudent = useRef(null)

  // Fetch lesson metadata first, then use its class_id to fetch students.
  // Both lesson and OCR fetches fire immediately since both only need lessonId.
  // DB-backed from lessonId alone (not passed via router state) so this page
  // works from a direct visit or a refresh, not just immediately after
  // navigating here from Home.
  useEffect(() => {
    if (!lessonId) { navigate('/', { replace: true }); return }

    getLesson(lessonId)
      .then(l => {
        setLesson(l)
        return getStudents(l.class_id)
      })
      .then(setStudents)
      .catch(() => setNotFound(true))

    getLessonOcr(lessonId)
      .then(setOcrText)
      .catch(err => setOcrError(err.message))
  }, [lessonId])

  // On load/refresh, restore tick state by checking presence only — never
  // fetches the result itself (see result_presence route). Guards against
  // clobbering a student already mid-upload in this same tab.
  useEffect(() => {
    if (!lessonId || students.length === 0) return
    let cancelled = false

    Promise.all(students.map(s =>
      getResultPresence(lessonId, s.id)
        .then(present => ({ studentId: s.id, present }))
        .catch(() => ({ studentId: s.id, present: false }))
    )).then(checks => {
      if (cancelled) return
      setMarkStates(prev => {
        const next = { ...prev }
        for (const { studentId, present } of checks) {
          if (present && next[studentId]?.status !== 'marking') {
            next[studentId] = { status: 'done' }
          }
        }
        return next
      })
    })

    return () => { cancelled = true }
  }, [lessonId, students])

  if (notFound) {
    navigate('/', { replace: true })
    return null
  }

  const markedCount = Object.values(markStates).filter(s => s.status === 'done').length

  const handleUploadClick = (studentId) => {
    pendingStudent.current = studentId
    fileInputRef.current.value = ''
    fileInputRef.current.click()
  }

  const handleFileSelected = async (e) => {
    const file      = e.target.files[0]
    const studentId = pendingStudent.current
    if (!file || !studentId) return

    setMarkStates(prev => ({ ...prev, [studentId]: { status: 'marking' } }))

    try {
      // The marked result is persisted server-side and intentionally not
      // read back here — { ok: true } is the only signal this page needs.
      await submitStudentWork(lessonId, studentId, file)
      setMarkStates(prev => ({ ...prev, [studentId]: { status: 'done' } }))
    } catch (err) {
      setMarkStates(prev => ({ ...prev, [studentId]: { status: 'error', error: err.message } }))
    }
  }

  return (
    <div className="page">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.heic,.heif,.pdf"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <div className="marking-header">
        <button className="back-btn" onClick={() => navigate('/')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        <div className="marking-header-centre">
          <h2 className="marking-class-name">{lesson?.class_name ?? '…'}</h2>
        </div>

        <ProgressRing marked={markedCount} total={students.length} />
      </div>

      <div className="ms-ocr-box">
        <h3 className="ms-ocr-title">Mark Scheme</h3>
        {ocrError ? (
          <p className="ms-ocr-error">{ocrError}</p>
        ) : ocrText === null ? (
          <p className="ms-ocr-loading">Loading mark scheme…</p>
        ) : (
          <pre className="ms-ocr-text">{ocrText}</pre>
        )}
      </div>

      <div className="student-marking-list">
        <div className="student-marking-header-row">
          <span>Student</span>
          <span>Result</span>
        </div>

        {students.length === 0 ? (
          <p className="student-marking-empty">Loading students…</p>
        ) : (
          students.map(s => {
            const st     = markStates[s.id]
            const status = st?.status

            return (
              <div key={s.id} className="student-marking-row">
                <span className="student-marking-name">{s.student_name}</span>

                <div className="student-mark-actions">
                  {status === 'marking' ? (
                    <span className="student-marking-feedback-placeholder">Marking…</span>
                  ) : status === 'done' ? (
                    <button
                      className="student-marked-tick"
                      onClick={() => handleUploadClick(s.id)}
                      aria-label="Marked — click to re-mark"
                      title="Marked — click to re-mark"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  ) : status === 'error' ? (
                    <div className="student-result-row">
                      <span className="student-mark-error">{st.error || 'Marking failed'}</span>
                      <button className="student-upload-btn" onClick={() => handleUploadClick(s.id)}>
                        Retry
                      </button>
                    </div>
                  ) : (
                    <button className="student-upload-btn" onClick={() => handleUploadClick(s.id)}>
                      Upload work
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <button
        className="marking-submit-btn"
        disabled={markedCount === 0}
        onClick={() => navigate(`/student-feedback/${lessonId}`)}
      >
        Submit
      </button>
    </div>
  )
}

export default StudentMarking
