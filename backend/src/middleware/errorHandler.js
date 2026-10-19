import { testFlowId, traceMarkScheme } from '../logging/markSchemeTrace.js'

export function errorHandler(err, req, res, _next) {
    const flowId = testFlowId(req)
    if (flowId) {
        traceMarkScheme('http_error', {
            flow_id: flowId, job_id: req.markSchemeJobId ?? req.params?.jobId ?? null,
            error_type: err?.name ?? 'Error', status: err.status || 500,
        })
    }
    console.error(err.stack)
    const body = { error: 'An unexpected error occurred' }
    if (process.env.NODE_ENV !== 'production' && req._securityLog?.length) {
        body._debug = req._securityLog
    }
    res.status(err.status || 500).json(body)
}

// If anything crashes anywhere in the backend, this catches it and sends a clean error message back to the browser. 
// Without this, the browser would just hang or get a confusing raw crash message.
