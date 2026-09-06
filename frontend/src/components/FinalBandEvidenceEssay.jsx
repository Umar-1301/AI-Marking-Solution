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

function flattenFinalBandEvidence(segmentationResult) {
  return (segmentationResult?.threads ?? [])
    .flatMap((thread, threadIndex) => (
      (thread.evidence ?? []).map((evidence, evidenceIndex) => {
        const finalBand = evidence.finalBand ?? evidence.final_band ?? {}
        const evidenceId = evidence.evidenceId ?? evidence.evidence_id ?? null
        return {
          id: `${thread.threadId ?? thread.thread_id ?? threadIndex}-${evidenceId ?? evidenceIndex}`,
          evidenceId,
          quote: evidence.quote ?? '',
          descriptorId: finalBand.descriptorId ?? finalBand.descriptor_id ?? null,
          band: finalBand.band ?? null,
          justification: finalBand.justification ?? '',
        }
      })
    ))
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

function FinalBandEvidenceEssay({ text, segmentationResult }) {
  const baseCards = useMemo(
    () => flattenFinalBandEvidence(segmentationResult),
    [segmentationResult]
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
    window.addEventListener('resize', updateLines)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateLines)
    }
  }, [cards])

  return (
    <section className="descriptor-evidence-wrap" aria-label="Final-band evidence in student response">
      <div className="descriptor-evidence-body" ref={containerRef}>
        <svg className="descriptor-evidence-connectors" aria-hidden="true">
          {lines.map(line => <path key={line.id} d={line.d} stroke={line.color} />)}
        </svg>

        <div className="descriptor-evidence-text">
          <div className="annotated-section-label">Student Response</div>
          <div className="annotated-essay-prose">
            {segments.map((segment, index) => {
              if (segment.type === 'text') return <span key={index}>{segment.content}</span>
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
                  title={`${card.descriptorId ?? 'No secure final band'}: ${card.band ?? 'not securely met'}`}
                >
                  {segment.content}
                  <span className="descriptor-evidence-badge" style={{ background: color.border }}>
                    {card.colorIndex + 1}
                  </span>
                </span>
              )
            })}
          </div>
        </div>

        <aside className="descriptor-evidence-sidebar" aria-label="Final-band evidence cards">
          <div className="annotated-section-label">Final-Band Evidence</div>
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
                  <code className="descriptor-evidence-card-id">
                    {card.descriptorId ?? 'No secure final band'}
                  </code>
                  {card.band && <span className="descriptor-evidence-status">{card.band}</span>}
                </div>
                <p className="descriptor-evidence-explanation">
                  Evidence ID: {card.evidenceId ?? 'Unavailable'}
                </p>
                <div className="descriptor-evidence-judgement">
                  <span>Final-band justification</span>
                  <p>{card.justification || 'No final band was securely met for this evidence.'}</p>
                </div>
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

export default FinalBandEvidenceEssay
