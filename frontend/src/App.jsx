import { useState, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { useInactivityTimer } from './hooks/useInactivityTimer'
import InactivityModal from './components/InactivityModal'
import Home from './pages/Home'
import Login from './pages/Login'
import Signup from './pages/Signup'
import CreateClass from './pages/CreateClass'
import StudentMarking from './pages/StudentMarking'
import SelectQuestion from './pages/SelectQuestion'
import StudentFeedback from './pages/StudentFeedback'
import './App.css'

function ProtectedRoute({ children }) {
    const { user } = useAuth()
    return user ? children : <Navigate to="/login" replace />
}

function PublicRoute({ children }) {
    const { user } = useAuth()
    return user ? <Navigate to="/" replace /> : children
}

// True for a plain left-click with no modifier keys — the same check
// react-router-dom's own Link uses internally to decide whether to take
// over navigation (vs letting the browser handle ctrl/cmd/middle-click as
// "open in new tab" normally).
function isPlainLeftClick(event) {
    return event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

// react-router-dom's built-in <NavLink viewTransition> only works with the
// data router (createBrowserRouter/RouterProvider) — this app uses plain
// declarative <BrowserRouter>, where that prop is silently a no-op (verified
// against the installed and latest react-router source, and against React
// Router's own docs, which mark view transitions "Not available" in
// Declarative Mode). document.startViewTransition() is a native browser API
// though — nothing about calling it manually requires the data router.
// flushSync is required here: startViewTransition's callback needs the DOM
// update to happen synchronously so it can capture the "after" snapshot —
// a normal (batched, async) navigate() would race it.
function navigateWithTransition(navigate, to) {
    if (!document.startViewTransition) {
        navigate(to)
        return
    }
    document.startViewTransition(() => {
        flushSync(() => navigate(to))
    })
}

function Header() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()

    const handleNavClick = (to) => (event) => {
        if (!isPlainLeftClick(event)) return
        event.preventDefault()
        navigateWithTransition(navigate, to)
    }

    return (
        <header className="header">
            <div className="header-inner">
                <div className="brand">
                    <div className="brand-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2L2 7l10 5 10-5-10-5z" />
                            <path d="M2 17l10 5 10-5" />
                            <path d="M2 12l10 5 10-5" />
                        </svg>
                    </div>
                    <span className="brand-name">KLASSIO</span>
                    <span className="brand-badge">Beta</span>
                </div>

                {user && (
                    <nav className="header-nav">
                        {/* Scoped to just these two links — the app's only persistent nav
                            destinations. Every other navigation (Home into a marking
                            session, back buttons, etc.) is process flow, not nav, and
                            stays untransitioned. See the scale+fade rules in index.css. */}
                        <NavLink to="/" end className="header-nav-link" onClick={handleNavClick('/')}>Home</NavLink>
                        <NavLink to="/create-class" className="header-nav-link" onClick={handleNavClick('/create-class')}>Create Class</NavLink>
                    </nav>
                )}

                {user ? (
                    <div className="header-user">
                        <span className="header-user-name">{user.name}</span>
                        <button className="header-logout-btn" onClick={logout}>
                            Sign out
                        </button>
                    </div>
                ) : (
                    <div className="header-status">
                        <div className="status-dot" />
                        <span>AI online</span>
                    </div>
                )}
            </div>
        </header>
    )
}

// AppContent lives inside AuthProvider so it can call useAuth()
// and own the inactivity warning state
function AppContent() {
    const { user, logout, refreshToken } = useAuth()
    const [showWarning, setShowWarning] = useState(false)

    const handleIdle = useCallback(() => {
        if (user) setShowWarning(true)
    }, [user])

    const { resetTimer } = useInactivityTimer({ onIdle: handleIdle, enabled: !!user })

    const handleStayLoggedIn = async () => {
        const ok = await refreshToken()
        if (ok) {
            setShowWarning(false)
            resetTimer()
        } else {
            // Token is genuinely invalid — force logout
            logout()
        }
    }

    const handleLogout = () => {
        setShowWarning(false)
        logout()
    }

    return (
        <>
            {showWarning && user && (
                <InactivityModal
                    onStayLoggedIn={handleStayLoggedIn}
                    onLogout={handleLogout}
                />
            )}
            <Header />
            {/* view-transition-name lives here, not on #root — this is what keeps
                Header (logo, nav links, username, sign out) static while only the
                routed page content scales/fades. See index.css. */}
            <div className="route-transition-target">
                <Routes>
                    <Route path="/login"  element={<PublicRoute><Login /></PublicRoute>} />
                    <Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} />
                    <Route path="/"             element={<ProtectedRoute><Home /></ProtectedRoute>} />
                    <Route path="/create-class"          element={<ProtectedRoute><CreateClass /></ProtectedRoute>} />
                    <Route path="/student-marking/:lessonId" element={<ProtectedRoute><StudentMarking /></ProtectedRoute>} />
                    <Route path="/select-question/:lessonId" element={<ProtectedRoute><SelectQuestion /></ProtectedRoute>} />
                    <Route path="/student-feedback/:lessonId" element={<ProtectedRoute><StudentFeedback /></ProtectedRoute>} />
                    <Route path="*"                      element={<Navigate to="/" replace />} />
                </Routes>
            </div>
        </>
    )
}

function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AppContent />
            </AuthProvider>
        </BrowserRouter>
    )
}

export default App
