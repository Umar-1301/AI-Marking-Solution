import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getLesson,
  getStudents,
  getLessonOcr,
  getResultPresence,
  getUploadUrl,
  uploadToBlob,
  markStudentWork,
} from '../services/api'

const CIRCUMFERENCE = 2 * Math.PI * 26

function ProgressRing({ marked, total }) {
  const progress = total > 0
    ? (marked / total) * CIRCUMFERENCE
    : 0

  return (
    <div className="progress-ring">
      <svg viewBox="0 0 60 60" className="progress-ring-svg">
        <circle
          cx="30"
          cy="30"
          r="26"
          fill="none"
          stroke="var(--border)"
          strokeWidth="4"
        />
        <circle
          cx="30"
          cy="30"
          r="26"
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
  const navigate = useNavigate()

  const [lesson, setLesson] = useState(null)
  const [students, setStudents] = useState([])
  const [ocrText, setOcrText] = useState(null)
  const [ocrError, setOcrError] = useState(null)
  const [notFound, setNotFound] = useState(false)

  // Per-student statuses:
  // uploading   — the browser is PUTting the file to Blob Storage
  // uploaded    — the Blob PUT succeeded; marking has not started
  // marking     — Blob retrieval, AI marking, and persistence are running
  // marked      — the backend confirmed the result was persisted
  // uploadError — the direct Blob upload failed
  // failed      — backend marking failed; Retry is deliberately deferred
  const [markStates, setMarkStates] = useState({})
  const [isMarkingRun, setIsMarkingRun] = useState(false)

  const fileInputRef = useRef(null)
  const pendingStudent = useRef(null)

  useEffect(() => {
    if (!lessonId) {
      navigate('/', { replace: true })
      return
    }

    getLesson(lessonId)
      .then(currentLesson => {
        setLesson(currentLesson)
        return getStudents(currentLesson.class_id)
      })
      .then(setStudents)
      .catch(() => setNotFound(true))

    getLessonOcr(lessonId)
      .then(setOcrText)
      .catch(err => setOcrError(err.message))
  }, [lessonId, navigate])

  // Restore students that already have persisted marking results.
  // Do not overwrite uploads or marking operations started in this tab.
  useEffect(() => {
    if (!lessonId || students.length === 0) return

    let cancelled = false

    Promise.all(
      students.map(student =>
        getResultPresence(lessonId, student.id)
          .then(present => ({
            studentId: student.id,
            present,
          }))
          .catch(() => ({
            studentId: student.id,
            present: false,
          }))
      )
    ).then(checks => {
      if (cancelled) return

      setMarkStates(previous => {
        const next = { ...previous }

        for (const { studentId, present } of checks) {
          if (present && next[studentId] === undefined) {
            next[studentId] = { status: 'marked' }
          }
        }

        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [lessonId, students])

  if (notFound) {
    navigate('/', { replace: true })
    return null
  }

  const markedCount = Object.values(markStates)
    .filter(state => state.status === 'marked')
    .length

  const uploadedCount = Object.values(markStates)
    .filter(state => state.status === 'uploaded')
    .length

  const handleUploadClick = studentId => {
    if (isMarkingRun || !fileInputRef.current) return

    pendingStudent.current = studentId
    fileInputRef.current.value = ''
    fileInputRef.current.click()
  }

  const handleFileSelected = async event => {
    const file = event.target.files?.[0]
    const studentId = pendingStudent.current

    pendingStudent.current = null

    if (!file || !studentId) return

    setMarkStates(previous => ({
      ...previous,
      [studentId]: { status: 'uploading' },
    }))

    try {
      const uploadUrl = await getUploadUrl(
        lessonId,
        studentId,
        file.name
      )

      await uploadToBlob(uploadUrl, file)

      // A successful PUT means only that the Blob upload completed.
      // No marking is triggered here.
      setMarkStates(previous => ({
        ...previous,
        [studentId]: { status: 'uploaded' },
      }))
    } catch (err) {
      setMarkStates(previous => ({
        ...previous,
        [studentId]: {
          status: 'uploadError',
          error: err.message,
        },
      }))
    }
  }

  const handleSubmit = async () => {
    if (isMarkingRun) return

    // Capture only students that are uploaded at the moment Submit is
    // clicked. Later uploads are not included in this marking run.
    const studentIdsToMark = students
      .map(student => student.id)
      .filter(studentId =>
        markStates[studentId]?.status === 'uploaded'
      )

    if (studentIdsToMark.length === 0) return

    setIsMarkingRun(true)

    try {
      // Process sequentially. Each student's complete Blob → AI → DB flow
      // settles before the next student's request starts.
      for (const studentId of studentIdsToMark) {
        setMarkStates(previous => ({
          ...previous,
          [studentId]: { status: 'marking' },
        }))

        try {
          await markStudentWork(lessonId, studentId)

          setMarkStates(previous => ({
            ...previous,
            [studentId]: { status: 'marked' },
          }))
        } catch (err) {
          setMarkStates(previous => ({
            ...previous,
            [studentId]: {
              status: 'failed',
              error: err.message,
            },
          }))

          // Continue processing the remaining uploaded students.
        }
      }
    } finally {
      setIsMarkingRun(false)
    }
  }

  const handleProceed = () => {
    if (isMarkingRun || markedCount === 0) return
    navigate(`/student-feedback/${lessonId}`)
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
        <button
          className="back-btn"
          onClick={() => navigate('/')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        <div className="marking-header-centre">
          <h2 className="marking-class-name">
            {lesson?.class_name ?? '…'}
          </h2>
        </div>

        <ProgressRing
          marked={markedCount}
          total={students.length}
        />
      </div>

      <div className="ms-ocr-box">
        <h3 className="ms-ocr-title">Mark Scheme</h3>

        {ocrError ? (
          <p className="ms-ocr-error">{ocrError}</p>
        ) : ocrText === null ? (
          <p className="ms-ocr-loading">
            Loading mark scheme…
          </p>
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
          <p className="student-marking-empty">
            Loading students…
          </p>
        ) : (
          students.map(student => {
            const state = markStates[student.id]
            const status = state?.status

            return (
              <div
                key={student.id}
                className="student-marking-row"
              >
                <span className="student-marking-name">
                  {student.student_name}
                </span>

                <div className="student-mark-actions">
                  {status === 'uploading' ? (
                    <span className="student-marking-feedback-placeholder">
                      Uploading…
                    </span>
                  ) : status === 'uploaded' ? (
                    <button
                      className="student-marked-tick"
                      disabled={isMarkingRun}
                      onClick={() =>
                        handleUploadClick(student.id)
                      }
                      aria-label="Uploaded — click to replace"
                      title="Uploaded — not yet marked"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  ) : status === 'marking' ? (
                    <span className="student-marking-feedback-placeholder">
                      Marking…
                    </span>
                  ) : status === 'marked' ? (
                    <span className="student-marking-feedback-placeholder">
                      Result ready
                    </span>
                  ) : status === 'uploadError' ? (
                    <div className="student-result-row">
                      <span className="student-mark-error">
                        {state.error || 'Upload failed'}
                      </span>

                      <button
                        className="student-upload-btn"
                        disabled={isMarkingRun}
                        onClick={() =>
                          handleUploadClick(student.id)
                        }
                      >
                        Retry upload
                      </button>
                    </div>
                  ) : status === 'failed' ? (
                    <div className="student-result-row">
                      <span
                        className="student-mark-error"
                        title={state.error || 'Marking failed'}
                      >
                        Failed
                      </span>

                      <button
                        className="student-upload-btn"
                        type="button"
                        disabled
                        title="Retry marking will be added in a later phase"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <button
                      className="student-upload-btn"
                      disabled={isMarkingRun}
                      onClick={() =>
                        handleUploadClick(student.id)
                      }
                    >
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
        disabled={isMarkingRun || uploadedCount === 0}
        onClick={handleSubmit}
      >
        {isMarkingRun ? 'Marking…' : 'Submit'}
      </button>

      {!isMarkingRun && markedCount > 0 && (
        <button
          className="marking-submit-btn"
          type="button"
          onClick={handleProceed}
        >
          Proceed
        </button>
      )}
    </div>
  )
}

export default StudentMarking