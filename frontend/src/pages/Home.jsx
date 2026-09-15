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

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const SchemeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
)

const SessionIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)

// Sidebar nav rail item — a persistent, expandable, icon-labelled entry.
// Distinct from a plain accordion: it's meant to read as page navigation
// (active/expanded state gets a left accent bar + filled icon), not just a
// collapsible content block.
function SidebarNavItem({ icon, title, isOpen, onToggle, hasItems, emptyText, children }) {
  return (
    <div className="home-navitem">
      <button
        type="button"
        className={`home-navitem-head${isOpen ? ' is-expanded' : ''}`}
        onClick={onToggle}
      >
        <span className="home-navitem-icon">{icon}</span>
        <span className="home-navitem-label">{title}</span>
        <span className={`home-navitem-chevron${isOpen ? ' is-expanded' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      <div className={`home-navitem-body${isOpen ? ' is-expanded' : ''}`}>
        {hasItems ? children : <p className="home-navitem-empty">{emptyText}</p>}
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
      <div className="home-shell">

        {/* ── Sidebar nav rail — persistent, page-contextual ── */}
        <aside className="home-sidebar">
          <SidebarNavItem
            icon={<SchemeIcon />}
            title="Previous mark schemes"
            isOpen={panel1Open}
            onToggle={() => setPanel1Open(o => !o)}
            hasItems={lessons.length > 0}
            emptyText="No mark schemes yet"
          >
            {lessons.map(l => (
              <button
                key={l.id}
                type="button"
                className={`home-navitem-card${selectedLesson?.id === l.id ? ' is-selected' : ''}`}
                onClick={() => handleSelectLesson(l)}
              >
                <span className="home-navitem-card-title">{l.lesson_title}</span>
                <span className="home-navitem-card-sub">{l.class_name}</span>
                <span className="home-navitem-card-date">{formatDate(l.created_at)}</span>
              </button>
            ))}
          </SidebarNavItem>

          <SidebarNavItem
            icon={<SessionIcon />}
            title="Previous marking sessions"
            isOpen={panel2Open}
            onToggle={() => setPanel2Open(o => !o)}
            hasItems={lessons.length > 0}
            emptyText="No marking sessions yet"
          >
            {lessons.map(l => (
              <button
                key={l.id}
                type="button"
                className="home-navitem-card"
                onClick={() => navigate(`/student-feedback/${l.id}`)}
              >
                <span className="home-navitem-card-title">{l.lesson_title}</span>
                <span className="home-navitem-card-sub">{l.class_name}</span>
                <span className="home-navitem-card-date">{formatDate(l.created_at)}</span>
              </button>
            ))}
          </SidebarNavItem>
        </aside>

        {/* ── Main pane — hero, action card, process strip ── */}
        <main className="home-main">
          <div className="home-process-track" aria-hidden>
            <h3 className="home-process-heading home-process-h1">Choose class</h3>
            <h3 className="home-process-heading home-process-h2">Upload mark scheme</h3>
            <h3 className="home-process-heading home-process-h3">Review results</h3>

            <span className="home-process-node home-process-b1"><span className="home-process-badge">1</span></span>
            <span className="home-process-node home-process-b2"><span className="home-process-badge">2</span></span>
            <span className="home-process-node home-process-b3"><span className="home-process-badge">3</span></span>
          </div>

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
        </main>
      </div>
    </div>
  )
}

export default Home
