import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { lerTudo } from '../lib/lerTudo'
import { useAppData } from '../lib/appData'
import { theme, money, moneyDC } from '../lib/theme'
import { montarBalancete } from '../lib/balancete'
import InfoTela from '../components/InfoTela'

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const AGRUP = [{ k: 'mes', n: 'Mês' }, { k: 'trimestre', n: 'Trimestre' }, { k: 'semestre', n: 'Semestre' }, { k: 'ano', n: 'Ano' }]
const num = v => Number(v) || 0
const SEP = '|~|'   // separador da chave conta+classificacao+nome

// Normaliza o NOME da conta para casar "mesma conta" sem tropeçar em maiúsculas/acentos/espaços.
const normNome = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
// Só os dígitos da classificação (imune a máscara/pontuação diferente entre empresas).
const soDig = s => String(s || '').replace(/\D/g, '')
const fmtData = d => { const s = String(d || ''); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[3]}/${m[2]}/${m[1]}` : s }

// COMPARATIVO DE MOVIMENTO CONSOLIDADO. Mesmo layout/filtros/comportamento do Comparativo de
// Movimento (nível, meses, agrupamento, clique na célula → razão), MAIS um filtro de EMPRESAS
// (ligar/desligar cada uma). REGRA DE UNIFICAÇÃO (mãe pediu): só une contas quando os TRÊS batem —
// CONTA (código reduzido) + CLASSIFICAÇÃO + NOME. Se qualquer um difere, a conta entra separada
// (pra montar o de-para depois). Vale igual pra sintética e analítica. É read-only; a justificativa
// da oscilação continua individual em cada empresa. No razão, cada lançamento mostra de qual empresa é.
export default function CompMovimentoConsolidado() {
  const { empresaId, empresaNome } = useAppData()
  const [carregando, setCarregando] = useState(false)
  const [prog, setProg] = useState('')
  const [base, setBase] = useState(null)          // { matByEmp, meta, meses, empresas, compByEmp, semGrupo }
  const [empresasSel, setEmpresasSel] = useState(null) // Set de empId ligados; null = todas
  const [nivel, setNivel] = useState('tudo')
  const [agrupar, setAgrupar] = useState('mes')
  const [mesesSel, setMesesSel] = useState(() => new Set()) // vazio = todos
  const [erro, setErro] = useState(null)
  const [detalhe, setDetalhe] = useState(null)    // { reduzido, classif, nome, mesLabel, contribs:[{compId,nomeEmp}] }

  useEffect(() => {
    setBase(null); setEmpresasSel(null); setErro(null); setDetalhe(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true); setProg('')
      try {
        // Grupo = a própria mãe + as empresas marcadas no cadastro dela (cargas_cadastro).
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

        // Guarda POR EMPRESA (o filtro alterna sem recarregar) + meta (união das contas) +
        // compByEmp (competência de cada mês, pra abrir o razão da empresa certa no clique).
        const matByEmp = {}, meta = {}, mesesSet = new Set(), compByEmp = {}
        for (let i = 0; i < grupoIds.length; i++) {
          const cid = grupoIds[i]
          if (vivo) setProg(`Carregando ${i + 1}/${grupoIds.length}: ${nomeEmp[cid] || ''}…`)
          matByEmp[cid] = {}; compByEmp[cid] = {}
          const { data: comps } = await supabase.from('competencias').select('id, mes').eq('cliente_id', cid).eq('ano', ANO).order('mes', { ascending: true })
          for (const c of (comps || [])) {
            compByEmp[cid][c.mes] = c.id
            const { linhas } = await montarBalancete(cid, c.id, 0, { comLancamentos: true })
            if (!vivo) return
            const res = (linhas || []).filter(l => ['3', '4', '5'].includes(String(l.classifRaw || l.classif || '')[0]))
            if (!res.length) continue
            mesesSet.add(c.mes)
            for (const l of res) {
              // UNIFICA só quando os TRÊS batem: conta (reduzido) + classificação (dígitos) + nome.
              const reduzido = String(l.reduzido || '').trim()
              const disp = String(l.classif || l.classifRaw || '')
              const key = reduzido + SEP + soDig(disp) + SEP + normNome(l.nome)
              if (!meta[key]) meta[key] = { key, reduzido, classif: disp, classifRaw: disp, nome: l.nome, grau: l.grau || disp.split('.').length, sintetica: !!l.sintetica, empresas: new Set() }
              meta[key].empresas.add(cid)
              ;(matByEmp[cid][key] ||= {})[c.mes] = (matByEmp[cid][key][c.mes] || 0) + num(l.saldo_final)
            }
          }
          if (!vivo) return
        }
        const meses = [...mesesSet].sort((a, b) => a - b)
        const empresas = grupoIds.map(id => ({ id, nome: nomeEmp[id] || id }))
        if (vivo) setBase({ matByEmp, meta, meses, empresas, compByEmp, semGrupo })
      } catch (e) { if (vivo) setErro(e?.message || String(e)) }
      finally { if (vivo) { setCarregando(false); setProg('') } }
    })()
    return () => { vivo = false }
  }, [empresaId])

  if (!empresaId) return <Wrap><Vazio icon="ti-building" txt="Selecione uma empresa (mãe) no menu lateral." /></Wrap>
  if (erro) return <Wrap><div style={{ ...cardVazio, borderColor: theme.red }}><i className="ti ti-alert-triangle" style={{ fontSize: 22, color: theme.red }} /><p style={{ fontSize: 13.5, color: theme.text }}>Não consegui montar o consolidado: <b>{erro}</b></p></div></Wrap>
  if (carregando || base === null) return <Wrap><p style={{ color: theme.sub, fontSize: 13 }}>{prog || 'Consolidando o comparativo do grupo…'}</p></Wrap>

  const { matByEmp, meta, meses, empresas, compByEmp, semGrupo } = base
  const ativas = empresasSel || new Set(empresas.map(e => e.id))   // null = todas ligadas
  const nomeById = Object.fromEntries(empresas.map(e => [e.id, e.nome]))
  const toggleEmp = id => setEmpresasSel(prev => {
    const cur = prev || new Set(empresas.map(e => e.id))
    const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id)
    return n.size ? n : cur   // nunca deixa zerar (some tudo) — mantém a anterior
  })
  const soUma = id => setEmpresasSel(new Set([id]))
  const todas = () => setEmpresasSel(null)

  // Valor de uma conta num mês = soma das empresas LIGADAS que têm essa conta.
  const val = (key, m) => {
    let s = 0, has = false
    for (const e of empresas) if (ativas.has(e.id)) { const v = matByEmp[e.id]?.[key]?.[m]; if (v != null) { s += v; has = true } }
    return has ? s : null
  }

  const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : (a.reduzido < b.reduzido ? -1 : a.reduzido > b.reduzido ? 1 : (normNome(a.nome) < normNome(b.nome) ? -1 : 1)))
  const niveisSint = [...new Set(contas.filter(c => c.sintetica).map(c => c.grau))].sort((a, b) => a - b)
  const analit = contas.filter(c => !c.sintetica)

  // Colunas conforme o agrupamento + filtro de meses (igual ao Comparativo de Movimento).
  const colunas = (() => {
    const b = mesesSel.size ? meses.filter(m => mesesSel.has(m)) : meses
    if (agrupar === 'mes') return b.map(m => ({ key: 'm' + m, label: `${MESES[m - 1]}/${String(ANO).slice(2)}`, meses: [m], mes: m }))
    const per = agrupar === 'trimestre' ? 3 : agrupar === 'semestre' ? 6 : 12
    const bk = new Map()
    for (const m of b) { const idx = per === 12 ? 1 : Math.floor((m - 1) / per) + 1; if (!bk.has(idx)) bk.set(idx, { idx, meses: [] }); bk.get(idx).meses.push(m) }
    return [...bk.values()].sort((x, y) => x.idx - y.idx).map(g => ({ key: 'g' + g.idx, label: agrupar === 'ano' ? String(ANO) : `${agrupar === 'trimestre' ? 'T' : 'S'}${g.idx}`, meses: g.meses, mes: g.meses.length === 1 ? g.meses[0] : null }))
  })()
  const mostraTotal = colunas.length > 1
  const valCol = (key, col) => { let s = 0, has = false; for (const m of col.meses) { const v = val(key, m); if (v != null) { s += v; has = true } } return has ? s : null }
  const totalConta = key => colunas.reduce((s, col) => s + (valCol(key, col) || 0), 0)
  const temMov = key => colunas.some(col => { const v = valCol(key, col); return v != null && Number(v) !== 0 })
  const lucroCol = col => -analit.reduce((s, c) => s + (valCol(c.key, col) || 0), 0)
  const lucroTotal = colunas.reduce((s, col) => s + lucroCol(col), 0)

  // Empresas LIGADAS que têm a conta (para abrir o razão só delas), com a competência do mês.
  const contribuintes = (c, mes) => [...(meta[c.key].empresas || [])].filter(cid => ativas.has(cid))
    .flatMap(cid => (mes == null ? Object.entries(compByEmp[cid] || {}).map(([mm, compId]) => ({ compId, nomeEmp: nomeById[cid], mes: Number(mm) }))
      : (compByEmp[cid]?.[mes] ? [{ compId: compByEmp[cid][mes], nomeEmp: nomeById[cid], mes }] : [])))
  const abrir = (c, mes, mesLabel) => setDetalhe({ reduzido: c.reduzido, classif: c.classif, nome: c.nome, mesLabel, contribs: contribuintes(c, mes) })

  return (
    <Wrap>
      {semGrupo && <div style={{ ...cardVazio, borderColor: theme.yellow, margin: '4px 0 14px' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 20, color: theme.yellow }} />
        <p style={{ fontSize: 13, color: theme.text }}>Esta empresa ainda <b>não consolida ninguém</b> (mostrando só ela). Marque o grupo no <b>cadastro da empresa mãe</b>.</p>
      </div>}

      {/* Filtros — mesmo padrão do Comp. Movimento (ícone + botão/dropdown). Empresas vira LISTA. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-building-community" /> Empresas:
          <EmpresaDropdown empresas={empresas} ativas={ativas} maeId={empresaId} onToggle={toggleEmp} onTodas={todas} onSo={soUma} />
        </div>
        <span style={{ flex: 1, minWidth: 20 }} />
        <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-calendar-stats" /> Agrupar:
          <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }} value={agrupar} onChange={e => setAgrupar(e.target.value)}>
            {AGRUP.map(a => <option key={a.k} value={a.k}>{a.n}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-stack-2" /> Nível:
          <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }}
            value={String(nivel)} onChange={e => setNivel(e.target.value === 'tudo' ? 'tudo' : Number(e.target.value))}>
            {niveisSint.map(n => <option key={n} value={n}>Até o nível {n}</option>)}
            <option value="tudo">Tudo (todas as contas)</option>
          </select>
        </label>
        <div style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-filter" /> Meses:
          <MultiMesSelect meses={meses} sel={mesesSel} onChange={setMesesSel} />
        </div>
      </div>

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
              {contas.filter(c => (nivel === 'tudo' ? true : (c.sintetica && c.grau <= nivel)) && temMov(c.key)).map(c => {
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
                    {colunas.map(col => {
                      const v = valCol(c.key, col)
                      const vazio = v == null || Number(v) === 0
                      // Sintética: total do grupo — sem clique. Coluna agrupada: sem clique.
                      if (c.sintetica || col.mes == null) {
                        return <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: c.sintetica ? 700 : undefined, color: vazio ? theme.sub : undefined }}>{vazio ? '—' : moneyDC(v)}</td>
                      }
                      if (vazio) return <td key={col.key} style={{ ...td, textAlign: 'right', color: theme.sub }}>—</td>
                      // Analítica num mês → clique abre o razão consolidado (com a coluna Empresa).
                      return (
                        <td key={col.key} style={{ ...td, textAlign: 'right' }}>
                          <button onClick={() => abrir(c, col.mes, col.label)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', color: theme.text, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
                            title="Ver o razão da conta neste mês (todas as empresas ligadas)">{moneyDC(v)}</button>
                        </td>
                      )
                    })}
                    {mostraTotal && (
                      (c.sintetica || tot === 0)
                        ? <td style={{ ...td, textAlign: 'right', fontWeight: c.sintetica ? 700 : 600, color: tot === 0 ? theme.sub : undefined }}>{tot === 0 ? '—' : moneyDC(tot)}</td>
                        : <td style={{ ...td, textAlign: 'right' }}>
                            <button onClick={() => abrir(c, null, 'todos os meses')}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', fontWeight: 600, color: theme.text, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
                              title="Ver todos os lançamentos da conta (todos os meses, todas as empresas ligadas)">{moneyDC(tot)}</button>
                          </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Lucro / Prejuízo do período</td>
                {colunas.map(col => { const L = lucroCol(col); return (
                  <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: 700, color: L >= 0 ? theme.green : theme.red }}>{money(L)}</td>
                ) })}
                {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: lucroTotal >= 0 ? theme.green : theme.red }}>{money(lucroTotal)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {detalhe && <ModalRazaoConsolidado detalhe={detalhe} onClose={() => setDetalhe(null)} />}
    </Wrap>
  )
}

// Razão consolidado (SOMENTE LEITURA): os lançamentos da conta nas empresas ligadas, com a coluna
// EMPRESA pra saber de qual empresa é cada lançamento. Sem ações de justificar/corrigir (isso é
// individual, em cada empresa).
function ModalRazaoConsolidado({ detalhe, onClose }) {
  const { reduzido, classif, nome, mesLabel, contribs } = detalhe
  const [carregando, setCarregando] = useState(true)
  const [linhas, setLinhas] = useState([])
  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCarregando(true)
      const nomeByComp = {}; for (const c of contribs) nomeByComp[c.compId] = c.nomeEmp
      const ids = [...new Set(contribs.map(c => c.compId))]
      const rows = ids.length ? await lerTudo(() => supabase
        .from('razao').select('id, competencia_id, data, conta, contrapartida, historico, debito, credito')
        .in('competencia_id', ids).eq('conta', reduzido).order('data', { ascending: true })) : []
      if (!vivo) return
      setLinhas(rows.map(r => ({ ...r, empresa: nomeByComp[r.competencia_id] || '' })))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [])
  const totD = linhas.reduce((s, l) => s + num(l.debito), 0)
  const totC = linhas.reduce((s, l) => s + num(l.credito), 0)
  const multiEmp = new Set(contribs.map(c => c.nomeEmp)).size > 1

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, width: 'min(1000px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: theme.text }}>{reduzido} · {nome}</div>
            <div style={{ fontSize: 12, color: theme.sub, marginTop: 2 }}>Classificação {classif} · {mesLabel} · razão consolidado (somente leitura)</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 13, padding: '4px 10px' }}><i className="ti ti-x" /></button>
        </div>
        <div style={{ overflow: 'auto', padding: '0 4px' }}>
          {carregando ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: 20 }}>Carregando lançamentos…</p>
          ) : !linhas.length ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: 20 }}>Nenhum lançamento nesta conta para as empresas ligadas.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                  <th style={{ ...th, minWidth: 150 }}>Empresa</th>
                  <th style={{ ...th, minWidth: 80 }}>Data</th>
                  <th style={th}>Histórico</th>
                  <th style={{ ...th, textAlign: 'right', minWidth: 110 }}>Débito</th>
                  <th style={{ ...th, textAlign: 'right', minWidth: 110 }}>Crédito</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map(l => (
                  <tr key={l.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={{ ...td, fontSize: 11.5, color: theme.accent, fontWeight: 600 }}>{l.empresa}</td>
                    <td style={{ ...td, fontSize: 12, color: theme.sub }}>{fmtData(l.data)}</td>
                    <td style={{ ...td, fontSize: 12, whiteSpace: 'normal', maxWidth: 460 }}>{l.historico || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontSize: 12, color: num(l.debito) ? theme.text : theme.sub }}>{num(l.debito) ? money(num(l.debito)) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontSize: 12, color: num(l.credito) ? theme.text : theme.sub }}>{num(l.credito) ? money(num(l.credito)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={3}>{linhas.length} lançamento(s){multiEmp ? ' · várias empresas' : ''}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totD)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totC)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// Dropdown de MESES — idêntico ao do Comp. Movimento.
function MultiMesSelect({ meses, sel, onChange }) {
  const [aberto, setAberto] = useState(false)
  const toggle = m => { const n = new Set(sel); n.has(m) ? n.delete(m) : n.add(m); onChange(n) }
  const marcados = meses.filter(m => sel.has(m)).map(m => MESES[m - 1])
  const label = sel.size === 0 ? 'Todos os meses' : marcados.length <= 3 ? marcados.join(', ') : `${marcados.length} meses`
  const linha = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6 }
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn btn-ghost" onClick={() => setAberto(a => !a)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 12px' }}>
        {label} <i className="ti ti-chevron-down" style={{ fontSize: 14 }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 8, zIndex: 41, minWidth: 180, maxHeight: 320, overflow: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.28)' }}>
            <label style={{ ...linha, fontWeight: 600 }} onClick={() => onChange(new Set())}>
              <input type="checkbox" readOnly checked={sel.size === 0} /> Todos os meses
            </label>
            <div style={{ height: 1, background: theme.border, margin: '6px 0' }} />
            {meses.map(m => (
              <label key={m} style={linha} onClick={() => toggle(m)}>
                <input type="checkbox" readOnly checked={sel.has(m)} /> {MESES[m - 1]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Dropdown de EMPRESAS (lista com checkboxes) — mesmo padrão dos outros filtros. "Todas" liga
// todas; a lupa "só esta" isola uma; o (mãe) marca a empresa dona do grupo.
function EmpresaDropdown({ empresas, ativas, maeId, onToggle, onTodas, onSo }) {
  const [aberto, setAberto] = useState(false)
  const linha = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6 }
  const todasOn = ativas.size === empresas.length
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn btn-ghost" onClick={() => setAberto(a => !a)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 12px' }}>
        {ativas.size}/{empresas.length} {todasOn ? '(todas)' : ''} <i className="ti ti-chevron-down" style={{ fontSize: 14 }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 8, zIndex: 41, minWidth: 280, maxHeight: 340, overflow: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.28)' }}>
            <label style={{ ...linha, fontWeight: 600 }} onClick={onTodas}>
              <input type="checkbox" readOnly checked={todasOn} /> Todas
            </label>
            <div style={{ height: 1, background: theme.border, margin: '6px 0' }} />
            {empresas.map(e => (
              <div key={e.id} style={{ ...linha, gap: 6, justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, minWidth: 0 }} onClick={() => onToggle(e.id)}>
                  <input type="checkbox" readOnly checked={ativas.has(e.id)} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.nome}{e.id === maeId ? <b style={{ color: theme.accent }}> (mãe)</b> : ''}</span>
                </label>
                <button title="Ver só esta" onClick={() => onSo(e.id)} style={{ background: 'none', border: 'none', color: theme.sub, cursor: 'pointer', fontSize: 14, padding: 0 }}><i className="ti ti-focus-2" /></button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Mesma casca do Comp. Movimento (Wrapper): <div> puro que preenche a área toda — sem maxWidth
// nem centralização, senão sobra faixa branca à esquerda e não fica "idêntico".
function Wrap({ children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Comp. Mov. Consolidado</h1>
        <InfoTela titulo="Comp. Mov. Consolidado">
          Mesmo layout e comportamento do <b>Comp. Movimento</b> (clique num valor para ver o razão), somando o grupo.
          Só <b>unifica</b> contas quando <b>conta + classificação + nome</b> são iguais; o que diverge entra separado
          (para montar o de-para). Use o filtro <b>Empresas</b> para <b>consolidar/desconsolidar</b> — ver todas, algumas
          ou uma só. É <b>só leitura</b> — a justificativa da oscilação continua individual em cada empresa. No razão,
          cada lançamento mostra <b>de qual empresa</b> é.
        </InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Comparativo mês a mês do grupo: soma das contas de resultado das empresas ligadas, com as mesmas variações e o mesmo razão do Comp. Movimento.
      </p>
      {children}
    </div>
  )
}
function Vazio({ icon, txt }) {
  return <div style={cardVazio}><i className={`ti ${icon}`} style={{ fontSize: 22, color: theme.accent }} /><p style={{ fontSize: 14, color: theme.text }}>{txt}</p></div>
}
const cardVazio = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 640 }
// Mesmos estilos do Comp. Movimento (para a tabela ficar idêntica).
const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
