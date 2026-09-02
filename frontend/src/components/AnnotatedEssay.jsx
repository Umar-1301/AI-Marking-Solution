import { useMemo } from 'react'

const COLORS = [
  { bg: 'rgba(99,102,241,0.2)',  border: '#6366f1' },
  { bg: 'rgba(245,158,11,0.2)', border: '#f59e0b' },
  { bg: 'rgba(16,185,129,0.2)', border: '#10b981' },
  { bg: 'rgba(236,72,153,0.2)', border: '#ec4899' },
  { bg: 'rgba(59,130,246,0.2)', border: '#3b82f6' },
  { bg: 'rgba(139,92,246,0.2)', border: '#8b5cf6' },
]

// Normalise a string for fuzzy matching:
// smart quotes → straight, whitespace runs → single space.
function norm(str) {
  return str
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Build a parallel normalised version of `text` plus a character map so we
// can convert a match position in the normalised string back to the original.
function buildNormMap(text) {
  const chars = []   // normalised characters
  const map   = []   // map[i] = index of chars[i] in the original text
  let prevSpace = false

  for (let i = 0; i < text.length; i++) {
    let c = text[i]
    if (c === '‘' || c === '’' || c === 'ʼ') c = "'"
    if (c === '“' || c === '”' || c === '«' || c === '»') c = '"'

    if (/\s/.test(c)) {
      if (!prevSpace) { chars.push(' '); map.push(i); prevSpace = true }
    } else {
      chars.push(c); map.push(i); prevSpace = false
    }
  }
  return { normText: chars.join(''), map }
}

// Find `quote` inside `text`. Returns { pos, len } in original-text coordinates,
// or null if no match is found.
// Attempts: 1) exact  2) normalised case-sensitive  3) normalised case-insensitive
function findBestMatch(text, quote, normText, charMap) {
  if (!quote) return null

  // 1. Exact match — fastest path
  const exact = text.indexOf(quote)
  if (exact !== -1) return { pos: exact, len: quote.length }

  // 2 & 3. Normalised match
  const nq = norm(quote)
  if (!nq) return null

  let nPos = normText.indexOf(nq)
  if (nPos === -1) nPos = normText.toLowerCase().indexOf(nq.toLowerCase())
  if (nPos === -1) return null

  const origStart = charMap[nPos]
  const normEnd   = nPos + nq.length - 1
  if (normEnd >= charMap.length) return null
  const origEnd   = charMap[normEnd] + 1
  if (origStart >= origEnd) return null

  return { pos: origStart, len: origEnd - origStart }
}

function buildSegments(text, annotations) {
  const { normText, map: charMap } = buildNormMap(text)

  const positioned = annotations
    .map((a, i) => {
      const match = findBestMatch(text, a.quote, normText, charMap)
      return match ? { ...a, idx: i, pos: match.pos, len: match.len } : { ...a, idx: i, pos: -1 }
    })
    .filter(a => a.pos !== -1)
    .sort((a, b) => a.pos - b.pos)

  const segments = []
  const usedIndices = new Set()
  let cursor = 0

  for (const ann of positioned) {
    if (ann.pos < cursor) continue
    if (ann.pos > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, ann.pos) })
    }
    // Slice from the original text so the display exactly matches what the teacher sees
    segments.push({ type: 'highlight', content: text.slice(ann.pos, ann.pos + ann.len), ann })
    usedIndices.add(ann.idx)
    cursor = ann.pos + ann.len
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) })
  }

  return { segments, usedIndices }
}

function AnnotatedEssay({ text, annotations }) {
  const { segments, usedIndices } = useMemo(
    () => buildSegments(text, annotations),
    [text, annotations]
  )

  // Number each highlight in the order it appears in the text
  let highlightNum = 0
  const numberedHighlights = []
  for (const seg of segments) {
    if (seg.type === 'highlight') {
      highlightNum++
      const color = COLORS[(highlightNum - 1) % COLORS.length]
      numberedHighlights.push({ ...seg.ann, num: highlightNum, color })
    }
  }

  // Annotations whose quote wasn't found in the text (show without highlight)
  const unfound = annotations
    .map((a, i) => ({ ...a, idx: i }))
    .filter(a => !usedIndices.has(a.idx))

  const hasComments = numberedHighlights.length > 0 || unfound.length > 0

  let renderNum = 0

  return (
    <div className="annotated-essay-wrap">
      <div className="annotated-essay-body">
        <div className={`annotated-essay-text${hasComments ? '' : ' annotated-essay-text--full'}`}>
          <div className="annotated-section-label">Student Response</div>
          <div className="annotated-essay-prose">
            {segments.map((seg, i) => {
              if (seg.type === 'text') {
                return <span key={i}>{seg.content}</span>
              }
              renderNum++
              const num = renderNum
              const color = COLORS[(num - 1) % COLORS.length]
              return (
                <span
                  key={i}
                  className="annotated-highlight"
                  style={{ background: color.bg, borderBottom: `2px solid ${color.border}` }}
                >
                  {seg.content}
                  <span
                    className="annotated-badge"
                    style={{ background: color.border }}
                  >{num}</span>
                </span>
              )
            })}
          </div>
        </div>

        {hasComments && (
          <div className="annotated-essay-sidebar">
            <div className="annotated-section-label">Examiner Comments</div>
            {numberedHighlights.map(ann => (
              <div
                key={ann.idx}
                className="annotation-card"
                style={{ borderLeft: `3px solid ${ann.color.border}` }}
              >
                <div className="annotation-card-header">
                  <span
                    className="annotation-card-num"
                    style={{ background: ann.color.border }}
                  >{ann.num}</span>
                  <span className={`annotation-card-type annotation-type-${ann.type}`}>
                    {ann.type === 'strength' ? 'Strength' : 'Improvement'}
                  </span>
                </div>
                <p className="annotation-card-comment">{ann.comment}</p>
              </div>
            ))}
            {unfound.map((ann, i) => (
              <div
                key={`unfound-${i}`}
                className="annotation-card annotation-card-unfound"
              >
                <div className="annotation-card-header">
                  <span className={`annotation-card-type annotation-type-${ann.type}`}>
                    {ann.type === 'strength' ? 'Strength' : 'Improvement'}
                  </span>
                </div>
                {ann.quote && (
                  <p className="annotation-card-quote">"{ann.quote}"</p>
                )}
                <p className="annotation-card-comment">{ann.comment}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default AnnotatedEssay
