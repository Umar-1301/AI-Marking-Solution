// Small, content-free console events for joining a test journey to a job and
// its processing attempts. The test header is untrusted, so accept only the
// generated identifier shape and never log arbitrary header text.
const FLOW_ID = /^[A-Za-z0-9-]{1,80}$/

export function testFlowId(req) {
    const value = req.get('X-Test-Flow-Id')
    return typeof value === 'string' && FLOW_ID.test(value) ? value : null
}

export function traceMarkScheme(stage, fields = {}) {
    console.log(JSON.stringify({
        event: 'mark_scheme_trace', at: new Date().toISOString(),
        service: 'backend', stage, ...fields,
    }))
}
