import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getLessonQuestions, selectQuestion } from '../services/api'

// Its own route (not state on Home) so it's DB-backed and refresh-safe: the
// only thing it needs is lessonId from the URL, then it reads the stored
// structured_scheme back via GET /lessons/:id/questions — the same "central
// fetcher" read path used elsewhere, rather than trusting a one-time stream.
function SelectQuestion() {
  const { lessonId } = useParams()
  const navigate = useNavigate()

  const [questions, setQuestions] = useState(null)
  const [error, setError] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [pickingQuestion, setPickingQuestion] = useState(false)

  useEffect(() => {
    if (!lessonId) { navigate('/', { replace: true }); return }

    getLessonQuestions(lessonId)
      .then(data => setQuestions(data.questions ?? []))
      .catch(() => setNotFound(true))
  }, [lessonId])

  if (notFound) {
    navigate('/', { replace: true })
    return null
  }

  const handleSelectQuestion = async (index) => {
    if (pickingQuestion) return
    setPickingQuestion(true)
    try {
      await selectQuestion(lessonId, index)
      navigate(`/student-marking/${lessonId}`)
    } catch (err) {
      setError(err.message)
      setPickingQuestion(false)
    }
  }

  return (
    <div className="home-page">
      <div className="home-grid">
        <section className="home-marketing">
          <div className="home-eyebrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            AI-POWERED ASSISTANT
          </div>

          <h1 className="home-title">
            Smarter marking,<br />
            <span className="home-title-accent">better outcomes.</span>
          </h1>

          <p className="home-description">
            Choose your class, upload the mark scheme, and let KLASSIO's AI do the heavy
            lifting—so you can focus on what matters most: your students.
          </p>
        </section>

        <section className="home-action-card">
          <div className="home-action-header">
            <h2 className="home-action-title">Which question are you marking?</h2>
          </div>

          {questions === null ? (
            <p className="question-picker-hint">Loading questions…</p>
          ) : (
            <>
              <p className="question-picker-hint">
                We found {questions.length} questions in this mark scheme.
                Select the one your students answered.
              </p>
              {error && <p className="home-error">{error}</p>}
              <div className="question-picker-grid">
                {questions.map((q, i) => (
                  <button
                    key={i}
                    className={`question-card${pickingQuestion ? ' question-card--disabled' : ''}`}
                    onClick={() => handleSelectQuestion(i)}
                    disabled={pickingQuestion}
                  >
                    <span className="question-card-number">{q.question_number}</span>
                    <span className="question-card-desc">{q.description}</span>
                    <span className="question-card-marks">{q.marks} marks</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

export default SelectQuestion
