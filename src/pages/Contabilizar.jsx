import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'

const vazio = {
  data: '', conta_debito: '', conta_credito: '', valor: '', historico: '', documento: '',
}

export default function Contabilizar() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState(vazio)
  const [salvando, setSalvando] = useState(false)
  const [aberto, setAberto] = useState(false)

  // Resolve o id da competência apenas para leitura (sem criar a linha).
  async function competenciaIdLeitura() {
    if (!empresaId) return null
    const [mes, ano] = competencia.split('/').map(Number)
    const { data } = await supabase
      .from('competencias').select('id')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    return data?.id ?? null
  }

  async function carregar() {
    setLoading(true); setErro('')
    const compId = await competenciaIdLeitura()
    if (!compId) { setLista([]); setLoading(false); return }
    const { data, error } = await supabase
      .from('lancamentos').select('*')
      .eq('competencia_id', compId).order('data', { ascending: true })
    if (error) setErro(error.message)
    else setLista(data || [])
    setLoading(false)
  }

  useEffect(() => {
    if (!empresaId) { setLista([]); setLoading(false); return }
    carregar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId, competencia])

  function abrirNovo() { setForm(vazio); setAberto(true) }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function salvar(e) {
    e.preventDefault(); setSalvando(true); setErro('')
    try {
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setErro('Selecione uma empresa no menu lateral.'); setSalvando(false); return }
      const payload = {
        competencia_id,
        data: form.data || null,
        conta_debito: form.conta_debito.trim() || null,
        conta_credito: form.conta_credito.trim() || null,
        valor: Number(form.valor) || 0,
        historico: form.historico.trim() || null,
        documento: form.documento.trim() || null,
        origem: 'manual',
      }
      const { error } = await supabase.from('lancamentos').insert(payload)
      if (error) throw error
      setAberto(false); carregar()
    } catch (err) {
      setErro(err.message)
    } finally {
      setSalvando(false)
    }
  }

  async function excluir(l) {
    if (!confirm('Excluir este lançamento?')) return
    const { error } = await supabase.from('lancamentos').delete().eq('id', l.id)
    if (error) setErro(error.message); else carregar()
  }

  function gerarDominio() {
    const sep = ';'
    const cols = [
      'Data', 'Cód. Conta Débito', 'Cód. Conta Crédito', 'Valor',
      'Cód. Histórico', 'Complemento Histórico', 'Inicia Lote',
      'Código Matriz/Filial', 'CC Débito', 'CC Crédito',
    ]
    const linhas = [cols.join(sep)]
    lista.forEach((l, i) => {
      const valor = (Number(l.valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
      const data = l.data ? l.data.split('-').reverse().join('/') : ''
      linhas.push([
        data,                       // Data
        l.conta_debito || '',       // Cód. Conta Débito
        l.conta_credito || '',      // Cód. Conta Crédito
        valor,                      // Valor
        '',                         // Cód. Histórico (em branco)
        l.historico || '',          // Complemento Histórico
        i === 0 ? '1' : '',         // Inicia Lote (apenas na primeira linha)
        '',                         // Código Matriz/Filial
        '',                         // CC Débito
        '',                         // CC Crédito
      ].join(sep))
    })
    const conteudo = '﻿' + linhas.join('\r\n')
    const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `dominio_${competencia.replace('/', '-')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!empresaId) {
    return (
      <Wrapper>
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
          <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Selecione uma empresa no menu lateral.</p>
        </div>
      </Wrapper>
    )
  }

  const total = lista.reduce((s, l) => s + (Number(l.valor) || 0), 0)

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>Erro: {erro}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 24 }}>
          <Stat label="Lançamentos" valor={lista.length} />
          <Stat label="Total" valor={money(total)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={gerarDominio} disabled={lista.length === 0}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-file-download" /> Gerar arquivo Domínio
          </button>
          <button className="btn" onClick={abrirNovo}>+ Novo lançamento</button>
        </div>
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr style={{ background: theme.input }}>
              {['Data', 'Conta débito', 'Conta crédito', 'Valor', 'Histórico', 'Origem', ''].map((h, i) => (
                <th key={i} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 20, color: theme.sub }}>Nenhum lançamento nesta competência. Clique em “+ Novo lançamento”.</td></tr>
            ) : lista.map(l => (
              <tr key={l.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ ...td, color: theme.sub }}>{l.data ? l.data.split('-').reverse().join('/') : ''}</td>
                <td style={td}>{l.conta_debito || ''}</td>
                <td style={td}>{l.conta_credito || ''}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                <td style={{ ...td, maxWidth: 320 }}>{l.historico || ''}</td>
                <td style={{ ...td, color: theme.sub }}>{l.origem || ''}</td>
                <td style={{ padding: '9px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(l)}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberto && (
        <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <form onClick={e => e.stopPropagation()} onSubmit={salvar} style={{ width: 560, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 16 }}>Novo lançamento</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Campo label="Data"><input className="input" type="date" value={form.data} onChange={set('data')} required /></Campo>
              <Campo label="Valor"><input className="input" type="number" step="0.01" value={form.valor} onChange={set('valor')} required /></Campo>
              <Campo label="Conta débito"><input className="input" value={form.conta_debito} onChange={set('conta_debito')} required /></Campo>
              <Campo label="Conta crédito"><input className="input" value={form.conta_credito} onChange={set('conta_credito')} required /></Campo>
              <Campo label="Documento"><input className="input" value={form.documento} onChange={set('documento')} /></Campo>
              <Campo label="Histórico" full><textarea className="input" rows={2} value={form.historico} onChange={set('historico')} /></Campo>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(false)}>Cancelar</button>
              <button className="btn" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const td = { padding: '11px 14px', fontSize: 13, color: theme.text }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Contabilizar</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Fila de lançamentos da competência. Sem etapa de aprovação.</p>
      {children}
    </div>
  )
}

function Stat({ label, valor }) {
  return (
    <div>
      <p style={{ color: theme.sub, fontSize: 12, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 700 }}>{valor}</p>
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
