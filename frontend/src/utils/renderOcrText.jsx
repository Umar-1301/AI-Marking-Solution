import { Fragment } from 'react'

export function renderOcrText(value, keyPrefix = 'ocr') {
  const text = String(value ?? '')
  const nodes = []
  let cursor = 0
  let part = 0

  while (cursor < text.length) {
    const opening = text.indexOf('~~', cursor)
    if (opening === -1) {
      nodes.push(<Fragment key={`${keyPrefix}-text-${part++}`}>{text.slice(cursor)}</Fragment>)
      break
    }

    const closing = text.indexOf('~~', opening + 2)
    if (closing === -1) {
      nodes.push(<Fragment key={`${keyPrefix}-text-${part++}`}>{text.slice(cursor)}</Fragment>)
      break
    }

    if (opening > cursor) {
      nodes.push(<Fragment key={`${keyPrefix}-text-${part++}`}>{text.slice(cursor, opening)}</Fragment>)
    }

    nodes.push(
      <del className="ocr-crossed-out" key={`${keyPrefix}-crossed-out-${part++}`}>
        {text.slice(opening + 2, closing)}
      </del>
    )
    cursor = closing + 2
  }

  return nodes
}
