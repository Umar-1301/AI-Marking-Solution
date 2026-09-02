import { useLayoutEffect, useMemo, useRef, useState } from 'react'

const COLORS = [
  { bg: 'rgba(99,102,241,0.20)', border: '#818cf8' },
  { bg: 'rgba(245,158,11,0.20)', border: '#fbbf24' },
  { bg: 'rgba(16,185,129,0.20)', border: '#34d399' },
  { bg: 'rgba(236,72,153,0.20)', border: '#f472b6' },
  { bg: 'rgba(59,130,246,0.20)', border: '#60a5fa' },
  { bg: 'rgba(139,92,246,0.20)', border: '#a78bfa' },
]

function normalise(value) {
  return String(value ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildNormalisedText(text, { omitStruckThroughText = false } = {}) {
  const characters = []
  const sourceIndexes = []
  let previousWasSpace = false
  let insideStruckThroughText = false

  for (let index = 0; index < text.length; index += 1) {
    if (omitStruckThroughText && text.slice(index, index + 2) === '~~') {
      insideStruckThroughText = !insideStruckThroughText
      index += 1
      continue
    }
    if (insideStruckThroughText) continue

    let character = text[index]
    if (character === '‘' || character === '’' || character === 'ʼ') character = "'"
    if (character === '“' || character === '”' || character === '«' || character === '»') character = '"'

    if (/\s/.test(character)) {
      if (!previousWasSpace) {
        characters.push(' ')
        sourceIndexes.push(index)
        previousWasSpace = true
      }
    } else {
      characters.push(character)
      sourceIndexes.push(index)
      previousWasSpace = false
    }
  }

  return { text: characters.join(''), sourceIndexes }
}

function overlaps(range, ranges) {
  const rangeEnd = range.position + range.length
  return ranges.some(existing => (
    range.position < existing.position + existing.length && rangeEnd > existing.position
  ))
}

// Prefer exact, character-for-character matches. The normalised fallbacks only
// bridge OCR whitespace, smart-quote and tracked-edit differences, while
// preserving the original source span that is actually highlighted.
function findAvailableMatch(text, quote, normalisedSources, usedRanges) {
  if (!quote) return null

  let searchFrom = 0
  while (searchFrom < text.length) {
    const position = text.indexOf(quote, searchFrom)
    if (position === -1) break
    const candidate = { position, length: quote.length }
    if (!overlaps(candidate, usedRanges)) return candidate
    searchFrom = position + 1
  }

  const normalisedQuote = normalise(quote)
  if (!normalisedQuote) return null

  for (const source of normalisedSources) {
    for (const [haystack, needle] of [
      [source.text, normalisedQuote],
      [source.text.toLowerCase(), normalisedQuote.toLowerCase()],
    ]) {
      let searchPosition = 0

      while (searchPosition < haystack.length) {
        const normalisedPosition = haystack.indexOf(needle, searchPosition)
        if (normalisedPosition === -1) break

        const normalisedEnd = normalisedPosition + needle.length - 1
        const position = source.sourceIndexes[normalisedPosition]
        const end = source.sourceIndexes[normalisedEnd] + 1
        const candidate = { position, length: end - position }
        if (!overlaps(candidate, usedRanges)) return candidate
        searchPosition = normalisedPosition + 1
      }
    }
  }

  return null
}

function flattenEvidence(breakdown) {
  return (breakdown ?? []).flatMap((criterion, criterionIndex) => {
    const descriptorEvidence = criterion.evidenceSupportingAwardedBand
      ?? criterion.evidence_supporting_awarded_band
      ?? []

    return descriptorEvidence.flatMap((descriptor, descriptorIndex) => (
      (descriptor.evidence ?? []).map((item, evidenceIndex) => ({
        id: `${criterionIndex}-${descriptorIndex}-${evidenceIndex}`,
        descriptorId: descriptor.descriptorId ?? descriptor.descriptor_id ?? 'Descriptor',
        status: descriptor.status ?? '',
        quote: item.quote ?? '',
        explanation: item.explanation ?? '',
        judgement: descriptor.judgement ?? '',
      }))
    ))
  }).map((card, colorIndex) => ({ ...card, colorIndex }))
}

function buildEvidenceSegments(text, cards) {
  const normalisedSources = [
    buildNormalisedText(text),
    // Student OCR can preserve deleted handwriting as ~~deleted words~~,
    // whereas the model often quotes the corrected reading without it.
    buildNormalisedText(text, { omitStruckThroughText: true }),
  ]
  const usedRanges = []
  const positionedCards = cards.map(card => {
    const match = findAvailableMatch(text, card.quote, normalisedSources, usedRanges)
    if (!match) return { ...card, match: null }
    usedRanges.push(match)
    return { ...card, match }
  })

  const matched = positionedCards
    .filter(card => card.match)
    .sort((left, right) => left.match.position - right.match.position)

  const segments = []
  let cursor = 0
  for (const card of matched) {
    const { position, length } = card.match
    if (position > cursor) segments.push({ type: 'text', content: text.slice(cursor, position) })
    segments.push({ type: 'highlight', content: text.slice(position, position + length), card })
    cursor = position + length
  }
  if (cursor < text.length) segments.push({ type: 'text', content: text.slice(cursor) })

  return { cards: positionedCards, segments }
}

function readableStatus(status) {
  return String(status || 'not recorded').replace(/_/g, ' ')
}

function DescriptorEvidenceEssay({ text, breakdown }) {
  const baseCards = useMemo(() => flattenEvidence(breakdown), [breakdown])
  const { cards, segments } = useMemo(
    () => buildEvidenceSegments(text, baseCards),
    [text, baseCards]
  )
  const containerRef = useRef(null)
  const highlightRefs = useRef(new Map())
  const cardRefs = useRef(new Map())
  const [lines, setLines] = useState([])

  useLayoutEffect(() => {
    const updateLines = () => {
      const container = containerRef.current
      if (!container || window.innerWidth <= 900) {
        setLines([])
        return
      }

      const containerBox = container.getBoundingClientRect()
      const nextLines = cards.flatMap((card, index) => {
        if (!card.match) return []
        const highlight = highlightRefs.current.get(card.id)
        const evidenceCard = cardRefs.current.get(card.id)
        if (!highlight || !evidenceCard) return []

        const highlightBox = highlight.getBoundingClientRect()
        const evidenceCardBox = evidenceCard.getBoundingClientRect()
        const startX = highlightBox.right - containerBox.left + 3
        const startY = highlightBox.top - containerBox.top + (highlightBox.height / 2)
        const endX = evidenceCardBox.left - containerBox.left - 6
        const endY = evidenceCardBox.top - containerBox.top + (evidenceCardBox.height / 2)
        const bend = Math.max(28, (endX - startX) * 0.42)

        return [{
          id: card.id,
          color: COLORS[card.colorIndex % COLORS.length].border,
          d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
        }]
      })
      setLines(nextLines)
    }

    updateLines()
    const observer = new ResizeObserver(updateLines)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener('resize', updateLines)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateLines)
    }
  }, [cards])

  return (
    <section className="descriptor-evidence-wrap" aria-label="Descriptor evidence in student response">
      <div className="descriptor-evidence-body" ref={containerRef}>
        <svg className="descriptor-evidence-connectors" aria-hidden="true">
          {lines.map(line => (
            <path key={line.id} d={line.d} stroke={line.color} />
          ))}
        </svg>

        <div className="descriptor-evidence-text">
          <div className="annotated-section-label">Student Response</div>
          <div className="annotated-essay-prose">
            {segments.map((segment, index) => {
              if (segment.type === 'text') return <span key={index}>{segment.content}</span>
              const card = segment.card
              const color = COLORS[card.colorIndex % COLORS.length]
              const number = card.colorIndex + 1
              return (
                <span
                  key={card.id}
                  className="descriptor-evidence-highlight"
                  ref={node => {
                    if (node) highlightRefs.current.set(card.id, node)
                    else highlightRefs.current.delete(card.id)
                  }}
                  style={{ background: color.bg, borderBottomColor: color.border }}
                  title={`${card.descriptorId}: ${card.explanation}`}
                >
                  {segment.content}
                  <span className="descriptor-evidence-badge" style={{ background: color.border }}>{number}</span>
                </span>
              )
            })}
          </div>
        </div>

        <aside className="descriptor-evidence-sidebar" aria-label="Evidence explanations">
          <div className="annotated-section-label">Descriptor Evidence</div>
          {cards.map((card, index) => {
            const color = COLORS[card.colorIndex % COLORS.length]
            return (
              <article
                key={card.id}
                className={`descriptor-evidence-card${card.match ? '' : ' descriptor-evidence-card--unmatched'}`}
                ref={node => {
                  if (node) cardRefs.current.set(card.id, node)
                  else cardRefs.current.delete(card.id)
                }}
                style={{ '--evidence-colour': color.border }}
              >
                <div className="descriptor-evidence-card-header">
                  <span className="descriptor-evidence-card-number" style={{ background: color.border }}>{card.colorIndex + 1}</span>
                  <code className="descriptor-evidence-card-id">{card.descriptorId}</code>
                  {card.status && <span className="descriptor-evidence-status">{readableStatus(card.status)}</span>}
                </div>
                <p className="descriptor-evidence-explanation">{card.explanation}</p>
                <div className="descriptor-evidence-judgement">
                  <span>Judgement</span>
                  <p>{card.judgement}</p>
                </div>
                {!card.match && (
                  <p className="descriptor-evidence-unmatched-note">This quote could not be matched in the stored student response.</p>
                )}
              </article>
            )
          })}
        </aside>
      </div>
    </section>
  )
}

export default DescriptorEvidenceEssay
