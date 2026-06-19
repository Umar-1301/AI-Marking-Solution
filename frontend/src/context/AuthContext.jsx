import { createContext, useContext, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { refreshSession } from '../services/api'

// Relative path — see services/api.js for why.
const API_BASE = '/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const navigate = useNavigate()

    // Only the user object lives in state/localStorage — the token is an
    // httpOnly cookie managed entirely by the backend and never readable by JS.
    // Remove the legacy aimira_token key written by the pre-cookie version of
    // this app; leaving it causes stale-state confusion on first load.
    localStorage.removeItem('aimira_token')

    const [user, setUser] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('aimira_user') ?? 'null')
        } catch {
            return null
        }
    })

    const login = (newUser) => {
        localStorage.setItem('aimira_user', JSON.stringify(newUser))
        setUser(newUser)
    }

    const logout = async () => {
        // Tell the backend to clear the httpOnly cookie server-side
        try {
            await fetch(`${API_BASE}/auth/logout`, {
                method: 'POST',
                credentials: 'include',
            })
        } catch {
            // If the request fails the cookie will expire naturally via its maxAge
        }
        localStorage.removeItem('aimira_user')
        setUser(null)
        navigate('/login')
    }

    // Called by the inactivity modal "Stay logged in" button.
    // The cookie is sent automatically; the backend issues a fresh cookie
    // and returns the updated user object.
    const refreshToken = async () => {
        const data = await refreshSession()
        if (!data) return false
        login(data.user)
        return true
    }

    return (
        <AuthContext.Provider value={{ user, login, logout, refreshToken }}>
            {children}
        </AuthContext.Provider>
    )
}

export const useAuth = () => useContext(AuthContext)
