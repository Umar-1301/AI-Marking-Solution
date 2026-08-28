function safeInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.max(min, Math.min(max, Math.round(number)))
}

function safeText(value, { maxLength = 5000, fallback = '' } = {}) {
    if (value === null || value === undefined) return fallback
    return String(value).trim().slice(0, maxLength)
}

// Allowlist and type-enforce the AI response before it reaches SQL or any
// frontend response that later reads the stored marking result.
export function sanitizeAIResult(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('AI response was not a valid object')
    }

    const score = safeInt(raw.score, { min: 0 })
    const maxScore = safeInt(raw.maxScore, { min: 1, fallback: 1 })
    const percentage = safeInt(
        raw.percentage ?? Math.round((score / maxScore) * 100),
        { min: 0, max: 100 }
    )

    const sanitizeList = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'string')
            .map(item => safeText(item, { maxLength: 500 }))
        : []

    const strengths = sanitizeList(raw.strengths)
    const improvements = sanitizeList(raw.improvements)
    const actionableSteps = sanitizeList(raw.actionable_steps)

    const breakdown = Array.isArray(raw.rubric_breakdown)
        ? raw.rubric_breakdown
            .filter(item => item && typeof item === 'object')
            .map(item => {
                const maxMarks = safeInt(item.max_marks, { min: 1, fallback: 1 })
                const marks = safeInt(item.score_awarded, { min: 0, max: maxMarks })
                return {
                    section: safeText(item.criterion, { maxLength: 200, fallback: 'Section' }),
                    marks,
                    maxMarks,
                    reason: safeText(item.reason, { maxLength: 500 }),
                }
            })
        : []

    const teacherReviewRequired = raw.teacher_review_required === true
    const questionMismatch = raw.question_mismatch === true
    const questionMismatchReason = safeText(raw.question_mismatch_reason ?? '', { maxLength: 500 })
    const studentOcrText = safeText(raw.student_ocr_text ?? '', { maxLength: 20000 })

    const annotations = Array.isArray(raw.annotations)
        ? raw.annotations
            .filter(annotation => annotation && typeof annotation === 'object' && annotation.quote && annotation.comment)
            .slice(0, 10)
            .map(annotation => ({
                quote: safeText(annotation.quote, { maxLength: 500 }),
                comment: safeText(annotation.comment, { maxLength: 1000 }),
                type: annotation.type === 'strength' ? 'strength' : 'improvement',
            }))
        : []

    return {
        score,
        maxScore,
        percentage,
        breakdown,
        strengths,
        improvements,
        actionableSteps,
        teacherReviewRequired,
        questionMismatch,
        questionMismatchReason,
        studentOcrText,
        annotations,
    }
}

