import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getLesson,
  getStudents,
  getLessonScheme,
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
  // { scheme, ocr_text } from the backend, or null while still loading.
  // scheme is the structured selected-question object in the normal case;
  // ocr_text is only present as a fallback when there's no usable
  // structured_scheme (kept null-vs-not-yet-loaded distinct from "no
  // scheme found", which is a real state the backend can return).
  const [schemeData, setSchemeData] = useState(null)
  const [schemeError, setSchemeError] = useState(null)
  const [notFound, setNotFound] = useState(false)
  // Single switch for every level's descriptor + marks pill across every
  // AO — universal, not per-level, per the design.
  const [levelsExpanded, setLevelsExpanded] = useState(true)

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

    getLessonScheme(lessonId)
      .then(setSchemeData)
      .catch(err => setSchemeError(err.message))
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

        {schemeError ? (
          <p className="ms-ocr-error">{schemeError}</p>
        ) : schemeData === null ? (
          <p className="ms-ocr-loading">
            Loading mark scheme…
          </p>
        ) : schemeData.scheme ? (
          <div className="ms-scheme">
            <div className="ms-scheme-header">
              <span className="ms-scheme-question">
                {schemeData.scheme.question_number}
              </span>
              {(schemeData.scheme.assessment_objectives ?? []).map((ao, i) => (
                <span key={i} className="ms-scheme-ao-badge">{ao.ao}</span>
              ))}
              {schemeData.scheme.marks !== undefined && (
                <span className="ms-scheme-marks">
                  {schemeData.scheme.marks} marks
                </span>
              )}
            </div>

            {schemeData.scheme.description && (
              <p className="ms-scheme-desc">{schemeData.scheme.description}</p>
            )}

            <div className="ms-scheme-ao-list">
              {(schemeData.scheme.assessment_objectives ?? []).map((ao, i) => (
                <div key={i} className="ms-scheme-ao">
                  <div className="ms-scheme-ao-desc-row">
                    {ao.description && (
                      <p className="ms-scheme-ao-desc">{ao.description}</p>
                    )}
                    {i === 0 && (ao.bands ?? []).length > 0 && (
                      <button
                        type="button"
                        className={`ms-scheme-levels-toggle${levelsExpanded ? '' : ' is-collapsed'}`}
                        onClick={() => setLevelsExpanded(prev => !prev)}
                        aria-label={levelsExpanded ? 'Collapse levels' : 'Expand levels'}
                        title={levelsExpanded ? 'Collapse levels' : 'Expand levels'}
                      >
                        <svg
                          className="ms-scheme-levels-toggle-icon"
                          viewBox="0 0 24 24"
                          width="20"
                          height="20"
                          aria-hidden="true"
                        >
                          <polygon
                            points="7,4 20,12 7,20"
                            fill="currentColor"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </div>

                  {(ao.bands ?? []).length > 0 && (
                    <ul className="ms-scheme-bands">
                      {ao.bands.map((band, j) => (
                        <li key={j} className="ms-scheme-band">
                          <div className="ms-scheme-band-level-row">
                            <div className="ms-scheme-band-level">{band.band}</div>
                            <div className={`ms-scheme-band-marks ms-scheme-band-marks--compact${levelsExpanded ? ' is-hidden' : ''}`}>
                              <span className="ms-scheme-band-marks-num">{band.marks}</span>
                            </div>
                          </div>
                          <div className={`ms-scheme-band-collapse${levelsExpanded ? ' is-expanded' : ''}`}>
                            <div className="ms-scheme-band-collapse-inner">
                              <div className="ms-scheme-band-row">
                                <p className="ms-scheme-band-desc">{band.descriptor}</p>
                                <div className="ms-scheme-band-marks">
                                  <span className="ms-scheme-band-marks-num">{band.marks}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          // Fallback only — no structured_scheme could be extracted for
          // this lesson, so there's nothing structured to show.
          <pre className="ms-ocr-text">{schemeData.ocr_text}</pre>
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