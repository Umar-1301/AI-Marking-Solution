import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createSemaphore } from '../utils/semaphore.js'

test('one limiter caps downstream calls shared by several OCR batches', async () => {
    const limiter = createSemaphore(6)
    let inFlight = 0
    let peak = 0
    await Promise.all(Array.from({ length: 30 }, () => limiter.run(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await delay(10)
        inFlight -= 1
    })))
    assert.equal(peak, 6)
    assert.equal(limiter.active, 0)
})

test('an aborted call leaves the waiting queue without taking a permit', async () => {
    const limiter = createSemaphore(1)
    let releaseFirst
    const first = limiter.run(() => new Promise(resolve => { releaseFirst = resolve }))
    const controller = new AbortController()
    const waiting = limiter.run(() => Promise.resolve('unexpected'), controller.signal)
    controller.abort(new Error('batch timed out'))
    await assert.rejects(waiting, /batch timed out/)
    releaseFirst()
    await first
    assert.equal(limiter.active, 0)
})
