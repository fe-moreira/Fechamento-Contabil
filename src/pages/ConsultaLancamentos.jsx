import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'
import InfoTela from '../components/InfoTela'

const PAGE = 200 // resultados por página — "carregar mais" busca o próximo bloco no banco.

// Converte "1.234,56" (pt-BR) em número. Vazio → null.
function parseBR(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export default function ConsultaLancamentos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, plano } = useAppData()
  const nomePorConta = Object.fromEntries((plano || []).map(p => [String(p.cod), p.nome]))

  const [f, setF] = useState({ dataDe: '', dataAte: '', conta: '', valor: '', historico: '' })
  const set = (k, v) => setF(o => ({ ...o, [k]: v }))
  const [linhas, setLinhas] = useState(null) // null = ainda não buscou
  const [carregando, setCarregando] = useState(false)
  const [temMais, setTemMais] = useState(false)
  const [msg, setMsg] = useState('')

  // Monta a query no banco (filtros server-side). Cada filtro é opcional — um sozinho já vale.
  function construir(compId) {
    let q = supabase.from('razao')
      .select('data, conta, contrapartida, historico, debito, credito')
      .eq('competencia_id', compId)
    if (f.dataDe) q = q.gte('data', f.dataDe)
    if (f.dataAte) q = q.lte('data', f.dataAte)
    const c = f.conta.trim()
    if (c) q = q.or(`conta.ilike.%${c}%,contrapartida.ilike.%${c}%`)
    const val = parseBR(f.valor)
    if (val != null) q = q.or(`debito.eq.${val},credito.eq.${val}`)
    const h = f.historico.trim()
    if (h) q = q.ilike('historico', `%${h}%`)
    return q.order('data', { ascending: true })
  }

  async function buscar(reset = true) {
    if (!empresaId) return
    setCarregando(true); setMsg('')
    try {
      const compId = await getCompetenciaId()
      if (!compId) { setLinhas([]); setMsg('Sem razão importado nesta competência.'); return }
      const from = reset ? 0 : (linhas?.length || 0)
      const { data, error } = await construir(compId).range(from, from + PAGE - 1)
      if (error) { setMsg('Erro na busca: ' + error.message); return }
      const novos = data || []
      setLinhas(reset ? novos : [...(linhas || []), ...novos])
      setTemMais(novos.length === PAGE)
    } finally { setCarregando(false) }
  }

  function limpar() { setF({ dataDe: '', dataAte: '', conta: '', valor: '', historico: '' }); setLinhas(null); setTemMais(false); setMsg('') }

  const contaLabel = cod => { const n = nomePorConta[String(cod)]; return n ? `${cod} · ${n}` : (cod || '—') }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Consulta de Lançamentos</h1>
        <InfoTela titulo="Consulta de Lançamentos">Procura no razão da competência <b>onde um lançamento caiu</b>. Filtre por <b>data</b>, <b>conta</b> (conta ou contrapartida), <b>valor</b> (débito ou crédito) ou <b>histórico</b> — qualquer um sozinho já busca. O resultado mostra os <b>dois lados da partida</b> (conta × contrapartida). A busca roda no banco e vem paginada, então não esbarra no limite de linhas.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome || 'Selecione uma empresa'}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Filtros */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'end' }}>
        <div>
          <label>Data — de</label>
          <input className="input" type="date" value={f.dataDe} onChange={e => set('dataDe', e.target.value)} />
        </div>
        <div>
          <label>Data — até</label>
          <input className="input" type="date" value={f.dataAte} onChange={e => set('dataAte', e.target.value)} />
        </div>
        <div>
          <label>Conta (ou contrapartida)</label>
          <input className="input" value={f.conta} onChange={e => set('conta', e.target.value)} placeholder="código da conta" />
        </div>
        <div>
          <label>Valor (débito ou crédito)</label>
          <input className="input" value={f.valor} onChange={e => set('valor', e.target.value)} placeholder="0,00" onKeyDown={e => e.key === 'Enter' && buscar()} />
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Histórico contém</label>
            <input className="input" value={f.historico} onChange={e => set('historico', e.target.value)} placeholder="texto do histórico" onKeyDown={e => e.key === 'Enter' && buscar()} />
          </div>
          <button className="btn" onClick={() => buscar()} disabled={carregando} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i className={`ti ${carregando ? 'ti-loader-2' : 'ti-search'}`} /> Buscar
          </button>
          <button className="btn btn-ghost" onClick={limpar} disabled={carregando}>Limpar</button>
        </div>
      </div>

      {msg && <p style={{ color: theme.yellow, fontSize: 13, marginBottom: 12 }}><i className="ti ti-info-circle" /> {msg}</p>}

      {/* Resultado */}
      {linhas !== null && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
          <div style={{ padding: '11px 14px', borderBottom: `1px solid ${theme.border}`, fontSize: 12.5, color: theme.sub }}>
            <b style={{ color: theme.text }}>{linhas.length}</b> lançamento(s){temMais ? '+' : ''} encontrado(s)
          </div>
          {linhas.length === 0 ? (
            <p style={{ padding: 16, fontSize: 13, color: theme.sub }}>Nenhum lançamento com esses filtros nesta competência.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Data</th><th style={th}>Conta (onde caiu)</th><th style={th}>Contrapartida</th>
                  <th style={th}>Histórico</th><th style={thNum}>Débito</th><th style={thNum}>Crédito</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtData(l.data)}</td>
                    <td style={td} title={contaLabel(l.conta)}>{contaLabel(l.conta)}</td>
                    <td style={{ ...td, color: theme.sub }} title={contaLabel(l.contrapartida)}>{contaLabel(l.contrapartida)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', maxWidth: 380 }}>{l.historico}</td>
                    <td style={tdNum}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                    <td style={tdNum}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {temMais && (
            <div style={{ padding: 12, textAlign: 'center', borderTop: `1px solid ${theme.border}` }}>
              <button className="btn btn-ghost" onClick={() => buscar(false)} disabled={carregando}>
                <i className={`ti ${carregando ? 'ti-loader-2' : 'ti-chevron-down'}`} /> Carregar mais
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtData(d) {
  const s = String(d || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—')
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260, whiteSpace: 'nowrap' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
