import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../components/AuthProvider'
import { theme } from '../lib/theme'

const dataPtBR = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
// Sugestão de senha simples e digitável.
const senhaAleatoria = () => {
  const a = 'abcdefghijkmnpqrstuvwxyz', A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', n = '23456789'
  const p = s => s[Math.floor(Math.random() * s.length)]
  return p(A) + p(a) + p(a) + p(a) + p(n) + p(n) + p(a) + p(a)
}

// Chama a Edge Function admin-usuarios (a service_role fica só no servidor).
async function chamar(acao, extra = {}) {
  const { data, error } = await supabase.functions.invoke('admin-usuarios', { body: { acao, ...extra } })
  if (error) {
    let m = error.message
    try { const ctx = await error.context?.json?.(); if (ctx?.error) m = ctx.error } catch { /* ignora */ }
    throw new Error(m)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export default function Usuarios() {
  const { user } = useAuth()
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [novo, setNovo] = useState(false)        // modal novo usuário
  const [senhaDe, setSenhaDe] = useState(null)   // usuário existente p/ definir senha
  const [convite, setConvite] = useState(null)   // { email, link, reset }

  async function carregar() {
    setLoading(true); setErro('')
    try { const d = await chamar('listar'); setLista(d.usuarios || []) }
    catch (e) { setErro(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { carregar() }, [])

  async function excluir(u) {
    setErro(''); setMsg('')
    if (u.email === user?.email) { setErro('Você não pode excluir o seu próprio usuário.'); return }
    if (!confirm(`Excluir o usuário ${u.email}?`)) return
    try { await chamar('excluir', { id: u.id }); setMsg('Usuário excluído.'); carregar() }
    catch (e) { setErro(e.message) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Usuários</h1>
          <p style={{ color: theme.sub, fontSize: 13, marginTop: 2 }}>Acesso à plataforma · perfil único (ADM). {lista.length} usuário(s).</p>
        </div>
        <button className="btn" onClick={() => { setNovo(true); setErro('') }}><i className="ti ti-user-plus" /> Novo usuário</button>
      </div>

      {msg && <p style={{ color: theme.green, fontSize: 13, margin: '10px 0' }}><i className="ti ti-circle-check" /> {msg}</p>}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '10px 0' }}>Erro: {erro}</p>}

      {/* Link de convite/redefinição (opção secundária) */}
      {convite && (
        <div style={{ background: 'rgba(74,124,255,0.10)', border: `1px solid ${theme.accent}`, borderRadius: 12, padding: 16, margin: '10px 0 16px' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, margin: '0 0 6px' }}>
            <i className="ti ti-link" style={{ color: theme.accent, marginRight: 6 }} /> Link para {convite.email}
          </p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>
            Uso único e expira rápido. Se enviar por WhatsApp/e-mail, a pré-visualização pode "consumir" o link — nesse caso, prefira definir a senha direto.
          </p>
          {convite.link && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input" readOnly value={convite.link} onFocus={e => e.target.select()} style={{ flex: 1, minWidth: 260, fontSize: 12 }} />
              <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(convite.link); setMsg('Link copiado.') }}><i className="ti ti-copy" /> Copiar</button>
              <button className="btn btn-ghost" onClick={() => setConvite(null)}>Fechar</button>
            </div>
          )}
        </div>
      )}

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              {['E-mail', 'Situação', 'Último acesso', 'Criado', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 20, color: theme.sub }}>Nenhum usuário.</td></tr>
            ) : lista.map(u => (
              <tr key={u.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ padding: '11px 14px', fontSize: 13 }}>{u.email}{u.email === user?.email && <span style={{ color: theme.sub, fontSize: 11 }}> (você)</span>}</td>
                <td style={{ padding: '11px 14px', fontSize: 12.5 }}>
                  {u.ultimo_acesso
                    ? <span style={{ color: theme.green }}><i className="ti ti-circle-check" /> Ativo</span>
                    : <span style={{ color: theme.yellow }}><i className="ti ti-clock" /> Nunca acessou</span>}
                </td>
                <td style={{ padding: '11px 14px', fontSize: 12.5, color: theme.sub, whiteSpace: 'nowrap' }}>{dataPtBR(u.ultimo_acesso)}</td>
                <td style={{ padding: '11px 14px', fontSize: 12.5, color: theme.sub, whiteSpace: 'nowrap' }}>{dataPtBR(u.criado)}</td>
                <td style={{ padding: '11px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12, marginRight: 6 }} onClick={() => { setSenhaDe(u); setErro('') }}>definir senha</button>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(u)} disabled={u.email === user?.email}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {novo && (
        <ModalNovo
          onClose={() => setNovo(false)}
          onCriado={(m) => { setNovo(false); setMsg(m); carregar() }}
          onLink={(c) => { setNovo(false); setConvite(c) }}
        />
      )}
      {senhaDe && (
        <ModalSenha
          usuario={senhaDe}
          onClose={() => setSenhaDe(null)}
          onSalvo={(m) => { setSenhaDe(null); setMsg(m); carregar() }}
        />
      )}
    </div>
  )
}

