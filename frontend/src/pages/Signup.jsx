import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// Relative path — see services/api.js for why.
const API_BASE = '/api'

const EMAIL_REGEX = /^[a-zA-Z0-9_%+\-]+(\.[a-zA-Z0-9_%+\-]+)*@[a-zA-Z0-9\-]+(\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}$/
const isValidEmail = (e) => e.length <= 254 && EMAIL_REGEX.test(e)

function Signup() {
    const { login } = useAuth()
    const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' })
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)

    const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError(null)

        if (!isValidEmail(form.email.trim())) {
            setError('Please enter a valid email address')
            return
        }
        if (form.password !== form.confirmPassword) {
            setError('Passwords do not match')
            return
        }
        if (form.password.length < 10) {
            setError('Password must be at least 10 characters')
            return
        }
        if (!/[0-9]/.test(form.password)) {
            setError('Password must contain at least one number')
            return
        }
        if ((form.password.match(/[^a-zA-Z0-9]/g) || []).length < 2) {
            setError('Password must contain at least 2 special characters')
            return
        }

        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/auth/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
                credentials: 'include',
            })
            const data = await res.json()

            if (!res.ok) {
                setError(data.error || 'Sign up failed')
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
                    <span className="auth-brand-name">KLASSIO</span>
                </div>

                <div className="auth-header">
                    <h1 className="auth-title">Create an account</h1>
                    <p className="auth-subtitle">Get started with AI-powered marking</p>
                </div>

                <form className="auth-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label className="auth-label" htmlFor="name">Full name</label>
                        <input
                            id="name"
                            className="auth-input"
                            type="text"
                            placeholder="Jane Smith"
                            value={form.name}
                            onChange={set('name')}
                            required
                            autoComplete="name"
                        />
                    </div>

                    <div className="auth-field">
                        <label className="auth-label" htmlFor="email">Email address</label>
                        <input
                            id="email"
                            className="auth-input"
                            type="email"
                            placeholder="you@school.com"
                            value={form.email}
                            onChange={set('email')}
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
                            placeholder="Min. 10 chars, 1 number, 2 special characters"
                            value={form.password}
                            onChange={set('password')}
                            required
                            autoComplete="new-password"
                        />
                    </div>

                    <div className="auth-field">
                        <label className="auth-label" htmlFor="confirm">Confirm password</label>
                        <input
                            id="confirm"
                            className="auth-input"
                            type="password"
                            placeholder="••••••••"
                            value={form.confirmPassword}
                            onChange={set('confirmPassword')}
                            required
                            autoComplete="new-password"
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
                        {loading ? 'Creating account…' : 'Create account'}
                    </button>
                </form>

                <p className="auth-switch">
                    Already have an account?{' '}
                    <Link to="/login" className="auth-link">Sign in</Link>
                </p>
            </div>
        </div>
    )
}

export default Signup
