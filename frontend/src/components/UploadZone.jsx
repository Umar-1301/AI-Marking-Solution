import { useState, useRef, useEffect } from 'react'

const IS_DEV = import.meta.env.DEV

// ─── File validation ───────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024  // 5 MB
const MAX_PDF_PAGES = 30

const EXT_MIME = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf:  'application/pdf',
}

// Counts PDF pages by scanning for /Count N entries in the raw bytes.
// Returns null if the structure is unreadable (compressed streams) — backend catches it.
async function getPdfPageCount(file) {
  const buf = await file.arrayBuffer()
  const text = new TextDecoder('latin1').decode(new Uint8Array(buf))
  const matches = [...text.matchAll(/\/Count\s+(\d+)/g)]
  if (!matches.length) return null
  return Math.max(...matches.map(m => parseInt(m[1], 10)))
}

async function readMagicBytes(file) {
  const buf = await file.slice(0, 12).arrayBuffer()
  return new Uint8Array(buf)
}

function detectMime(b) {
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand === 'heic' || brand === 'heix') return 'image/heic'
    if (brand === 'mif1' || brand === 'msf1') return 'image/heif'
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'
  return null
}

// Returns { error: string|null, log: entry[] }
// log entries: { check, status: 'pass'|'fail', detail }
async function validateFile(file) {
  const log = []
  const mb = (file.size / (1024 * 1024)).toFixed(2)

  // 1. Size
  if (file.size > MAX_BYTES) {
    log.push({ check: 'size', status: 'fail', detail: `${mb} MB — exceeds 5 MB limit` })
    return { error: `File is ${mb} MB — must be under 5 MB`, log }
  }
  log.push({ check: 'size', status: 'pass', detail: `${mb} MB` })

  // 2. Extension
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mimeByExt = EXT_MIME[ext]
  if (!mimeByExt) {
    log.push({ check: 'extension', status: 'fail', detail: `.${ext || '(none)'} not in allowlist` })
    return { error: 'Only JPEG, PNG, WebP, HEIC, and PDF files are accepted', log }
  }
  log.push({ check: 'extension', status: 'pass', detail: `.${ext} → ${mimeByExt}` })

  // 3. Magic bytes
  const bytes = await readMagicBytes(file)
  const detectedMime = detectMime(bytes)
  if (!detectedMime) {
    log.push({ check: 'magic bytes', status: 'fail', detail: 'unrecognised file signature' })
    return { error: 'File content could not be verified — only JPEG, PNG, WebP, HEIC, and PDF are accepted', log }
  }
  log.push({ check: 'magic bytes', status: 'pass', detail: `detected ${detectedMime}` })

  // 4. Extension vs content mismatch
  if (mimeByExt !== detectedMime) {
    log.push({ check: 'content match', status: 'fail', detail: `declared ${mimeByExt} ≠ detected ${detectedMime}` })
    return { error: 'File extension does not match its content', log }
  }
  log.push({ check: 'content match', status: 'pass', detail: `${detectedMime} consistent` })

  // 5. PDF page count — not logged to the debug panel, backend logs it definitively
  if (detectedMime === 'application/pdf') {
    const pageCount = await getPdfPageCount(file)
    if (pageCount !== null && pageCount > MAX_PDF_PAGES) {
      return { error: `PDF has ${pageCount} pages — maximum allowed is ${MAX_PDF_PAGES}`, log }
    }
  }

  return { error: null, log }
}

// ─── DebugPanel ───────────────────────────────────────────────────────────────

