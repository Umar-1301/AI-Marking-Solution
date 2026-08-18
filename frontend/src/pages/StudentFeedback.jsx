import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getLesson, getStudents, getMarkingResults } from '../services/api'
import ResultCard from '../components/ResultCard'
import AnnotatedEssay from '../components/AnnotatedEssay'

function StudentFeedback() {
  const { lessonId } = useParams()
  const navigate      = useNavigate()

  const [lesson,   setLesson]   = useState(null)
  const [students, setStudents] = useState([])
  const [results,        setResults]        = useState([])
  const [resultsLoading, setResultsLoading] = useState(true)
  const [resultsError,   setResultsError]   = useState(null)
  const [notFound,       setNotFound]       = useState(false)
  const [expanded, setExpanded] = useState({})

  // Same direct-visit/refresh pattern as StudentMarking: re-derive everything
  // from lessonId alone rather than trusting router state.
  useEffect(() => {
    if (!lessonId) { navigate('/', { replace: true }); return }

    getLesson(lessonId)
      .then(l => {
        setLesson(l)
        return getStudents(l.class_id)
      })
      .then(setStudents)
      .catch(() => setNotFound(true))

    // /results only ever returns rows that have actually been marked — this
    // page shows exactly that set, nothing invented for unmarked students.
    // A fetch failure is surfaced explicitly rather than shown as "no
    // results" — those are different states and shouldn't look the same.
    getMarkingResults(lessonId)
      .then(setResults)
      .catch(err => setResultsError(err.message))
      .finally(() => setResultsLoading(false))
  }, [lessonId, navigate])

  if (notFound) {
    navigate('/', { replace: true })
    return null
  }

  const nameFor = (studentId) =>
    students.find(s => s.id === studentId)?.student_name ?? `Student #${studentId}`

  const toggleExpanded = (studentId) =>
    setExpanded(prev => ({ ...prev, [studentId]: !prev[studentId] }))

  return (
    <div className="page">
      <div className="marking-header">
        <button className="back-btn" onClick={() => navigate(`/student-marking/${lessonId}`)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        <div className="marking-header-centre">
          <h2 className="marking-class-name">{lesson?.class_name ?? '…'} — Feedback</h2>
        </div>
      </div>

      <div className="student-marking-list">
        <div className="student-marking-header-row">
          <span>Student</span>
          <span>Result</span>
        </div>

        {resultsError ? (
          <p className="ms-ocr-error">{resultsError}</p>
        ) : resultsLoading ? (
          <p className="ms-ocr-loading">Loading results…</p>
        ) : results.length === 0 ? (
          <p className="student-marking-empty">No marked work yet.</p>
        ) : (
          results.map(r => {
            const isExpanded = expanded[r.studentId]

            return (
              <div key={r.studentId} className="student-marking-row">
                <span className="student-marking-name">{nameFor(r.studentId)}</span>

                <div className="student-mark-actions">
                  <div className="student-result-row">
                    <span className="student-result-score">
                      {r.result.score}/{r.result.maxScore}
                    </span>
                    <button className="student-expand-btn" onClick={() => toggleExpanded(r.studentId)}>
                      {isExpanded ? 'Hide' : 'View feedback'}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="student-result-expanded">
                    <ResultCard result={r.result} />
                    {r.result.studentOcrText && r.result.annotations?.length > 0 && (
                      <AnnotatedEssay
                        text={r.result.studentOcrText}
                        annotations={r.result.annotations}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default StudentFeedback
