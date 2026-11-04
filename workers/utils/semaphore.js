// One permit covers one complete /mark-with-ocr-text HTTP request.
export function createSemaphore(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Semaphore limit must be a positive integer')
    }
    let active = 0
    const waiting = []

    function wake() {
        while (active < limit && waiting.length) {
            const next = waiting.shift()
            next.signal?.removeEventListener('abort', next.onAbort)
            if (next.signal?.aborted) {
                next.reject(next.signal.reason ?? new Error('Request aborted'))
                continue
            }
            active += 1
            next.resolve()
        }
    }

    async function run(work, signal) {
        if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
        if (active < limit && waiting.length === 0) {
            active += 1
        } else {
            await new Promise((resolve, reject) => {
                const entry = { resolve, reject, signal, onAbort: null }
                entry.onAbort = () => {
                    const index = waiting.indexOf(entry)
                    if (index < 0) return
                    waiting.splice(index, 1)
                    reject(signal.reason ?? new Error('Request aborted'))
                }
                waiting.push(entry)
                signal?.addEventListener('abort', entry.onAbort, { once: true })
                if (signal?.aborted) entry.onAbort()
            })
        }
        try {
            if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
            return await work()
        } finally {
            active -= 1
            wake()
        }
    }

    return { run, get active() { return active } }
}
