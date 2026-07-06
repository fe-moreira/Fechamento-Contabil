import { useState } from 'react'
import { useAuth } from '../components/AuthProvider'
import { theme } from '../lib/theme'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState(false)

  async function entrar(e) {
    e.preventDefault()
    setErro(''); setBusy(true)
    const { error } = await signIn(email, password)
    setBusy(false)
    if (error) setErro(error.message)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: theme.contentBg }}>
      <form onSubmit={entrar} style={{ width: 360, background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 28 }}>
        <h1 style={{ fontSize: 19, marginBottom: 4 }}>Contabilidade by Attentive</h1>
        <p style={{ color: theme.sub, fontSize: 13, marginBottom: 20 }}>Entre para continuar</p>

        <label>E-mail</label>
        <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} required style={{ marginBottom: 14 }} />

        <label>Senha</label>
        <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required style={{ marginBottom: 18 }} />

        {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}

        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <p style={{ color: theme.sub, fontSize: 11.5, marginTop: 14, lineHeight: 1.5 }}>
          O acesso é por convite — um administrador cria o seu usuário em Configurações → Usuários. Sem cadastro aberto.
        </p>
      </form>
    </div>
  )
}