function DebugPanel({ entries }) {
  const isEmpty = !entries || entries.length === 0
  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        SECURITY LOG
        {!isEmpty && <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: 0.6 }}>{entries.length} checks</span>}
      </div>
      <div className="debug-panel-body">
        {isEmpty ? (
          <span className="debug-panel-empty">Select a file to begin…</span>
        ) : (
          entries.map((entry, i) => {
            const isFirstBackend = entry.source === 'backend' && (i === 0 || entries[i - 1].source === 'frontend')
            return (
              <div key={i}>
                {isFirstBackend && <hr className="debug-divider" />}
                <div className="debug-entry">
                  <span className={`debug-source ${entry.source}`}>
                    {entry.source === 'backend' ? 'BACKEND' : 'FRONTEND'}
                  </span>
                  <span className={`debug-status ${entry.status}`}>
                    {entry.status === 'pass' ? '✓ PASS' : '✗ FAIL'}
                  </span>
                  <span className="debug-slot">[{entry.slot}] {entry.check}</span>
                  <span className="debug-detail">{entry.detail}</span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── DropZone ─────────────────────────────────────────────────────────────────

function DropZone({ label, hint, file, onFile, onClear, disabled, onLog }) {
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState(null)
  const inputRef = useRef(null)

  const processFile = async (f) => {
    const { error, log } = await validateFile(f)
    onLog?.(log)
    if (error) {
      setFileError(error)
      return
    }
    setFileError(null)
    onFile(f)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = e.dataTransfer.files[0]
    if (dropped) await processFile(dropped)
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    if (!disabled) setDragging(true)
  }

  const handleClick = () => {
    if (!disabled) inputRef.current.click()
  }

  const handleClear = () => {
    setFileError(null)
    onLog?.([])
    onClear()
  }

  const formatSize = (bytes) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const zoneClass = [
    'drop-zone',
    dragging  ? 'dragging'  : '',
    file      ? 'has-file'  : '',
    fileError ? 'has-error' : '',
    disabled  ? 'disabled'  : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={zoneClass}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files[0]) processFile(e.target.files[0]); e.target.value = '' }}
        disabled={disabled}
      />

      <div className="drop-zone-icon">
        {file ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : fileError ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
      </div>

      {file ? (
        <div className="file-info" onClick={(e) => e.stopPropagation()}>
          <div className="file-name-tag">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span title={file.name}>{file.name}</span>
          </div>
          <span className="drop-zone-hint">{formatSize(file.size)}</span>
          <button
            className="remove-btn"
            onClick={(e) => { e.stopPropagation(); handleClear() }}
          >
            Remove file
          </button>
        </div>
      ) : (
        <>
          <div className="drop-zone-label">{label}</div>
          {fileError ? (
            <div className="drop-zone-error">{fileError}</div>
          ) : (
            <div className="drop-zone-hint">{hint}</div>
          )}
          <div className="drop-zone-cta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 11, height: 11 }}>
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {fileError ? 'Try another file' : 'Browse or drop'}
          </div>
        </>
      )}
    </div>
  )
}

// ─── UploadZone ───────────────────────────────────────────────────────────────

function UploadZone({ onSubmit, disabled, onFilesChange, hasResult, onReset, backendDebug }) {
  const [studentWork, setStudentWork] = useState(null)
  const [markScheme, setMarkScheme] = useState(null)

  // Debug log state — only tracked in dev; ignored in production builds
  const [swLog, setSwLog] = useState([]) // Student Work frontend checks
  const [msLog, setMsLog] = useState([]) // Mark Scheme frontend checks

  const ready = studentWork && markScheme

  useEffect(() => {
    onFilesChange?.(!!studentWork || !!markScheme)
  }, [studentWork, markScheme])

  const handleSubmit = () => {
    if (!ready || disabled) return
    onSubmit(studentWork, markScheme)
  }

  const handleReset = () => {
    setStudentWork(null)
    setMarkScheme(null)
    setSwLog([])
    setMsLog([])
    onReset?.()
  }

  // Build the flat entry list shown in DebugPanel
  const debugEntries = IS_DEV ? [
    ...swLog.map(e => ({ ...e, slot: 'Student Work', source: 'frontend' })),
    ...msLog.map(e => ({ ...e, slot: 'Mark Scheme',  source: 'frontend' })),
    ...(backendDebug ?? []),
  ] : []

  const renderButton = () => {
    if (disabled) {
      return (
        <button className="submit-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
          Marking in progress…
        </button>
      )
    }
    if (hasResult) {
      return (
        <button className="submit-btn" onClick={handleReset}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 .49-4" />
          </svg>
          Start New
        </button>
      )
    }
    return (
      <button className="submit-btn" onClick={handleSubmit} disabled={!ready}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        Submit for Marking
      </button>
    )
  }

  return (
    <div className="upload-panel">
      <div className="upload-zones">
        <DropZone
          label="Student Work"
          hint="Image or PDF of the student's written answer"
          file={studentWork}
          onFile={setStudentWork}
          onClear={() => setStudentWork(null)}
          disabled={disabled}
          onLog={IS_DEV ? setSwLog : undefined}
        />
        <DropZone
          label="Mark Scheme"
          hint="Image or PDF of the official mark scheme"
          file={markScheme}
          onFile={setMarkScheme}
          onClear={() => setMarkScheme(null)}
          disabled={disabled}
          onLog={IS_DEV ? setMsLog : undefined}
        />
      </div>

      {renderButton()}

      {IS_DEV && <DebugPanel entries={debugEntries} />}
    </div>
  )
}

export default UploadZone
