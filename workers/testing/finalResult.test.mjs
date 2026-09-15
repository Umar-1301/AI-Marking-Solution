import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAIResult } from '../utils/sanitize.js'
import { feedbackResult } from '../../frontend/src/utils/feedbackResult.js'

const final = () => ({ status: 'complete', result: {
    score: 2, max_score: 6, summary: 'Final teacher summary.',
    original_score: 2, delta: 0,
    breakdown: [{ section: 'AO4', awarded_band: 'Level 1', marks: 2, max_marks: 6, summary: 'Limited development.' }],
    evidence: Array.from({ length: 12 }, (_, index) => ({
        evidence_id: `e${index + 1}`, descriptor_ids: ['ao4-1a'],
        quote: '  The verb "quiet" suggests ~~that the~~ fear.  ',
        explanation: 'Final explanation.', summary: 'Final short summary.',
    })),
} })

test('new result survives sanitisation independently of the old grade and drives feedback', () => {
    const raw = { score: 5, maxScore: 6, student_ocr_text: 'Stored OCR', final_result: final() }
    const { finalResult, ...holistic } = sanitizeAIResult(raw)
    assert.equal(holistic.score, 5)
    assert.equal(finalResult.result.score, 2)
    assert.equal(finalResult.result.originalScore, 2)
    assert.equal(finalResult.result.delta, 0)
    assert.equal(finalResult.result.breakdown[0].awardedBand, 'Level 1')
    assert.equal(finalResult.result.evidence.length, 12)
    assert.equal(finalResult.result.evidence[0].quote, raw.final_result.result.evidence[0].quote)
    assert.equal(finalResult.result.evidence[0].summary, 'Final short summary.')
    const view = feedbackResult({ result: holistic, finalResult })
    assert.equal(view.result.score, 2)
    assert.equal(view.evidenceResult.evidence[0].explanation, 'Final explanation.')
    assert.equal(view.studentText, 'Stored OCR')
    assert.deepEqual(view.actionableSteps, [])
})

test('legacy and failed results fall back explicitly; empty final evidence never mixes in old evidence', () => {
    const row = { result: { score: 5 }, aggregation: { status: 'complete', result: { evidence: ['old'] } } }
    assert.equal(feedbackResult(row).result.score, 5)
    const failed = feedbackResult({ ...row, finalResult: { status: 'failed' } })
    assert.equal(failed.result.score, 5)
    assert.equal(failed.finalUnavailable, true)
    const current = feedbackResult({ ...row, finalResult: { status: 'complete', result: { score: 0, evidence: [] } } })
    assert.equal(current.result.score, 0)
    assert.deepEqual(current.evidenceResult.evidence, [])
})

test('failed validation retains diagnostic model output without driving feedback', () => {
    const diagnostic = final().result
    const failed = sanitizeAIResult({
        final_result: {
            status: 'failed',
            reason: 'Final evidence descriptor does not belong to its supplied threads',
            model_result: diagnostic,
        },
    }).finalResult
    assert.equal(failed.status, 'failed')
    assert.equal(failed.modelResult.score, 2)
    assert.equal(failed.modelResult.originalScore, 2)
    assert.equal(failed.modelResult.delta, 0)
    assert.deepEqual(failed.modelResult.evidence[0].descriptorIds, ['ao4-1a'])

    const view = feedbackResult({ result: { score: 5 }, finalResult: failed })
    assert.equal(view.result.score, 5)
    assert.equal(view.evidenceResult, null)
    assert.equal(view.finalUnavailable, true)
})

test('inconsistent marks are rejected if they were not reconciled before sanitisation', () => {
    const invalid = final()
    invalid.result.score = 4
    assert.equal(sanitizeAIResult({ final_result: invalid }).finalResult.status, 'failed')
})

test('a reconciled score and its original value survive sanitisation', () => {
    const raw = final()
    raw.result.score = 3
    raw.result.breakdown[0].marks = 3
    raw.result.original_score = 2
    raw.result.delta = 1
    const clean = sanitizeAIResult({ final_result: raw }).finalResult
    assert.equal(clean.result.score, 3)
    assert.equal(clean.result.originalScore, 2)
    assert.equal(clean.result.delta, 1)
})

test('final sanitiser excludes extra fields, including earlier segmentation output', () => {
    const raw = final()
    raw.result.unwanted = 'discard'
    raw.result.evidence[0].unwanted = 'discard'
    const clean = sanitizeAIResult({ final_result: raw, segmentation: { status: 'complete' } })
    assert.ok(!('segmentation' in clean))
    assert.ok(!('unwanted' in clean.finalResult.result))
    assert.ok(!('unwanted' in clean.finalResult.result.evidence[0]))
})
