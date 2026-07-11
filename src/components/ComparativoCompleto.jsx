import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { montarBalancete } from '../lib/balancete'
import { gerarExcelDominio } from '../lib/excel'
import { abreComparativoDominio } from '../lib/pdf'
import { theme, moneyDC } from '../lib/theme'

const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const fmtCnpj = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 14 ? `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}` : (c || '—') }

// Comparativo de Movimento com a ESTRUTURA COMPLETA (sintéticas + analíticas), o saldo de
// cada conta ao longo dos meses do ano. Exporta Excel e PDF no padrão Domínio.
export default function ComparativoCompleto({ empresaId, empresaNome, competencia, cnpj }) {
  const [carregando, setCarregando] = useState(false)
  const [dados, setDados] = useState(null) // { meses:[n], contas:[...], matriz:{classifRaw:{mes:saldo}} }
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
        if (!comps || !comps.length) { setDados({ meses: [], contas: [], matriz: {} }); return }

        const meta = {}, matriz = {}, meses = []
        for (const c of comps) {
          const { linhas } = await montarBalancete(empresaId, c.id)
          if (!vivo) return
          if (!linhas.length) continue
          meses.push(c.mes)
          for (const l of linhas) {
            const key = l.classifRaw || l.classif
            if (!meta[key]) meta[key] = { reduzido: l.reduzido, classif: l.classif, classifRaw: key, nome: l.nome, grau: l.grau, sintetica: l.sintetica }
            else { if (!meta[key].nome && l.nome) meta[key].nome = l.nome; if (!meta[key].reduzido && l.reduzido) meta[key].reduzido = l.reduzido; meta[key].sintetica = meta[key].sintetica && l.sintetica }
            ;(matriz[key] ||= {})[c.mes] = Number(l.saldo_final) || 0
          }
        }
        meses.sort((a, b) => a - b)
        const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)
        if (vivo) setDados({ meses, contas, matriz })
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, ano])

  const periodo = () => {
    if (!dados?.meses.length) return { ini: `01/01/${ano}`, fim: `31/12/${ano}` }
    const p = String(dados.meses[0]).padStart(2, '0'), u = dados.meses[dados.meses.length - 1]
    const ult = new Date(ano, u, 0).getDate()
    return { ini: `01/${p}/${ano}`, fim: `${ult}/${String(u).padStart(2, '0')}/${ano}` }
  }

  function exportarExcel() {
    if (!dados?.contas.length) return
    const { ini, fim } = periodo()
    const colunas = [
      { nome: 'Código', largura: 10 }, { nome: 'Classificação', largura: 16 }, { nome: 'Descrição da conta', largura: 40 },
      ...dados.meses.map(m => ({ nome: `${MES[m - 1]}/${ano}`, alinhar: 'right', moeda: true })),
    ]
    const linhas = dados.contas.map(c => [c.reduzido || '', c.classif || '', c.nome || '', ...dados.meses.map(m => { const v = dados.matriz[c.classifRaw]?.[m]; return v == null ? '' : v })])
    const sint = new Set(dados.contas.map((c, i) => c.sintetica ? i : -1).filter(i => i >= 0))
    gerarExcelDominio({
      empresa: empresaNome, cnpj: fmtCnpj(cnpj), periodo: `${ini} - ${fim}`,
      titulo: 'COMPARATIVO DE MOVIMENTO', colunas, linhas, sint,
      arquivo: `comparativo_movimento_${ano}.xlsx`, aba: 'Comparativo',
    })
  }

  function exportarPDF() {
    if (!dados?.contas.length) return
    const { ini, fim } = periodo()
    const rows = dados.contas.map(c => ({
      cod: c.reduzido, classif: c.classif, nome: c.nome, sintetica: c.sintetica,
      vals: dados.meses.map(m => { const v = dados.matriz[c.classifRaw]?.[m]; return v == null ? null : v }),
    }))
    abreComparativoDominio({ empresa: empresaNome, cnpj: fmtCnpj(cnpj), periodoIni: ini, periodoFim: fim, meses: dados.meses.map(m => `${MES[m - 1]}/${String(ano).slice(2)}`), rows })
  }

  if (carregando || dados === null) return <p style={{ color: theme.sub, fontSize: 13 }}>Montando o comparativo (todos os meses)…</p>
  if (!dados.meses.length) return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-database-off" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>Importe o razão em ao menos uma competência do ano para comparar.</p>
    </div>
  )

  return (
    <div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <span style={{ color: theme.sub, fontSize: 12.5 }}>{dados.contas.length} contas · {dados.meses.length} mês(es) · estrutura completa (sintéticas + analíticas)</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportarExcel} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-spreadsheet" /> Excel (Domínio)</button>
          <button className="btn-ghost" onClick={exportarPDF} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-type-pdf" /> PDF (Domínio)</button>
        </div>
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={{ ...th, position: 'sticky', left: 0, background: theme.input }}>Código</th>
              <th style={th}>Classificação</th>
              <th style={th}>Descrição da conta</th>
              {dados.meses.map(m => <th key={m} style={thNum}>{MES[m - 1]}</th>)}
            </tr>
          </thead>
          <tbody>
            {dados.contas.map((c, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: c.sintetica ? theme.input : 'transparent', fontWeight: c.sintetica ? 700 : 400 }}>
                <td style={{ ...td, color: theme.sub, position: 'sticky', left: 0, background: c.sintetica ? theme.input : theme.card }}>{c.reduzido || ''}</td>
                <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{c.classif}</td>
                <td style={{ ...td, paddingLeft: 14 + Math.max(0, (c.grau || 1) - 1) * 12 }}>{c.nome || '—'}</td>
                {dados.meses.map(m => { const v = dados.matriz[c.classifRaw]?.[m]; return <td key={m} style={tdNum}>{v == null ? '—' : moneyDC(v)}</td> })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10.5, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '7px 12px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
