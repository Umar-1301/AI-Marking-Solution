import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getClasses, getLessons, createLesson, reuseMarkScheme } from '../services/api'

const PROGRESS = {
  security_pass:  10,
  ai_dispatched:  10,
  ocr_file_type:  10,
  ocr_pages:      60,
  done:           10,
}

const PROGRESS_LABELS = {
  security_pass:  'Security checks passed…',
  ai_dispatched:  'Sending to OCR model…',
  ocr_file_type:  'Reading mark scheme…',
  ocr_page:       'Extracting page {index} of {total}…',
  done:           'Done',
}

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

function CollapsiblePanel({ title, isOpen, onToggle, children }) {
  return (
    <div className="home-panel">
      <button className="home-panel-header" type="button" onClick={onToggle}>
        <span className="home-panel-title">{title}</span>
        <span className={`home-panel-icon${isOpen ? ' is-open' : ''}`}>
          <PlusIcon />
        </span>
      </button>
      <div className={`home-panel-body${isOpen ? ' is-open' : ''}`}>
        <div className="home-panel-cards">
          {children}
        </div>
      </div>
    </div>
  )
}

function Home() {
  const [classes, setClasses]               = useState([])
  const [selectedClassId, setSelectedClassId] = useState('')
  const [markScheme, setMarkScheme]         = useState(null)
  const [lessons, setLessons]               = useState([])
  const [selectedLesson, setSelectedLesson] = useState(null)
  const [panel1Open, setPanel1Open]         = useState(false)
  const [panel2Open, setPanel2Open]         = useState(false)
  const [loading, setLoading]               = useState(false)
  const [progress, setProgress]             = useState(0)
  const [progressLabel, setProgressLabel]   = useState('')
  const [error, setError]                   = useState(null)
  const fileInputRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    getClasses().then(setClasses).catch(() => {})
    getLessons().then(setLessons).catch(() => {})
  }, [])

  const handleFileChange = (e) => {
    const file = e.target.files[0] ?? null
    setMarkScheme(file)
    setSelectedLesson(null)
    setError(null)
  }

  const handleSelectLesson = (lesson) => {
    setSelectedLesson(prev => prev?.id === lesson.id ? null : lesson)
    setMarkScheme(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setError(null)
  }

  const handleProgressEvent = (event, totalPagesRef) => {
    if (event.type === 'security_pass') {
      setProgress(PROGRESS.security_pass)
      setProgressLabel(PROGRESS_LABELS.security_pass)
    } else if (event.type === 'ai_dispatched') {
      setProgress(PROGRESS.security_pass + PROGRESS.ai_dispatched)
      setProgressLabel(PROGRESS_LABELS.ai_dispatched)
    } else if (event.type === 'ocr_file_type') {
      totalPagesRef.current = event.pageCount || 1
      setProgress(PROGRESS.security_pass + PROGRESS.ai_dispatched + PROGRESS.ocr_file_type)
      setProgressLabel(PROGRESS_LABELS.ocr_file_type)
    } else if (event.type === 'ocr_page') {
      const base  = PROGRESS.security_pass + PROGRESS.ai_dispatched + PROGRESS.ocr_file_type
      const total = totalPagesRef.current || event.totalPages || 1
      const ratio = event.index / total
      setProgress(Math.min(base + PROGRESS.ocr_pages * ratio, 90))
      setProgressLabel(
        PROGRESS_LABELS.ocr_page.replace('{index}', event.index).replace('{total}', total)
      )
    } else if (event.type === 'done') {
      setProgress(100)
      setProgressLabel(PROGRESS_LABELS.done)
    }
  }

  const handleBeginMarking = async () => {
    if (!selectedClassId)                   return setError('Please select a class before continuing.')
    if (!markScheme && !selectedLesson)     return setError('Please upload a mark scheme or select a previous one.')

    if (selectedLesson) {
      setLoading(true)
      setError(null)
      try {
        const result = await reuseMarkScheme(selectedLesson.id, selectedClassId)
        if (result.has_multiple_questions) {
          navigate(`/select-question/${result.id}`)
        } else {
          navigate(`/student-marking/${result.id}`)
        }
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
      return
    }

    setLoading(true)
    setError(null)
    setProgress(0)
    setProgressLabel('Running security checks…')

    const totalPagesRef = { current: 1 }
    try {
      const result = await createLesson(
        selectedClassId,
        markScheme,
        (event) => handleProgressEvent(event, totalPagesRef)
      )

      if (result.has_multiple_questions) {
        navigate(`/select-question/${result.id}`)
      } else {
        navigate(`/student-marking/${result.id}`)
      }
    } catch (err) {
      setError(err.message)
      setLoading(false)
      setProgress(0)
      setProgressLabel('')
    }
  }

  const formatDate = (iso) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="home-page">
      <div className="home-grid">

        {/* ── Left column ── */}
        <div className="home-left-col">
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
              Choose your class, upload the mark scheme, and let AIMIRA's AI do the heavy
              lifting—so you can focus on what matters most: your students.
            </p>

            <div className="home-features">
              <div className="home-feature">
                <span className="home-feature-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                Built for teachers
              </div>
              <div className="home-feature">
                <span className="home-feature-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </span>
                Secure &amp; private
              </div>
              <div className="home-feature">
                <span className="home-feature-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z" />
                  </svg>
                </span>
                AI that understands context
              </div>
            </div>
          </section>

          {lessons.length > 0 && (
            <>
              <CollapsiblePanel
                title="Previous mark schemes"
                isOpen={panel1Open}
                onToggle={() => setPanel1Open(o => !o)}
              >
                {lessons.map(l => (
                  <button
                    key={l.id}
                    type="button"
                    className={`home-panel-card${selectedLesson?.id === l.id ? ' is-selected' : ''}`}
                    onClick={() => handleSelectLesson(l)}
                  >
                    <span className="home-panel-card-title">{l.lesson_title}</span>
                    <span className="home-panel-card-sub">{l.class_name}</span>
                    <span className="home-panel-card-date">{formatDate(l.created_at)}</span>
                  </button>
                ))}
              </CollapsiblePanel>

              <CollapsiblePanel
                title="Previous marking sessions"
                isOpen={panel2Open}
                onToggle={() => setPanel2Open(o => !o)}
              >
                {lessons.map(l => (
                  <button
                    key={l.id}
                    type="button"
                    className="home-panel-card"
                    onClick={() => navigate(`/student-feedback/${l.id}`)}
                  >
                    <span className="home-panel-card-title">{l.lesson_title}</span>
                    <span className="home-panel-card-sub">{l.class_name}</span>
                    <span className="home-panel-card-date">{formatDate(l.created_at)}</span>
                  </button>
                ))}
              </CollapsiblePanel>
            </>
          )}
        </div>

        {/* ── Right column — action card ── */}
        <section className="home-action-card">
          <div className="home-action-header">
            <h2 className="home-action-title">Start a new marking session</h2>
            <span className="home-action-cap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
                <path d="M6 12v5c3 3 9 3 12 0v-5" />
              </svg>
            </span>
          </div>

          <div className="home-field">
            <label className="home-field-label">
              <span className="home-field-num">1.</span> Choose your class
            </label>
            <div className="home-select-wrap">
              <span className="home-select-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <select
                className="home-class-select"
                value={selectedClassId}
                onChange={e => { setSelectedClassId(e.target.value); setError(null) }}
              >
                <option value="">Select a class…</option>
                {classes.map(cls => (
                  <option key={cls.id} value={cls.id}>{cls.class_name}</option>
                ))}
              </select>
              <span className="home-select-chevron">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </div>
          </div>

          <div className="home-field">
            <label className="home-field-label">
              <span className="home-field-num">2.</span> Upload your mark scheme
            </label>
            <div
              className={`home-drop-zone${markScheme ? ' has-file' : ''}${selectedLesson ? ' is-dimmed' : ''}`}
              onClick={() => !selectedLesson && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              {markScheme ? (
                <div className="home-drop-selected">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{markScheme.name}</span>
                  <button
                    type="button"
                    className="home-drop-clear"
                    onClick={e => { e.stopPropagation(); setMarkScheme(null); fileInputRef.current.value = '' }}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="home-drop-prompt">
                  <span className="home-drop-cloud">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                      <polyline points="16 12 12 8 8 12" />
                      <line x1="12" y1="8" x2="12" y2="16" />
                    </svg>
                  </span>
                  <span className="home-drop-title">Drag &amp; drop your file here</span>
                  <span className="home-drop-hint">PDF or image · Max 5 MB</span>
                </div>
              )}
            </div>

            {selectedLesson && (
              <div className="home-selected-chip">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Using: <strong>{selectedLesson.lesson_title}</strong></span>
                <button
                  type="button"
                  className="home-chip-clear"
                  onClick={() => setSelectedLesson(null)}
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          <div className="home-encryption-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>Your files are encrypted and never shared.</span>
          </div>

          {error && <p className="home-error">{error}</p>}

          {loading && (
            <div className="ocr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
              <div className="ocr-progress-track">
                <div className="ocr-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="ocr-progress-meta">
                <span className="ocr-progress-label">{progressLabel}</span>
                <span className="ocr-progress-value">{Math.round(progress)}%</span>
              </div>
            </div>
          )}

          <button
            className="home-begin-btn"
            onClick={handleBeginMarking}
            disabled={loading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z" />
            </svg>
            <span>{loading ? 'Analysing mark scheme…' : 'Begin marking'}</span>
          </button>
        </section>
      </div>

      <div className="home-process-strip" aria-hidden>
        <div className="home-process-step">
          <span className="home-process-badge">1</span>
          <div className="home-process-body">
            <h3>Choose class</h3>
            <p>Select the class you want to mark for.</p>
          </div>
        </div>
        <span className="home-process-arrow">
          <svg viewBox="0 0 64 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="4 4">
            <line x1="2" y1="8" x2="56" y2="8" />
            <polyline points="50 2 60 8 50 14" strokeDasharray="0" />
          </svg>
        </span>
        <div className="home-process-step">
          <span className="home-process-badge">2</span>
          <div className="home-process-body">
            <h3>Upload mark scheme</h3>
            <p>Upload your mark scheme in PDF or image format.</p>
          </div>
        </div>
        <span className="home-process-arrow">
          <svg viewBox="0 0 64 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="4 4">
            <line x1="2" y1="8" x2="56" y2="8" />
            <polyline points="50 2 60 8 50 14" strokeDasharray="0" />
          </svg>
        </span>
        <div className="home-process-step">
          <span className="home-process-badge">3</span>
          <div className="home-process-body">
            <h3>Review results</h3>
            <p>Instant, consistent marking with clear insights.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Home
