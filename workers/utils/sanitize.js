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

    const actionableSteps = sanitizeList(raw.actionable_steps)

    const sanitizeDescriptorEvidence = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'object')
            .slice(0, 3)
            .map(item => ({
                quote: safeText(item.quote, { maxLength: 500 }),
                explanation: safeText(item.explanation, { maxLength: 1000 }),
            }))
        : []

    const sanitizeAwardedBandEvidence = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'object' && item.descriptor_id)
            .map(item => {
                const status = safeText(item.status, { maxLength: 30 }).toLowerCase()
                return {
                    descriptorId: safeText(item.descriptor_id, { maxLength: 100 }),
                    status: ["met", "partially_met", "not_met"].includes(status)
                        ? status
                        : "not_met",
                    evidence: sanitizeDescriptorEvidence(item.evidence),
                    judgement: safeText(item.judgement, { maxLength: 1000 }),
                }
            })
        : []

    const breakdown = Array.isArray(raw.rubric_breakdown)
        ? raw.rubric_breakdown
            .filter(item => item && typeof item === 'object')
            .map(item => {
                const maxMarks = safeInt(item.max_marks, { min: 1, fallback: 1 })
                const marks = safeInt(item.score_awarded, { min: 0, max: maxMarks })
                return {
                    section: safeText(item.criterion, { maxLength: 200, fallback: 'Section' }),
                    awardedBand: safeText(item.awarded_band, { maxLength: 100 }),
                    marks,
                    maxMarks,
                    evidenceSupportingAwardedBand: sanitizeAwardedBandEvidence(
                        item.evidence_supporting_awarded_band
                    ),
                    nextBandRequirementNotMet: item.next_band_requirement_not_met === null
                        ? null
                        : safeText(item.next_band_requirement_not_met, { maxLength: 500 }),
                    reason: safeText(item.reason, { maxLength: 500 }),
                }
            })
        : []

    const teacherReviewRequired = raw.teacher_review_required === true
    const questionMismatch = raw.question_mismatch === true
    const questionMismatchReason = safeText(raw.question_mismatch_reason ?? '', { maxLength: 500 })
    const studentOcrText = safeText(raw.student_ocr_text ?? '', { maxLength: 20000 })

    const safeNullableText = (value, options = {}) => (
        value === null || value === undefined ? null : safeText(value, options)
    )

    const sanitizeDescriptorReviews = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'object' && item.descriptor_id)
            .map(item => {
                const status = safeText(item.status, { maxLength: 30 }).toLowerCase()
                return {
                    descriptorId: safeText(item.descriptor_id, { maxLength: 100 }),
                    band: safeText(item.band, { maxLength: 100 }),
                    status: ['met', 'partially_met', 'not_met'].includes(status)
                        ? status
                        : 'not_met',
                }
            })
        : []

    const sanitizeThreadEvidence = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'object' && item.evidence_id)
            .map(item => {
                const finalBand = item.final_band && typeof item.final_band === 'object'
                    ? item.final_band
                    : {}

                return {
                    evidenceId: safeText(item.evidence_id, { maxLength: 100 }),
                    quote: safeText(item.quote, { maxLength: 5000 }),
                    threadMatchExplanation: safeText(
                        item.thread_match_explanation,
                        { maxLength: 1500 }
                    ),
                    descriptorReviews: sanitizeDescriptorReviews(item.descriptor_reviews),
                    finalBand: {
                        descriptorId: safeNullableText(finalBand.descriptor_id, { maxLength: 100 }),
                        band: safeNullableText(finalBand.band, { maxLength: 100 }),
                        justification: safeText(finalBand.justification, { maxLength: 1500 }),
                    },
                }
            })
        : []

    const sanitizeThreads = (items) => Array.isArray(items)
        ? items
            .filter(item => item && typeof item === 'object' && item.thread_id)
            .map(item => ({
                threadId: safeText(item.thread_id, { maxLength: 100 }),
                threadDescription: safeText(item.thread_description, { maxLength: 500 }),
                evidence: sanitizeThreadEvidence(item.evidence),
            }))
        : []

    const sanitizeSegmentationResult = (result) => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return null

        return {
            question: safeText(result.question, { maxLength: 500 }),
            marksAvailable: safeInt(result.marks_available, { min: 1, fallback: 1 }),
            threads: sanitizeThreads(result.threads),
        }
    }

    const sanitizeSegmentation = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null

        const status = safeText(value.status, { maxLength: 20 }).toLowerCase()
        if (status === 'complete') {
            const result = sanitizeSegmentationResult(value.result)
            return result
                ? { status: 'complete', result }
                : { status: 'failed', reason: 'Invalid segmentation result' }
        }

        if (status === 'skipped' || status === 'failed') {
            return {
                status,
                reason: safeText(value.reason, { maxLength: 1000 }),
            }
        }

        return {
            status: 'failed',
            reason: 'Invalid segmentation status',
        }
    }

    const segmentation = sanitizeSegmentation(raw.segmentation)

    return {
        score,
        maxScore,
        percentage,
        breakdown,
        actionableSteps,
        teacherReviewRequired,
        questionMismatch,
        questionMismatchReason,
        studentOcrText,
        ...(segmentation ? { segmentation } : {}),
    }
}
