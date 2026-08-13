import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, moneyDC } from '../lib/theme'
import { montarBalancete } from '../lib/balancete'
import InfoTela from '../components/InfoTela'

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0

// COMPARATIVO DE MOVIMENTO CONSOLIDADO (fase 2 da consolidação).
// Soma, POR CLASSIFICAÇÃO, as contas de resultado (grupos 3/4/5) da empresa MÃE + as empresas
// que ela consolida (cadastro → consolidacao_grupo). É READ-ONLY: a análise/justificativa da
// oscilação continua individual em cada empresa; aqui é só a visão somada do grupo.
// Contas com a MESMA classificação somam numa linha; o que não casar aparece na sua própria
// linha (nada some) — o de-para conta↔conta vem numa fase seguinte.
export default function CompMovimentoConsolidado() {
  const { empresaId, empresaNome } = useAppData()
  const [carregando, setCarregando] = useState(false)
  const [prog, setProg] = useState('')
  const [dados, setDados] = useState(null) // { meses, contas, mat, empresas, semGrupo }
  const [nivel, setNivel] = useState('tudo')

  useEffect(() => {
    setDados(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true); setProg('')
      try {
        // 1) Grupo = a própria mãe + as empresas marcadas no cadastro dela.
        let grupoIds = [empresaId], semGrupo = true
        try {
          const { data: g } = await supabase.from('consolidacao_grupo').select('empresa_id').eq('matriz_id', empresaId)
          const extras = (g || []).map(r => r.empresa_id).filter(id => id && id !== empresaId)
          if (extras.length) { grupoIds = [empresaId, ...extras]; semGrupo = false }
        } catch { /* tabela ainda não criada — consolida só a própria empresa */ }
        grupoIds = [...new Set(grupoIds)]
        const { data: emps } = await supabase.from('clientes').select('id, razao_social').in('id', grupoIds)
        const nomeEmp = Object.fromEntries((emps || []).map(e => [e.id, e.razao_social]))

        // 2) Soma por CLASSIFICAÇÃO × mês, percorrendo cada empresa e cada competência do ano.
        const meta = {}, mat = {}, mesesSet = new Set()
        for (let i = 0; i < grupoIds.length; i++) {
          const cid = grupoIds[i]
          if (vivo) setProg(`Somando ${i + 1}/${grupoIds.length}: ${nomeEmp[cid] || ''}…`)
          const { data: comps } = await supabase.from('competencias').select('id, mes').eq('cliente_id', cid).eq('ano', ANO).order('mes', { ascending: true })
          for (const c of (comps || [])) {
            const { linhas } = await montarBalancete(cid, c.id, 0, { comLancamentos: true })
            if (!vivo) return
            const res = (linhas || []).filter(l => ['3', '4', '5'].includes(String(l.classifRaw || l.classif || '')[0]))
            if (!res.length) continue
            mesesSet.add(c.mes)
            for (const l of res) {
              const key = String(l.classifRaw || l.classif)     // consolida POR CLASSIFICAÇÃO
              if (!meta[key]) meta[key] = { key, classif: l.classif, classifRaw: key, nome: l.nome, grau: l.grau || String(key).replace(/\D/g, '').length, sintetica: !!l.sintetica }
              else { if (!meta[key].nome && l.nome) meta[key].nome = l.nome; meta[key].sintetica = meta[key].sintetica && l.sintetica }
              ;(mat[key] ||= {})[c.mes] = (mat[key][c.mes] || 0) + num(l.saldo_final)
            }
          }
          if (!vivo) return
        }
        const meses = [...mesesSet].sort((a, b) => a - b)
        // Ordem da ÁRVORE do plano: classifRaw como string (igual ao balancete/comparativo).
        const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)
        if (vivo) setDados({ meses, contas, mat, empresas: grupoIds.map(id => nomeEmp[id] || id), semGrupo })
      } finally { if (vivo) { setCarregando(false); setProg('') } }
    })()
    return () => { vivo = false }
  }, [empresaId])

  if (!empresaId) return (
    <Wrap>
      <div style={cardVazio}><i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
        <p style={{ fontSize: 14, color: theme.text }}>Selecione uma empresa (mãe) no menu lateral.</p></div>
    </Wrap>
  )
  if (carregando || dados === null) return <Wrap><p style={{ color: theme.sub, fontSize: 13 }}>{prog || 'Consolidando o comparativo do grupo…'}</p></Wrap>

  const { meses, contas, mat, empresas, semGrupo } = dados
  const niveisSint = [...new Set(contas.filter(c => c.sintetica).map(c => c.grau))].sort((a, b) => a - b)
  const contasVis = contas.filter(c => nivel === 'tudo' ? true : (c.sintetica && c.grau <= nivel))
  const val = (key, m) => { const v = mat[key]?.[m]; return v == null ? null : v }
  const totalConta = key => meses.reduce((s, m) => s + (val(key, m) || 0), 0)
  const temMov = key => meses.some(m => { const v = val(key, m); return v != null && Number(v) !== 0 })
  // Resultado do período = −Σ(saldo das analíticas de resultado). Lucro (crédito) positivo.
  const analit = contas.filter(c => !c.sintetica)
  const resMes = m => -analit.reduce((s, c) => s + (val(c.key, m) || 0), 0)
  const resExerc = m => meses.filter(x => x <= m).reduce((s, x) => s + resMes(x), 0)
  const resTotal = meses.reduce((s, m) => s + resMes(m), 0)
  const celTxt = v => (v == null || Math.abs(v) < 0.005) ? '—' : moneyDC(v)
  const corRes = v => (v == null || Math.abs(v) < 0.005) ? theme.sub : (v < 0 ? '#0a7d33' : '#c0341d')

  return (
    <Wrap>
      <InfoTela titulo="Comparativo de Movimento — Consolidado">
        Soma as contas de <b>resultado</b> (receitas, custos e despesas) da empresa <b>mãe</b> e das empresas que ela
        consolida, mês a mês, <b>por classificação</b>. É só leitura — a <b>oscilação/justificativa</b> continua
        individual em cada empresa. Configure o grupo no <b>cadastro da empresa mãe</b>.
      </InfoTela>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '4px 0 14px' }}>
        <span style={{ fontSize: 13, color: theme.text }}>
          <b>{empresaNome}</b> · consolidando <b>{empresas.length}</b> empresa(s)
        </span>
        {niveisSint.length > 0 && (
          <select className="input" value={nivel} onChange={e => setNivel(e.target.value === 'tudo' ? 'tudo' : Number(e.target.value))} style={{ fontSize: 12.5, padding: '5px 10px', width: 'auto' }}>
            <option value="tudo">Todas as contas</option>
            {niveisSint.map(n => <option key={n} value={n}>Sintéticas até nível {n}</option>)}
          </select>
        )}
      </div>

      {semGrupo && (
        <div style={{ ...cardVazio, borderColor: theme.yellow, marginBottom: 14 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 20, color: theme.yellow }} />
          <p style={{ fontSize: 13, color: theme.text }}>Esta empresa ainda <b>não consolida ninguém</b> — está mostrando só ela mesma. Marque as empresas do grupo no <b>cadastro da empresa mãe</b> (campo “Consolida os balancetes destas empresas”).</p>
        </div>
      )}

      <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 10px' }}><i className="ti ti-building-community" style={{ color: theme.accent }} /> Empresas do consolidado: {empresas.join(' · ')}</p>

      {!meses.length ? (
        <div style={cardVazio}><i className="ti ti-database-off" style={{ fontSize: 22, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Nenhuma das empresas do grupo tem razão importado em {ANO}.</p></div>
      ) : (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr style={{ background: theme.input }}>
                <th style={{ ...th, textAlign: 'left' }}>Classificação</th>
                <th style={{ ...th, textAlign: 'left' }}>Descrição da conta</th>
                {meses.map(m => <th key={m} style={thR}>{MESES[m - 1]}</th>)}
                <th style={thR}>Total</th>
              </tr>
            </thead>
            <tbody>
              {contasVis.filter(c => c.sintetica || temMov(c.key)).map((c, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: c.sintetica ? theme.input : 'transparent' }}>
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{c.classif}</td>
                  <td style={{ ...td, paddingLeft: 8 + Math.max(0, (c.grau || 1) - 1) * 12, fontWeight: c.sintetica ? 700 : 400 }}>{c.nome}</td>
                  {meses.map(m => <td key={m} style={tdR}>{celTxt(val(c.key, m))}</td>)}
                  <td style={{ ...tdR, fontWeight: 600 }}>{celTxt(totalConta(c.key))}</td>
                </tr>
              ))}
              <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                <td style={td}></td><td style={{ ...td, fontWeight: 700 }}>RESULTADO DO MÊS</td>
                {meses.map(m => <td key={m} style={{ ...tdR, fontWeight: 700, color: corRes(-resMes(m)) }}>{celTxt(resMes(m))}</td>)}
                <td style={{ ...tdR, fontWeight: 700, color: corRes(-resTotal) }}>{celTxt(resTotal)}</td>
              </tr>
              <tr style={{ background: theme.input }}>
                <td style={td}></td><td style={{ ...td, fontWeight: 700 }}>RESULTADO DO EXERCÍCIO (acumulado)</td>
                {meses.map(m => <td key={m} style={{ ...tdR, fontWeight: 700, color: corRes(-resExerc(m)) }}>{celTxt(resExerc(m))}</td>)}
                <td style={{ ...tdR, fontWeight: 700, color: corRes(-resTotal) }}>{celTxt(resTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Wrap>
  )
}

function Wrap({ children }) {
  return <div style={{ padding: '28px 32px', maxWidth: 1400, margin: '0 auto' }}>
    <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 4px' }}>Comparativo de Movimento — Consolidado</h1>
    <div style={{ marginTop: 14 }}>{children}</div>
  </div>
}
const cardVazio = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 620 }
const th = { padding: '10px 12px', fontSize: 11, fontWeight: 700, color: theme.sub, textTransform: 'uppercase', letterSpacing: .4, whiteSpace: 'nowrap' }
const thR = { ...th, textAlign: 'right' }
const td = { padding: '7px 12px', fontSize: 12.5, color: theme.text }
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
