import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../components/AuthProvider'
import { theme } from '../lib/theme'

const dataPtBR = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

// Chama a Edge Function admin-usuarios (a service_role fica só no servidor).
async function chamar(acao, extra = {}) {
  const { data, error } = await supabase.functions.invoke('admin-usuarios', {
    body: { acao, redirectTo: window.location.origin + '/definir-senha', ...extra },
  })
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
  const [modal, setModal] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [convite, setConvite] = useState(null) // { email, link, reset }

  async function carregar() {
    setLoading(true); setErro('')
    try { const d = await chamar('listar'); setLista(d.usuarios || []) }
    catch (e) { setErro(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { carregar() }, [])

  async function convidar(e) {
    e.preventDefault(); setBusy(true); setErro(''); setMsg('')
    try {
      const d = await chamar('convidar', { email: email.trim().toLowerCase() })
      setConvite({ email: d.email, link: d.link })
      setModal(false); setEmail(''); carregar()
    } catch (err) { setErro(err.message) } finally { setBusy(false) }
  }

  async function redefinir(u) {
    setErro(''); setMsg('')
    try { const d = await chamar('link_senha', { email: u.email }); setConvite({ email: u.email, link: d.link, reset: true }) }
    catch (e) { setErro(e.message) }
  }

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
        <button className="btn" onClick={() => { setModal(true); setEmail(''); setErro('') }}><i className="ti ti-user-plus" /> Convidar usuário</button>
      </div>

      {msg && <p style={{ color: theme.green, fontSize: 13, margin: '10px 0' }}><i className="ti ti-circle-check" /> {msg}</p>}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '10px 0' }}>Erro: {erro}</p>}

      {/* Convite / link de redefinição gerado */}
      {convite && (
        <div style={{ background: 'rgba(74,124,255,0.10)', border: `1px solid ${theme.accent}`, borderRadius: 12, padding: 16, margin: '10px 0 16px' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, margin: '0 0 6px' }}>
            <i className="ti ti-link" style={{ color: theme.accent, marginRight: 6 }} />
            {convite.reset ? 'Link para redefinir a senha' : 'Convite criado'} — {convite.email}
          </p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>
            Envie este link para a pessoa. Ao abrir, ela define a própria senha e entra. O link é de uso único e expira.
          </p>
          {convite.link ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input" readOnly value={convite.link} onFocus={e => e.target.select()} style={{ flex: 1, minWidth: 260, fontSize: 12 }} />
              <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(convite.link); setMsg('Link copiado.') }}><i className="ti ti-copy" /> Copiar</button>
              <button className="btn btn-ghost" onClick={() => setConvite(null)}>Fechar</button>
            </div>
          ) : (
            <p style={{ color: theme.yellow, fontSize: 12.5, margin: 0 }}>O convite foi enviado por e-mail (não foi possível exibir o link aqui).</p>
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
                  {u.confirmado
                    ? <span style={{ color: theme.green }}><i className="ti ti-circle-check" /> Ativo</span>
                    : <span style={{ color: theme.yellow }}><i className="ti ti-mail-forward" /> Convite pendente</span>}
                </td>
                <td style={{ padding: '11px 14px', fontSize: 12.5, color: theme.sub, whiteSpace: 'nowrap' }}>{dataPtBR(u.ultimo_acesso)}</td>
                <td style={{ padding: '11px 14px', fontSize: 12.5, color: theme.sub, whiteSpace: 'nowrap' }}>{dataPtBR(u.criado)}</td>
                <td style={{ padding: '11px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12, marginRight: 6 }} onClick={() => redefinir(u)}>redefinir senha</button>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(u)} disabled={u.email === user?.email}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <div onClick={() => setModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <form onClick={e => e.stopPropagation()} onSubmit={convidar} style={{ width: 'min(440px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>Convidar usuário</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>Informe o e-mail. A ferramenta gera um link de convite para a pessoa definir a própria senha (perfil ADM).</p>
            {erro && <p style={{ color: theme.red, fontSize: 12.5, marginBottom: 12 }}>{erro}</p>}
            <label>E-mail</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required placeholder="nome@empresa.com.br" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Cancelar</button>
              <button className="btn" disabled={busy}>{busy ? 'Gerando…' : 'Gerar convite'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
