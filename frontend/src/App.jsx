import { useState, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
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

function Header() {
    const { user, logout } = useAuth()

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
                    <span className="brand-name">AIMIRA</span>
                    <span className="brand-badge">Beta</span>
                </div>

                {user && (
                    <nav className="header-nav">
                        <NavLink to="/" end className="header-nav-link">Home</NavLink>
                        <NavLink to="/create-class" className="header-nav-link">Create Class</NavLink>
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
