import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

const vazio = {
  codigo_dominio: '', tipo: 'Matriz', codigo_matriz: '', razao_social: '',
  nome_fantasia: '', cnpj: '', regime_tributario: 'Simples', tipo_fechamento: '',
  competencia_inicio: '', integracao_financeira: 'Não usa', analista: '', observacoes: '',
}

export default function Clientes() {
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState(vazio)
  const [salvando, setSalvando] = useState(false)
  const [editId, setEditId] = useState(null)
  const [aberto, setAberto] = useState(false)

  async function carregar() {
    setLoading(true); setErro('')
    const { data, error } = await supabase
      .from('clientes').select('*').order('razao_social', { ascending: true })
    if (error) setErro(error.message)
    else setLista(data || [])
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  function abrirNovo() { setForm(vazio); setEditId(null); setAberto(true) }
  function abrirEdit(c) { setForm({ ...vazio, ...c }); setEditId(c.id); setAberto(true) }

  async function salvar(e) {
    e.preventDefault(); setSalvando(true); setErro('')
    const payload = { ...form }
    if (payload.tipo === 'Matriz') payload.codigo_matriz = null
    let res
    if (editId) res = await supabase.from('clientes').update(payload).eq('id', editId)
    else res = await supabase.from('clientes').insert(payload)
    setSalvando(false)
    if (res.error) { setErro(res.error.message); return }
    setAberto(false); carregar()
  }

  async function excluir(c) {
    if (!confirm(`Excluir ${c.razao_social}?`)) return
    const { error } = await supabase.from('clientes').delete().eq('id', c.id)
    if (error) setErro(error.message); else carregar()
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>Clientes</h1>
          <p style={{ color: theme.sub, fontSize: 13, marginTop: 2 }}>{lista.length} cadastrado(s)</p>
        </div>
        <button className="btn" onClick={abrirNovo}>+ Novo cliente</button>
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>Erro: {erro}</p>}

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr style={{ background: theme.input }}>
              {['Código', 'Razão social', 'Regime', 'Integração fin.', 'Analista', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 20, color: theme.sub }}>Nenhum cliente. Clique em “+ Novo cliente”.</td></tr>
            ) : lista.map(c => (
              <tr key={c.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.codigo_dominio}{c.tipo === 'Filial' ? ' (filial)' : ''}</td>
                <td style={{ padding: '11px 14px', fontSize: 13 }}>{c.razao_social}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.regime_tributario}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.integracao_financeira}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.analista}</td>
                <td style={{ padding: '11px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12, marginRight: 6 }} onClick={() => abrirEdit(c)}>editar</button>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(c)}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberto && (
        <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <form onClick={e => e.stopPropagation()} onSubmit={salvar} style={{ width: 560, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 16 }}>{editId ? 'Editar cliente' : 'Novo cliente'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Campo label="Código no Domínio"><input className="input" value={form.codigo_dominio} onChange={set('codigo_dominio')} required /></Campo>
              <Campo label="Tipo">
                <select className="input" value={form.tipo} onChange={set('tipo')}>
                  <option>Matriz</option><option>Filial</option>
                </select>
              </Campo>
              {form.tipo === 'Filial' && (
                <Campo label="Código da matriz"><input className="input" value={form.codigo_matriz || ''} onChange={set('codigo_matriz')} /></Campo>
              )}
              <Campo label="Razão social" full={form.tipo !== 'Filial'}><input className="input" value={form.razao_social} onChange={set('razao_social')} required /></Campo>
              <Campo label="Nome fantasia"><input className="input" value={form.nome_fantasia || ''} onChange={set('nome_fantasia')} /></Campo>
              <Campo label="CNPJ"><input className="input" value={form.cnpj || ''} onChange={set('cnpj')} /></Campo>
              <Campo label="Regime tributário">
                <select className="input" value={form.regime_tributario} onChange={set('regime_tributario')}>
                  <option>Simples</option><option>Presumido</option><option>Real</option>
                </select>
              </Campo>
              <Campo label="Tipo de fechamento"><input className="input" value={form.tipo_fechamento || ''} onChange={set('tipo_fechamento')} /></Campo>
              <Campo label="Competência de início (MM/AAAA)"><input className="input" value={form.competencia_inicio || ''} onChange={set('competencia_inicio')} placeholder="01/2026" /></Campo>
              <Campo label="Integração financeira">
                <select className="input" value={form.integracao_financeira} onChange={set('integracao_financeira')}>
                  <option>Não usa</option><option>Sistema</option><option>Excel</option>
                </select>
              </Campo>
              <Campo label="Analista"><input className="input" value={form.analista || ''} onChange={set('analista')} /></Campo>
              <Campo label="Observações" full><textarea className="input" rows={2} value={form.observacoes || ''} onChange={set('observacoes')} /></Campo>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(false)}>Cancelar</button>
              <button className="btn" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function Campo({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label>{label}</label>
      {children}
    </div>
  )
}
