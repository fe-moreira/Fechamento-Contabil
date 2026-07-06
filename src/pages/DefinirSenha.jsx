import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

// Tela aberta pelo link de convite/redefinição. O token do link cria a sessão
// (detectSessionInUrl) e aqui a pessoa define a própria senha.
export default function DefinirSenha() {
  const nav = useNavigate()
  const [temSessao, setTemSessao] = useState(null) // null = verificando
  const [senha, setSenha] = useState('')
  const [conf, setConf] = useState('')
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setTemSessao(s => s ?? !!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (s) setTemSessao(true) })
    // dá um tempo para o token do link ser processado antes de decidir "sem sessão"
    const t = setTimeout(() => setTemSessao(v => (v === null ? false : v)), 2500)
    return () => { sub.subscription.unsubscribe(); clearTimeout(t) }
  }, [])

  async function salvar(e) {
    e.preventDefault(); setErro('')
    if (senha.length < 6) { setErro('A senha precisa ter ao menos 6 caracteres.'); return }
    if (senha !== conf) { setErro('As senhas não conferem.'); return }
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: senha })
    setBusy(false)
    if (error) { setErro(error.message); return }
    setOk(true)
    setTimeout(() => nav('/', { replace: true }), 1200)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: theme.contentBg }}>
      <div style={{ width: 380, background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 28 }}>
        <h1 style={{ fontSize: 19, marginBottom: 4 }}>Definir senha</h1>
        <p style={{ color: theme.sub, fontSize: 13, marginBottom: 20 }}>Contabilidade by Attentive</p>

        {ok ? (
          <p style={{ color: theme.green, fontSize: 14 }}><i className="ti ti-circle-check" /> Senha definida! Entrando…</p>
        ) : temSessao === false ? (
          <>
            <p style={{ color: theme.red, fontSize: 13.5, lineHeight: 1.5, marginBottom: 14 }}>
              Este link não é válido ou expirou. Peça um novo convite / link de redefinição ao administrador.
            </p>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => nav('/login', { replace: true })}>Ir para o login</button>
          </>
        ) : temSessao === null ? (
          <p style={{ color: theme.sub, fontSize: 13 }}>Validando o link…</p>
        ) : (
          <form onSubmit={salvar}>
            <label>Nova senha</label>
            <input className="input" type="password" value={senha} onChange={e => setSenha(e.target.value)} required style={{ marginBottom: 14 }} placeholder="mín. 6 caracteres" />
            <label>Confirmar senha</label>
            <input className="input" type="password" value={conf} onChange={e => setConf(e.target.value)} required style={{ marginBottom: 18 }} />
            {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}
            <button className="btn" style={{ width: '100%' }} disabled={busy}>{busy ? 'Salvando…' : 'Definir senha e entrar'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
