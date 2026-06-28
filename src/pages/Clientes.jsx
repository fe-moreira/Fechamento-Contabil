import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

const vazio = {
  codigo_dominio: '', tipo: 'Matriz', codigo_matriz: '', razao_social: '',
  nome_fantasia: '', cnpj: '', regime_tributario: 'Simples', tipo_fechamento: '',
  competencia_inicio: '', integracao_financeira: 'Não usa', analista: '', observacoes: '',
}

// Helpers da importação em lote (planilha-modelo: aba "Clientes", 15 colunas).
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const txt = (v) => { const s = String(v ?? '').trim(); return s || null }
const simNao = (v) => /^sim/i.test(String(v ?? '').trim())

export default function Clientes() {
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState(vazio)
  const [salvando, setSalvando] = useState(false)
  const [editId, setEditId] = useState(null)
  const [aberto, setAberto] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileRef = useRef(null)

  async function carregar() {
    setLoading(true); setErro('')
    const { data, error } = await supabase
      .from('clientes').select('*').order('razao_social', { ascending: true })
    if (error) setErro(error.message)
    else setLista(data || [])
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  async function importarPlanilha(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setErro(''); setImportMsg('Lendo planilha…')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const aba = wb.SheetNames.find(n => n.toLowerCase().includes('client')) || wb.SheetNames[wb.SheetNames.length - 1]
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '' })
      if (linhas.length < 2) { setImportMsg(''); setErro('A aba de clientes está vazia.'); return }

      const H = linhas[0].map(norm)
      const col = {
        codigo_dominio: H.findIndex(h => h.includes('codigo') && h.includes('dominio')),
        tipo: H.findIndex(h => h === 'tipo'),
        codigo_matriz: H.findIndex(h => h.includes('codigo') && h.includes('matriz')),
        razao_social: H.findIndex(h => h.includes('razao')),
        nome_fantasia: H.findIndex(h => h.includes('fantasia')),
        cnpj: H.findIndex(h => h.includes('cnpj')),
        regime_tributario: H.findIndex(h => h.includes('regime')),
        tipo_fechamento: H.findIndex(h => h.includes('tipo') && h.includes('fechamento')),
        competencia_inicio: H.findIndex(h => h.includes('competencia')),
        carga_saldos: H.findIndex(h => h.includes('carga')),
        coleta_razao: H.findIndex(h => h.includes('coleta')),
        sistema_financeiro: H.findIndex(h => h.includes('sistema')),
        integracao_financeira: H.findIndex(h => h.includes('integracao')),
        analista: H.findIndex(h => h.includes('analista')),
        observacoes: H.findIndex(h => h.includes('observ')),
      }
      const g = (row, k) => (col[k] >= 0 ? row[col[k]] : '')

      const novos = []
      for (const row of linhas.slice(1)) {
        const cod = String(g(row, 'codigo_dominio') ?? '').trim()
        const razao = String(g(row, 'razao_social') ?? '').trim()
        if (!cod && !razao) continue
        const tipo = norm(g(row, 'tipo')).startsWith('fil') ? 'Filial' : 'Matriz'
        novos.push({
          codigo_dominio: cod || null, tipo,
          codigo_matriz: tipo === 'Filial' ? (String(g(row, 'codigo_matriz') ?? '').trim() || null) : null,
          razao_social: razao || null,
          nome_fantasia: txt(g(row, 'nome_fantasia')),
          cnpj: txt(g(row, 'cnpj')),
          regime_tributario: txt(g(row, 'regime_tributario')),
          tipo_fechamento: txt(g(row, 'tipo_fechamento')),
          competencia_inicio: txt(g(row, 'competencia_inicio')),
          carga_saldos: simNao(g(row, 'carga_saldos')),
          coleta_razao: simNao(g(row, 'coleta_razao')),
          sistema_financeiro: txt(g(row, 'sistema_financeiro')),
          integracao_financeira: txt(g(row, 'integracao_financeira')) || 'Não usa',
          analista: txt(g(row, 'analista')),
          observacoes: txt(g(row, 'observacoes')),
        })
      }
      if (!novos.length) { setImportMsg(''); setErro('Nenhuma linha de cliente encontrada na planilha.'); return }

      // Evita duplicar: ignora códigos já cadastrados.
      const { data: existentes } = await supabase.from('clientes').select('codigo_dominio')
      const jaTem = new Set((existentes || []).map(c => c.codigo_dominio))
      const aInserir = novos.filter(c => !c.codigo_dominio || !jaTem.has(c.codigo_dominio))
      const ignorados = novos.length - aInserir.length
      if (!aInserir.length) { setImportMsg(''); setErro(`Todos os ${novos.length} clientes da planilha já estão cadastrados.`); return }

      const { error } = await supabase.from('clientes').insert(aInserir)
      if (error) { setImportMsg(''); setErro(error.message); return }
      setImportMsg(`${aInserir.length} cliente(s) importado(s)${ignorados ? ` · ${ignorados} já existente(s) ignorado(s)` : ''}.`)
      carregar()
    } catch (err) {
      setImportMsg(''); setErro('Erro ao importar: ' + err.message)
    }
  }

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a className="btn btn-ghost" href="/modelo-importacao-clientes.xlsx" download
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-file-spreadsheet" /> Baixar modelo
          </a>
          <button className="btn btn-ghost" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => fileRef.current?.click()}>
            <i className="ti ti-file-import" /> Importar planilha
          </button>
          <button className="btn" onClick={abrirNovo}>+ Novo cliente</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={importarPlanilha} />
        </div>
      </div>

      {importMsg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 14 }}><i className="ti ti-circle-check" /> {importMsg}</p>}
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