// Novo usuário: método principal = e-mail + senha (o admin passa a senha). Secundário: link de convite.
function ModalNovo({ onClose, onCriado, onLink }) {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState(false)

  async function criar(e) {
    e.preventDefault(); setErro(''); setBusy(true)
    try {
      await chamar('criar_senha', { email: email.trim().toLowerCase(), senha })
      onCriado(`Usuário criado: ${email.trim().toLowerCase()} · senha "${senha}". Passe essas credenciais para a pessoa.`)
    } catch (err) { setErro(err.message) } finally { setBusy(false) }
  }
  async function gerarLink() {
    setErro(''); setBusy(true)
    try { const d = await chamar('convidar', { email: email.trim().toLowerCase() }); onLink({ email: d.email, link: d.link }) }
    catch (err) { setErro(err.message) } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={criar}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Novo usuário</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>Defina uma senha e passe as credenciais para a pessoa (perfil ADM). Ela pode trocar depois.</p>
        {erro && <p style={{ color: theme.red, fontSize: 12.5, marginBottom: 12 }}>{erro}</p>}
        <label>E-mail</label>
        <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required placeholder="nome@empresa.com.br" style={{ marginBottom: 12 }} />
        <label>Senha</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={senha} onChange={e => setSenha(e.target.value)} required minLength={6} placeholder="mín. 6 caracteres" style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={() => setSenha(senhaAleatoria())} title="Sugerir senha"><i className="ti ti-dice" /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12.5 }} disabled={busy || !email.trim()} onClick={gerarLink} title="Gera um link para a pessoa definir a própria senha">
            <i className="ti ti-link" /> Prefiro enviar um link
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button className="btn" disabled={busy}>{busy ? 'Criando…' : 'Criar usuário'}</button>
          </div>
        </div>
      </form>
    </Overlay>
  )
}

// Define/redefine a senha de um usuário existente.
function ModalSenha({ usuario, onClose, onSalvo }) {
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState(false)

  async function salvar(e) {
    e.preventDefault(); setErro(''); setBusy(true)
    try {
      await chamar('definir_senha', { id: usuario.id, senha })
      onSalvo(`Senha definida para ${usuario.email}: "${senha}". Passe para a pessoa.`)
    } catch (err) { setErro(err.message) } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={salvar}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Definir senha</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}><b style={{ color: theme.text }}>{usuario.email}</b><br />Defina uma senha e passe para a pessoa. Ela entra na hora e pode trocar depois.</p>
        {erro && <p style={{ color: theme.red, fontSize: 12.5, marginBottom: 12 }}>{erro}</p>}
        <label>Nova senha</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={senha} onChange={e => setSenha(e.target.value)} autoFocus required minLength={6} placeholder="mín. 6 caracteres" style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={() => setSenha(senhaAleatoria())} title="Sugerir senha"><i className="ti ti-dice" /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy}>{busy ? 'Salvando…' : 'Salvar senha'}</button>
        </div>
      </form>
    </Overlay>
  )
}

function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(460px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        {children}
      </div>
    </div>
  )
}
