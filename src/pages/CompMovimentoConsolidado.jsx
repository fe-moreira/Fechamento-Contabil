import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, moneyDC } from '../lib/theme'
import { montarBalancete } from '../lib/balancete'
import InfoTela from '../components/InfoTela'

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const AGRUP = [{ k: 'mes', n: 'Mês' }, { k: 'trimestre', n: 'Trimestre' }, { k: 'semestre', n: 'Semestre' }, { k: 'ano', n: 'Ano' }]
const num = v => Number(v) || 0

// COMPARATIVO DE MOVIMENTO CONSOLIDADO. Mesmo layout/filtros do Comparativo de Movimento
// (nível, meses, agrupamento), MAIS um filtro de EMPRESAS: a lista da mãe + o grupo, onde você
// liga/desliga cada empresa (ver todas, algumas ou uma só). Soma POR CLASSIFICAÇÃO as contas de
// resultado (grupos 3/4/5). É read-only — a justificativa da oscilação continua individual.
// Os dados são guardados POR EMPRESA, então alternar no filtro é instantâneo (não recarrega).
export default function CompMovimentoConsolidado() {
  const { empresaId, empresaNome } = useAppData()
  const [carregando, setCarregando] = useState(false)
  const [prog, setProg] = useState('')
  const [base, setBase] = useState(null)          // { matByEmp, meta, meses, empresas, semGrupo }
  const [empresasSel, setEmpresasSel] = useState(null) // Set de empId ligados; null = todas
  const [nivel, setNivel] = useState('tudo')
  const [agrupar, setAgrupar] = useState('mes')
  const [mesesSel, setMesesSel] = useState(() => new Set()) // vazio = todos
  const [erro, setErro] = useState(null)

  useEffect(() => {
    setBase(null); setEmpresasSel(null); setErro(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true); setProg('')
      try {
        // Grupo = a própria mãe + as empresas marcadas no cadastro dela (cargas_cadastro).
        // Lê o formato 'consolidacao' e, se não houver, o fallback 'depara' + obs marcador.
        let grupoIds = [empresaId], semGrupo = true
        let cfg = (await supabase.from('cargas_cadastro').select('dados')
          .eq('cliente_id', empresaId).eq('tipo', 'consolidacao').order('created_at', { ascending: false }).limit(1).maybeSingle()).data
        if (!cfg) cfg = (await supabase.from('cargas_cadastro').select('dados')
          .eq('cliente_id', empresaId).eq('tipo', 'depara').eq('obs', 'consolidacao_grupo').order('created_at', { ascending: false }).limit(1).maybeSingle()).data
        const extras = (Array.isArray(cfg?.dados?.empresas) ? cfg.dados.empresas : []).filter(id => id && id !== empresaId)
        if (extras.length) { grupoIds = [empresaId, ...extras]; semGrupo = false }
        grupoIds = [...new Set(grupoIds)]
        const { data: emps } = await supabase.from('clientes').select('id, razao_social').in('id', grupoIds)
        const nomeEmp = Object.fromEntries((emps || []).map(e => [e.id, e.razao_social]))

        // Guarda POR EMPRESA (para o filtro alternar sem recarregar) e o meta (união das contas).
        const matByEmp = {}, meta = {}, mesesSet = new Set()
        for (let i = 0; i < grupoIds.length; i++) {
          const cid = grupoIds[i]
          if (vivo) setProg(`Carregando ${i + 1}/${grupoIds.length}: ${nomeEmp[cid] || ''}…`)
          matByEmp[cid] = {}
          const { data: comps } = await supabase.from('competencias').select('id, mes').eq('cliente_id', cid).eq('ano', ANO).order('mes', { ascending: true })
          for (const c of (comps || [])) {
            const { linhas } = await montarBalancete(cid, c.id, 0, { comLancamentos: true })
            if (!vivo) return
            const res = (linhas || []).filter(l => ['3', '4', '5'].includes(String(l.classifRaw || l.classif || '')[0]))
            if (!res.length) continue
            mesesSet.add(c.mes)
            for (const l of res) {
              // Consolida POR CLASSIFICAÇÃO. A chave é só os DÍGITOS da classificação, para que
              // "3.1.1", "311" e "03.1.1" (máscaras/pontuação diferentes entre empresas) caiam na
              // MESMA linha em vez de empilharem duplicadas. `classif` (mascarada) fica pra exibir.
              const disp = String(l.classif || l.classifRaw || '')
              const key = disp.replace(/\D/g, '') || disp
              if (!meta[key]) meta[key] = { key, reduzido: l.reduzido, classif: disp, classifRaw: disp, nome: l.nome, grau: l.grau || disp.split('.').length, sintetica: !!l.sintetica }
              else { if (!meta[key].nome && l.nome) meta[key].nome = l.nome; if (!meta[key].reduzido && l.reduzido) meta[key].reduzido = l.reduzido; meta[key].sintetica = meta[key].sintetica && l.sintetica }
              ;(matByEmp[cid][key] ||= {})[c.mes] = (matByEmp[cid][key][c.mes] || 0) + num(l.saldo_final)
            }
          }
          if (!vivo) return
        }
        const meses = [...mesesSet].sort((a, b) => a - b)
        const empresas = grupoIds.map(id => ({ id, nome: nomeEmp[id] || id }))
        if (vivo) setBase({ matByEmp, meta, meses, empresas, semGrupo })
      } catch (e) { if (vivo) setErro(e?.message || String(e)) }
      finally { if (vivo) { setCarregando(false); setProg('') } }
    })()
    return () => { vivo = false }
  }, [empresaId])

  if (!empresaId) return <Wrap><Vazio icon="ti-building" txt="Selecione uma empresa (mãe) no menu lateral." /></Wrap>
  if (erro) return <Wrap><div style={{ ...cardVazio, borderColor: theme.red }}><i className="ti ti-alert-triangle" style={{ fontSize: 22, color: theme.red }} /><p style={{ fontSize: 13.5, color: theme.text }}>Não consegui montar o consolidado: <b>{erro}</b></p></div></Wrap>
  if (carregando || base === null) return <Wrap><p style={{ color: theme.sub, fontSize: 13 }}>{prog || 'Consolidando o comparativo do grupo…'}</p></Wrap>

  const { matByEmp, meta, meses, empresas, semGrupo } = base
  const ativas = empresasSel || new Set(empresas.map(e => e.id))   // null = todas ligadas
  const toggleEmp = id => setEmpresasSel(prev => {
    const cur = prev || new Set(empresas.map(e => e.id))
    const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id)
    return n.size ? n : cur   // nunca deixa zerar (some tudo) — mantém a anterior
  })
  const soUma = id => setEmpresasSel(new Set([id]))
  const todas = () => setEmpresasSel(null)

  // Valor de uma conta num mês = soma das empresas LIGADAS.
  const val = (key, m) => {
    let s = 0, has = false
    for (const e of empresas) if (ativas.has(e.id)) { const v = matByEmp[e.id]?.[key]?.[m]; if (v != null) { s += v; has = true } }
    return has ? s : null
  }

  const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)
  const niveisSint = [...new Set(contas.filter(c => c.sintetica).map(c => c.grau))].sort((a, b) => a - b)
  const contasVis = contas.filter(c => nivel === 'tudo' ? true : (c.sintetica && c.grau <= nivel))
  const analit = contas.filter(c => !c.sintetica)

  // Colunas conforme o agrupamento + filtro de meses (igual ao Comparativo de Movimento).
  const colunas = (() => {
    const b = mesesSel.size ? meses.filter(m => mesesSel.has(m)) : meses
    if (agrupar === 'mes') return b.map(m => ({ key: 'm' + m, label: `${MESES[m - 1]}/${String(ANO).slice(2)}`, meses: [m] }))
    const per = agrupar === 'trimestre' ? 3 : agrupar === 'semestre' ? 6 : 12
    const bk = new Map()
    for (const m of b) { const idx = per === 12 ? 1 : Math.floor((m - 1) / per) + 1; if (!bk.has(idx)) bk.set(idx, { idx, meses: [] }); bk.get(idx).meses.push(m) }
    return [...bk.values()].sort((x, y) => x.idx - y.idx).map(g => ({ key: 'g' + g.idx, label: agrupar === 'ano' ? String(ANO) : `${agrupar === 'trimestre' ? 'T' : 'S'}${g.idx}`, meses: g.meses }))
  })()
  const mostraTotal = colunas.length > 1
  const valCol = (key, col) => { let s = 0, has = false; for (const m of col.meses) { const v = val(key, m); if (v != null) { s += v; has = true } } return has ? s : null }
  const totalConta = key => colunas.reduce((s, col) => s + (valCol(key, col) || 0), 0)
  const temMov = key => colunas.some(col => { const v = valCol(key, col); return v != null && Number(v) !== 0 })
  const resCol = col => -analit.reduce((s, c) => s + (valCol(c.key, col) || 0), 0)
  const resExercCol = col => { const ate = col.meses[col.meses.length - 1]; let s = 0; for (const m of meses) { if (m > ate) break; s += -analit.reduce((a, c) => a + (val(c.key, m) || 0), 0) } return s }
  const resTotal = colunas.reduce((s, col) => s + resCol(col), 0)

  const celTxt = v => (v == null || Math.abs(v) < 0.005) ? '—' : moneyDC(v)
  const corRes = v => (v == null || Math.abs(v) < 0.005) ? theme.sub : (v < 0 ? '#0a7d33' : '#c0341d')
  const toggleMes = m => setMesesSel(prev => { const n = new Set(prev); n.has(m) ? n.delete(m) : n.add(m); return n })

  return (
    <Wrap>
      <InfoTela titulo="Comparativo de Movimento — Consolidado">
        Mesmo layout do <b>Comparativo de Movimento</b>, somando <b>por classificação</b> as contas de resultado da
        empresa <b>mãe</b> + as empresas do grupo. Use o filtro <b>Empresas</b> para <b>consolidar/desconsolidar</b> —
        ver todas, algumas ou uma só. É só leitura; a justificativa da oscilação continua individual em cada empresa.
      </InfoTela>

      {semGrupo && <div style={{ ...cardVazio, borderColor: theme.yellow, margin: '4px 0 14px' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 20, color: theme.yellow }} />
        <p style={{ fontSize: 13, color: theme.text }}>Esta empresa ainda <b>não consolida ninguém</b> (mostrando só ela). Marque o grupo no <b>cadastro da empresa mãe</b>.</p>
      </div>}

      {/* Filtro de EMPRESAS: liga/desliga cada uma; "Só esta" isola; "Todas" volta. */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: theme.sub, textTransform: 'uppercase', letterSpacing: .4 }}><i className="ti ti-building-community" style={{ color: theme.accent }} /> Empresas ({ativas.size}/{empresas.length})</span>
          <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={todas}>Todas</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {empresas.map(e => {
            const on = ativas.has(e.id)
            return (
              <span key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${on ? theme.accent : theme.cb}`, background: on ? 'rgba(74,124,255,0.12)' : theme.input, borderRadius: 20, padding: '4px 6px 4px 10px', fontSize: 12.5 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleEmp(e.id)} style={{ cursor: 'pointer' }} />
                  {e.nome}{e.id === empresaId ? <b style={{ color: theme.accent }}> (mãe)</b> : ''}
                </label>
                <button title="Ver só esta" onClick={() => soUma(e.id)} style={{ background: 'none', border: 'none', color: theme.sub, cursor: 'pointer', fontSize: 13, padding: 0 }}><i className="ti ti-focus-2" /></button>
              </span>
            )
          })}
        </div>
      </div>

      {/* Filtros de layout — iguais ao Comparativo de Movimento */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: theme.text }}><b>{empresaNome}</b></span>
        <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>Agrupar:
          <select className="input" value={agrupar} onChange={e => setAgrupar(e.target.value)} style={{ fontSize: 12.5, padding: '5px 10px', width: 'auto' }}>
            {AGRUP.map(a => <option key={a.k} value={a.k}>{a.n}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>Nível:
          <select className="input" value={nivel} onChange={e => setNivel(e.target.value === 'tudo' ? 'tudo' : Number(e.target.value))} style={{ fontSize: 12.5, padding: '5px 10px', width: 'auto' }}>
            <option value="tudo">Todas as contas</option>
            {niveisSint.map(n => <option key={n} value={n}>Sintéticas até nível {n}</option>)}
          </select>
        </label>
        {agrupar === 'mes' && meses.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: theme.sub }}>Meses:</span>
            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: mesesSel.size ? theme.sub : theme.accent }} onClick={() => setMesesSel(new Set())}>Todos</button>
            {meses.map(m => {
              const on = mesesSel.size === 0 || mesesSel.has(m)
              return <button key={m} onClick={() => toggleMes(m)} style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 16, border: `1px solid ${on ? theme.accent : theme.cb}`, background: on ? 'rgba(74,124,255,0.12)' : theme.input, color: theme.text, cursor: 'pointer' }}>{MESES[m - 1]}</button>
            })}
          </div>
        )}
      </div>

      <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 10px' }}>Consolidando: {empresas.filter(e => ativas.has(e.id)).map(e => e.nome).join(' · ') || '—'}</p>

      {!meses.length ? (
        <Vazio icon="ti-database-off" txt={`Nenhuma das empresas do grupo tem razão importado em ${ANO}.`} />
      ) : (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ background: theme.input }}>
                <th style={{ ...th, minWidth: 70 }}>Conta</th>
                <th style={{ ...th, minWidth: 110 }}>Classificação</th>
                <th style={{ ...th, minWidth: 220 }}>Nome da Conta</th>
                {colunas.map(col => <th key={col.key} style={{ ...th, textAlign: 'right' }}>{col.label}</th>)}
                {mostraTotal && <th style={{ ...th, textAlign: 'right', color: theme.text }}>Total</th>}
              </tr>
            </thead>
            <tbody>
              {contasVis.filter(c => c.sintetica || temMov(c.key)).map(c => {
                const grau = c.grau || 1
                const bgNivel = !c.sintetica ? 'transparent' : grau <= 1 ? theme.input : grau === 2 ? 'rgba(74,124,255,0.07)' : 'rgba(74,124,255,0.035)'
                const peso = c.sintetica ? (grau <= 1 ? 800 : grau === 2 ? 700 : 600) : 400
                const recuo = 14 + Math.max(0, grau - 1) * 16
                const tot = totalConta(c.key)
                return (
                  <tr key={c.key} style={{ borderTop: `1px solid ${theme.border}`, background: bgNivel, fontWeight: peso }}>
                    <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{c.reduzido || ''}</td>
                    <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{c.classif}</td>
                    <td style={{ ...td, fontWeight: peso, maxWidth: 320, paddingLeft: recuo }}>
                      {c.sintetica && <span style={{ fontSize: 9.5, fontWeight: 700, color: theme.accent, background: 'rgba(74,124,255,0.14)', borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>N{grau}</span>}
                      {c.nome || '—'}
                    </td>
                    {colunas.map(col => { const v = valCol(c.key, col); const vazio = v == null || Number(v) === 0; return <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: c.sintetica ? 700 : undefined, color: vazio ? theme.sub : undefined }}>{vazio ? '—' : moneyDC(v)}</td> })}
                    {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: (tot == null || tot === 0) ? theme.sub : undefined }}>{(tot == null || tot === 0) ? '—' : moneyDC(tot)}</td>}
                  </tr>
                )
              })}
              <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                <td style={td}></td><td style={td}></td><td style={{ ...td, fontWeight: 700 }}>RESULTADO DO MÊS</td>
                {colunas.map(col => <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: 700, color: corRes(-resCol(col)) }}>{celTxt(resCol(col))}</td>)}
                {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: corRes(-resTotal) }}>{celTxt(resTotal)}</td>}
              </tr>
              <tr style={{ background: theme.input }}>
                <td style={td}></td><td style={td}></td><td style={{ ...td, fontWeight: 700 }}>RESULTADO DO EXERCÍCIO (acumulado)</td>
                {colunas.map(col => <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: 700, color: corRes(-resExercCol(col)) }}>{celTxt(resExercCol(col))}</td>)}
                {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: corRes(-resTotal) }}>{celTxt(resTotal)}</td>}
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
function Vazio({ icon, txt }) {
  return <div style={cardVazio}><i className={`ti ${icon}`} style={{ fontSize: 22, color: theme.accent }} /><p style={{ fontSize: 14, color: theme.text }}>{txt}</p></div>
}
const cardVazio = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 640 }
// Mesmos estilos do Comp. Movimento (para a tabela ficar idêntica).
const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
