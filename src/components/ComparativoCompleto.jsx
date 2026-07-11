import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { montarBalancete } from '../lib/balancete'
import { gerarExcelDominio } from '../lib/excel'
import { abreComparativoDominio } from '../lib/pdf'
import { theme, moneyDC } from '../lib/theme'

const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const GRUPOS = [
  { k: '1', nome: 'Ativo' }, { k: '2', nome: 'Passivo + PL' }, { k: '3', nome: 'Receitas' },
  { k: '4', nome: 'Custos' }, { k: '5', nome: 'Despesas' },
]
const fmtCnpj = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 14 ? `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}` : (c || '—') }
const num = v => Number(v) || 0

// Dropdown com checkboxes (usado nos filtros de meses e grupos).
function CheckDropdown({ icon, label, resumo, options, marcado, onToggle, onTodos }) {
  const [aberto, setAberto] = useState(false)
  const linha = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6 }
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: theme.sub }}>{icon && <i className={`ti ${icon}`} />} {label}</span>
      <button className="btn-ghost" onClick={() => setAberto(a => !a)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 12px' }}>
        {resumo} <i className="ti ti-chevron-down" style={{ fontSize: 14 }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 8, zIndex: 41, minWidth: 190, maxHeight: 320, overflow: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.28)' }}>
            {onTodos && <>
              <label style={{ ...linha, fontWeight: 600 }} onClick={onTodos}><input type="checkbox" readOnly checked={marcado.size === 0 || marcado.size === options.length} /> Todos</label>
              <div style={{ height: 1, background: theme.border, margin: '6px 0' }} />
            </>}
            {options.map(o => (
              <label key={o.k} style={linha} onClick={() => onToggle(o.k)}>
                <input type="checkbox" readOnly checked={marcado.has(o.k)} /> {o.nome}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Comparativo de Movimento: estrutura completa (sintéticas + analíticas), por mês, com
// coluna Total e rodapé Resultado do Mês / do Exercício. Modos: movimento do mês, acumulado
// ou saldo (puxa o saldo inicial). Filtros de meses, grupos e nível. Excel e PDF padrão Domínio.
export default function ComparativoCompleto({ empresaId, empresaNome, competencia, cnpj }) {
  const [carregando, setCarregando] = useState(false)
  const [dados, setDados] = useState(null) // { meses, contas, mov, sf }
  const [modo, setModo] = useState('movimento')             // 'movimento' | 'acumulado' | 'saldo'
  const [nivel, setNivel] = useState('tudo')
  const [gruposSel, setGruposSel] = useState(() => new Set(GRUPOS.map(g => g.k)))
  const [mesesSel, setMesesSel] = useState(() => new Set()) // vazio = todos
  const ano = Number((competencia || '').split('/')[1]) || new Date().getFullYear()

  useEffect(() => {
    setDados(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const { data: comps } = await supabase.from('competencias').select('id, mes')
          .eq('cliente_id', empresaId).eq('ano', ano).order('mes', { ascending: true })
        if (!vivo) return
        if (!comps || !comps.length) { setDados({ meses: [], contas: [], mov: {}, sf: {} }); return }
        const meta = {}, mov = {}, sf = {}, si = {}, meses = []
        for (const c of comps) {
          const { linhas } = await montarBalancete(empresaId, c.id)
          if (!vivo) return
          if (!linhas.length) continue
          meses.push(c.mes)
          for (const l of linhas) {
            const key = l.classifRaw || l.classif
            if (!meta[key]) meta[key] = { reduzido: l.reduzido, classif: l.classif, classifRaw: key, nome: l.nome, grau: l.grau, sintetica: l.sintetica }
            else { if (!meta[key].nome && l.nome) meta[key].nome = l.nome; if (!meta[key].reduzido && l.reduzido) meta[key].reduzido = l.reduzido; meta[key].sintetica = meta[key].sintetica && l.sintetica }
            ;(mov[key] ||= {})[c.mes] = num(l.debito) - num(l.credito)
            ;(sf[key] ||= {})[c.mes] = num(l.saldo_final)
            ;(si[key] ||= {})[c.mes] = num(l.saldo_inicial)
          }
        }
        meses.sort((a, b) => a - b)
        const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)
        if (vivo) setDados({ meses, contas, mov, sf, si })
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, ano])

  if (carregando || dados === null) return <p style={{ color: theme.sub, fontSize: 13 }}>Montando o comparativo (todos os meses)…</p>
  if (!dados.meses.length) return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-database-off" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>Importe o razão em ao menos uma competência do ano para comparar.</p>
    </div>
  )

  const { meses, contas, mov, sf, si } = dados
  const mesesVis = mesesSel.size ? meses.filter(m => mesesSel.has(m)) : meses
  const niveisSint = [...new Set(contas.filter(c => c.sintetica).map(c => c.grau))].sort((a, b) => a - b)

  // Abertura = saldo inicial do 1º mês em que a conta tem saldo anterior (= saldo de 30/04,
  // o "balancete de abril" que é o saldo anterior de maio). Só as contas patrimoniais têm.
  const abertura = key => { for (const m of meses) { const v = si[key]?.[m]; if (v != null && Math.abs(v) > 0.005) return v } return null }
  const temAbertura = contas.some(c => abertura(c.classifRaw) != null)

  const valorMes = (key, mes) => {
    if (modo === 'saldo') { const v = sf[key]?.[mes]; return v == null ? null : v }
    if (modo === 'movimento') { const v = mov[key]?.[mes]; return v == null ? null : v }
    let has = false, s = 0
    for (const m of meses) { if (m > mes) break; const v = mov[key]?.[m]; if (v != null) { has = true; s += v } }
    return has ? s : null
  }
  const total = key => {
    if (modo === 'saldo') { let last = null; for (const m of meses) { const v = sf[key]?.[m]; if (v != null) last = v } return last }
    return meses.reduce((s, m) => s + (mov[key]?.[m] || 0), 0)
  }

  const resultAnalit = contas.filter(c => !c.sintetica && ['3', '4', '5'].includes(String(c.classifRaw)[0]))
  const resMes = mes => resultAnalit.reduce((s, c) => s + (mov[c.classifRaw]?.[mes] || 0), 0)
  const resExerc = mes => meses.filter(m => m <= mes).reduce((s, m) => s + resMes(m), 0)
  const resMesTotal = meses.reduce((s, m) => s + resMes(m), 0)

  const contasVis = contas.filter(c => gruposSel.has(String(c.classifRaw)[0]) && (nivel === 'tudo' ? true : (c.sintetica && c.grau <= nivel)))
  const toggleGrupo = k => setGruposSel(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n.size ? n : prev })
  const toggleMes = m => setMesesSel(prev => { const n = new Set(prev); n.has(m) ? n.delete(m) : n.add(m); return n })

  const periodo = () => {
    const p = String(meses[0]).padStart(2, '0'), u = meses[meses.length - 1]
    const ult = new Date(ano, u, 0).getDate()
    return { ini: `01/${p}/${ano}`, fim: `${ult}/${String(u).padStart(2, '0')}/${ano}` }
  }

  function exportarExcel() {
    const { ini, fim } = periodo()
    const colunas = [
      { nome: 'Código', largura: 10 }, { nome: 'Classificação', largura: 16 }, { nome: 'Descrição da conta', largura: 40 },
      ...(temAbertura ? [{ nome: 'Abertura', alinhar: 'right', moeda: true }] : []),
      ...mesesVis.map(m => ({ nome: `${MES[m - 1]}/${String(ano).slice(2)}`, alinhar: 'right', moeda: true })),
      { nome: 'Total', alinhar: 'right', moeda: true },
    ]
    const ab = c => temAbertura ? [abertura(c.classifRaw) ?? ''] : []
    const linhas = contasVis.map(c => [c.reduzido || '', c.classif || '', c.nome || '', ...ab(c), ...mesesVis.map(m => { const v = valorMes(c.classifRaw, m); return v == null ? '' : v }), total(c.classifRaw) ?? ''])
    linhas.push(['', '', 'RESULTADO DO MES', ...(temAbertura ? [''] : []), ...mesesVis.map(m => resMes(m)), resMesTotal])
    linhas.push(['', '', 'RESULTADO DO EXERCÍCIO', ...(temAbertura ? [''] : []), ...mesesVis.map(m => resExerc(m)), resMesTotal])
    const sint = new Set(contasVis.map((c, i) => c.sintetica ? i : -1).filter(i => i >= 0))
    sint.add(contasVis.length); sint.add(contasVis.length + 1)
    gerarExcelDominio({
      empresa: empresaNome, cnpj: fmtCnpj(cnpj), periodo: `${ini} - ${fim}`,
      titulo: 'COMPARATIVO DE MOVIMENTO', colunas, linhas, sint,
      arquivo: `comparativo_movimento_${ano}.xlsx`, aba: 'Comparativo',
    })
  }

  function exportarPDF() {
    const { ini, fim } = periodo()
    const ab = c => temAbertura ? [abertura(c.classifRaw)] : []
    const rows = contasVis.map(c => ({ cod: c.reduzido, classif: c.classif, nome: c.nome, sintetica: c.sintetica, vals: [...ab(c), ...mesesVis.map(m => valorMes(c.classifRaw, m)), total(c.classifRaw)] }))
    rows.push({ cod: '', classif: '', nome: 'RESULTADO DO MES', sintetica: true, vals: [...(temAbertura ? [null] : []), ...mesesVis.map(m => resMes(m)), resMesTotal] })
    rows.push({ cod: '', classif: '', nome: 'RESULTADO DO EXERCÍCIO', sintetica: true, vals: [...(temAbertura ? [null] : []), ...mesesVis.map(m => resExerc(m)), resMesTotal] })
    abreComparativoDominio({ empresa: empresaNome, cnpj: fmtCnpj(cnpj), periodoIni: ini, periodoFim: fim, meses: [...(temAbertura ? ['Abertura'] : []), ...mesesVis.map(m => `${MES[m - 1]}/${String(ano).slice(2)}`), 'Total'], rows })
  }

  const celTxt = v => (v == null || v === 0) ? '—' : moneyDC(v)
  const resumoMeses = mesesSel.size === 0 ? 'Todos os meses' : (mesesSel.size <= 3 ? meses.filter(m => mesesSel.has(m)).map(m => MES[m - 1]).join(', ') : `${mesesSel.size} meses`)
  const resumoGrupos = gruposSel.size === GRUPOS.length ? 'Todos os grupos' : (gruposSel.size <= 2 ? GRUPOS.filter(g => gruposSel.has(g.k)).map(g => g.nome).join(', ') : `${gruposSel.size} grupos`)

  return (
    <div>
      {/* Controles */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={ctl}>
          <i className="ti ti-arrows-exchange" /> Modo:
          <select className="input" style={sel} value={modo} onChange={e => setModo(e.target.value)}>
            <option value="movimento">Movimento do mês</option>
            <option value="acumulado">Acumulado</option>
            <option value="saldo">Saldo (com saldo inicial)</option>
          </select>
        </label>
        <CheckDropdown icon="ti-calendar" label="Meses:" resumo={resumoMeses} options={meses.map(m => ({ k: m, nome: `${MES[m - 1]}/${ano}` }))} marcado={mesesSel} onToggle={toggleMes} onTodos={() => setMesesSel(new Set())} />
        <CheckDropdown icon="ti-filter" label="Grupos:" resumo={resumoGrupos} options={GRUPOS} marcado={gruposSel} onToggle={toggleGrupo} onTodos={() => setGruposSel(new Set(GRUPOS.map(g => g.k)))} />
        <label style={ctl}>
          <i className="ti ti-stack-2" /> Nível:
          <select className="input" style={sel} value={String(nivel)} onChange={e => setNivel(e.target.value === 'tudo' ? 'tudo' : Number(e.target.value))}>
            {niveisSint.map(n => <option key={n} value={n}>Até o nível {n}</option>)}
            <option value="tudo">Tudo</option>
          </select>
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportarExcel} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-spreadsheet" /> Excel (Domínio)</button>
          <button className="btn-ghost" onClick={exportarPDF} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-type-pdf" /> PDF (Domínio)</button>
        </div>
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 680 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: theme.input }}>Código</th>
              <th style={th}>Classificação</th>
              <th style={th}>Descrição da conta</th>
              {temAbertura && <th style={thNum} title="Saldo anterior de maio (posição de 30/04)">Abertura</th>}
              {mesesVis.map(m => <th key={m} style={thNum}>{MES[m - 1]}</th>)}
              <th style={{ ...thNum, color: theme.text }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {contasVis.map((c, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: c.sintetica ? theme.input : 'transparent', fontWeight: c.sintetica ? 700 : 400 }}>
                <td style={{ ...td, color: theme.sub, position: 'sticky', left: 0, background: c.sintetica ? theme.input : theme.card }}>{c.reduzido || ''}</td>
                <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{c.classif}</td>
                <td style={{ ...td, paddingLeft: 14 + Math.max(0, (c.grau || 1) - 1) * 12 }}>{c.nome || '—'}</td>
                {temAbertura && <td style={{ ...tdNum, color: theme.sub }}>{celTxt(abertura(c.classifRaw))}</td>}
                {mesesVis.map(m => <td key={m} style={tdNum}>{celTxt(valorMes(c.classifRaw, m))}</td>)}
                <td style={{ ...tdNum, fontWeight: 700 }}>{celTxt(total(c.classifRaw))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input, fontWeight: 700 }}>
              <td style={{ ...td }} colSpan={3}>RESULTADO DO MÊS</td>
              {temAbertura && <td style={tdNum}>—</td>}
              {mesesVis.map(m => <td key={m} style={tdNum}>{celTxt(resMes(m))}</td>)}
              <td style={{ ...tdNum }}>{celTxt(resMesTotal)}</td>
            </tr>
            <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input, fontWeight: 800 }}>
              <td style={{ ...td }} colSpan={3}>RESULTADO DO EXERCÍCIO</td>
              {temAbertura && <td style={tdNum}>—</td>}
              {mesesVis.map(m => <td key={m} style={tdNum}>{celTxt(resExerc(m))}</td>)}
              <td style={{ ...tdNum }}>{celTxt(resMesTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

const ctl = { fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }
const sel = { width: 'auto', fontSize: 12, padding: '6px 10px' }
const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10.5, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '7px 12px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
