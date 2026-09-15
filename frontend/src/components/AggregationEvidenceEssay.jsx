import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderOcrText } from '../utils/renderOcrText'

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
    .replace(/[‘’ʼ“”«»'"]/g, '"')
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
    if (/[‘’ʼ“”«»'"]/.test(character)) character = '"'

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

function quoteMatchVariants(quote) {
  const exactQuote = String(quote ?? '')
  if (!exactQuote) return []

  const variants = [exactQuote]
  // The model can append one punctuation character that is not present in the
  // OCR source (most commonly a full stop or a closing quotation mark). Keep
  // this fallback narrow: never discard a letter, number, or whitespace.
  if (exactQuote.length > 1 && /[.,!?;:'"‘’“”«»)]$/u.test(exactQuote)) {
    variants.push(exactQuote.slice(0, -1))
  }

  return variants
}

function findAvailableMatch(text, quote, normalisedSources, usedRanges) {
  const quoteVariants = quoteMatchVariants(quote)
  if (quoteVariants.length === 0) return null

  for (const quoteVariant of quoteVariants) {
    let searchFrom = 0
    while (searchFrom < text.length) {
      const position = text.indexOf(quoteVariant, searchFrom)
      if (position === -1) break
      const candidate = { position, length: quoteVariant.length }
      if (!overlaps(candidate, usedRanges)) return candidate
      searchFrom = position + 1
    }
  }

  for (const quoteVariant of quoteVariants) {
    const normalisedQuote = normalise(quoteVariant)
    if (!normalisedQuote) continue

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
  }

  return null
}

function descriptorIdsForEvidence(evidence) {
  const descriptorIds = evidence.descriptorIds ?? evidence.descriptor_ids
  if (Array.isArray(descriptorIds)) {
    return [...new Set(descriptorIds.filter(Boolean).map(String))]
  }

  const legacyDescriptorId = evidence.descriptorId ?? evidence.descriptor_id
  return legacyDescriptorId ? [String(legacyDescriptorId)] : []
}

function flattenAggregationEvidence(aggregationResult) {
  return (aggregationResult?.evidence ?? [])
    .map((evidence, evidenceIndex) => ({
      id: evidence.evidenceId ?? evidence.evidence_id ?? `aggregation-evidence-${evidenceIndex}`,
      quote: evidence.quote ?? '',
      explanation: evidence.explanation ?? '',
      summary: evidence.summary ?? '',
      descriptorIds: descriptorIdsForEvidence(evidence),
    }))
    .map((card, colorIndex) => ({ ...card, colorIndex }))
}

function buildEvidenceSegments(text, cards) {
  const normalisedSources = [
    buildNormalisedText(text),
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

function AggregationEvidenceEssay({ text, aggregationResult }) {
  const baseCards = useMemo(
    () => flattenAggregationEvidence(aggregationResult),
    [aggregationResult]
  )
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
      const nextLines = cards.flatMap(card => {
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
    for (const card of cardRefs.current.values()) observer.observe(card)
    window.addEventListener('resize', updateLines)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateLines)
    }
  }, [cards])

  return (
    <section className="descriptor-evidence-wrap" aria-label="Marking evidence in student response">
      <div className="descriptor-evidence-body" ref={containerRef}>
        <svg className="descriptor-evidence-connectors" aria-hidden="true">
          {lines.map(line => <path key={line.id} d={line.d} stroke={line.color} />)}
        </svg>

        <div className="descriptor-evidence-text">
          <div className="annotated-section-label">Student Response</div>
          <div className="annotated-essay-prose">
            {segments.map((segment, index) => {
              if (segment.type === 'text') {
                return <span key={index}>{renderOcrText(segment.content, `text-${index}`)}</span>
              }
              const card = segment.card
              const color = COLORS[card.colorIndex % COLORS.length]
              return (
                <span
                  key={card.id}
                  className="descriptor-evidence-highlight"
                  ref={node => {
                    if (node) highlightRefs.current.set(card.id, node)
                    else highlightRefs.current.delete(card.id)
                  }}
                  style={{ background: color.bg, borderBottomColor: color.border }}
                  title={card.descriptorIds.length > 0
                    ? `Descriptors: ${card.descriptorIds.join(', ')}`
                    : 'Descriptor unavailable'}
                >
                  {renderOcrText(segment.content, `highlight-${card.id}`)}
                  <span className="descriptor-evidence-badge" style={{ background: color.border }}>
                    {card.colorIndex + 1}
                  </span>
                </span>
              )
            })}
          </div>
        </div>

        <aside className="descriptor-evidence-sidebar" aria-label="Marking evidence cards">
          <div className="annotated-section-label">Descriptor Evidence</div>
          {cards.map(card => {
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
                  <span className="descriptor-evidence-card-number" style={{ background: color.border }}>
                    {card.colorIndex + 1}
                  </span>
                  <div className="descriptor-evidence-card-ids">
                    {card.descriptorIds.length > 0 ? (
                      card.descriptorIds.map(descriptorId => (
                        <code key={descriptorId} className="descriptor-evidence-card-id">
                          {descriptorId}
                        </code>
                      ))
                    ) : (
                      <code className="descriptor-evidence-card-id">Descriptor unavailable</code>
                    )}
                  </div>
                </div>
                {card.summary ? (
                  <>
                    <div className="descriptor-evidence-judgement">
                      <span>At a glance</span>
                      <p>{card.summary}</p>
                    </div>
                    <details className="descriptor-evidence-details">
                      <summary>View evidence explanation</summary>
                      <div className="descriptor-evidence-judgement">
                        <p>{card.explanation}</p>
                      </div>
                    </details>
                  </>
                ) : (
                  <div className="descriptor-evidence-judgement">
                    <span>Evidence explanation</span>
                    <p>{card.explanation || 'No explanation was provided for this evidence.'}</p>
                  </div>
                )}
                {!card.match && (
                  <p className="descriptor-evidence-unmatched-note">
                    This quote could not be matched in the stored student response.
                  </p>
                )}
              </article>
            )
          })}
        </aside>
      </div>
    </section>
  )
}

export default AggregationEvidenceEssay
