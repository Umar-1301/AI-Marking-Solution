import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// Relative path — see services/api.js for why.
const API_BASE = '/api'

const EMAIL_REGEX = /^[a-zA-Z0-9_%+\-]+(\.[a-zA-Z0-9_%+\-]+)*@[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}$/
const isValidEmail = (e) => e.length <= 254 && EMAIL_REGEX.test(e)

function Login() {
    const { login } = useAuth()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError(null)

        if (!isValidEmail(email.trim())) {
            setError('Please enter a valid email address')
            return
        }

        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
                credentials: 'include',
            })
            const data = await res.json()

            if (!res.ok) {
                setError(data.error || 'Login failed')
                return
            }

            login(data.user)
        } catch {
            setError('Unable to connect to the server')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="auth-page">
            <div className="auth-card">
                <div className="auth-brand">
                    <div className="brand-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2L2 7l10 5 10-5-10-5z" />
                            <path d="M2 17l10 5 10-5" />
                            <path d="M2 12l10 5 10-5" />
                        </svg>
                    </div>
                    <span className="auth-brand-name">AIMIRA</span>
                </div>

                <div className="auth-header">
                    <h1 className="auth-title">Welcome back</h1>
                    <p className="auth-subtitle">Sign in to your account to continue</p>
                </div>

                <form className="auth-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label className="auth-label" htmlFor="email">Email address</label>
                        <input
                            id="email"
                            className="auth-input"
                            type="email"
                            placeholder="you@school.com"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            required
                            autoComplete="email"
                        />
                    </div>

                    <div className="auth-field">
                        <label className="auth-label" htmlFor="password">Password</label>
                        <input
                            id="password"
                            className="auth-input"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            autoComplete="current-password"
                        />
                    </div>

                    {error && (
                        <div className="auth-error">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            {error}
                        </div>
                    )}

                    <button className="auth-submit" type="submit" disabled={loading}>
                        {loading ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                <p className="auth-switch">
                    Don't have an account?{' '}
                    <Link to="/signup" className="auth-link">Create one</Link>
                </p>
            </div>
        </div>
    )
}

export default Login
