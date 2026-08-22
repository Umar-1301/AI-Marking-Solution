import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
    // Frontend and backend are served from the same origin (gateway routes
    // /api to the backend container), so connect-src only ever needs 'self'.

    // Dev CSP: 'unsafe-inline' is required because Vite's dev server injects the
    // React Refresh preamble as an inline <script> and CSS as inline <style> elements.
    // These are Vite internals that cannot carry a nonce — they go away in the built output.
    const devCSP = [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        // Azurite's exact origin only — matches AZURE_STORAGE_CONNECTION_STRING's
        // BlobEndpoint in backend/.env, for the direct-to-blob student work
        // upload (see StudentMarking.jsx / blobService.js). Never widen this
        // to a wildcard (e.g. http://127.0.0.1:*) — that would let injected
        // or compromised script reach anything listening locally, not just
        // our own blob emulator.
        "connect-src 'self' ws://localhost:* http://127.0.0.1:10000",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; ')

    // Production CSP: the built output has no inline scripts or styles — Vite extracts
    // everything into hashed asset files served from 'self'. 'unsafe-inline' is dropped.
    //
    // KNOWN GAP: connect-src here still needs the real Storage account's exact
    // hostname (https://<account>.blob.core.windows.net) added, same as devCSP's
    // Azurite entry, once that account exists — direct-to-blob upload will be
    // silently CSP-blocked in production until then. Not filled in yet because
    // there's no real hostname to put here.
    const prodCSP = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; ')

    const csp = mode === 'production' ? prodCSP : devCSP

    return {
        plugins: [react()],
        server: {
            headers: { 'Content-Security-Policy': csp },
            // Mirrors the production gateway: /api/* is forwarded to the backend
            // with the /api prefix stripped, so the same relative fetch('/api/...')
            // calls work unchanged in dev and prod.
            proxy: {
                '/api': {
                    target: 'http://localhost:3001',
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api/, ''),
                },
            },
        },
        preview: {
            headers: { 'Content-Security-Policy': prodCSP },
        },
    }
})
