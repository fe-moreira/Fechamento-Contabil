import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

// Por segurança, desloga automaticamente após 20 min sem interação do usuário.
const OCIOSO_MS = 20 * 60 * 1000

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef(null); sessionRef.current = session

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Auto-logout por inatividade: qualquer interação reinicia a contagem de 20 min.
  useEffect(() => {
    let timer = null
    const reiniciar = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (sessionRef.current) supabase.auth.signOut()
      }, OCIOSO_MS)
    }
    const eventos = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    eventos.forEach(ev => window.addEventListener(ev, reiniciar, { passive: true }))
    reiniciar()
    return () => {
      if (timer) clearTimeout(timer)
      eventos.forEach(ev => window.removeEventListener(ev, reiniciar))
    }
  }, [])

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    signOut: () => supabase.auth.signOut(),
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
