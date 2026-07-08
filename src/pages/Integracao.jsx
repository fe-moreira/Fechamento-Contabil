import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import { normHist, casarHistorico, aprender, parseValor, dataISO } from '../lib/financeiro'
import { gerarDominioCSV } from '../lib/dominio'

const TABS = [['fiscal', 'Fiscal'], ['folha', 'Folha'], ['patrimonio', 'Patrimônio'], ['financeira', 'Financeira']]
const DESC = {
  fiscal: 'Importe o relatório fiscal (acumuladores) para cruzar com o razão.',
  folha: 'Importe os relatórios da folha (salários, encargos, 13º e férias) para cruzar com o razão.',
  patrimonio: 'Importe o resumo do patrimônio (depreciação e movimentação) para cruzar com o razão.',
}

// soma a primeira coluna numérica de cada linha (parse pt-BR tolerante)
function somaNumerica(linhas) {
  let tot = 0
  for (const r of linhas) for (const c of r) {
    if (typeof c === 'number') { tot += c; break }
    const s = String(c ?? '').trim()
    if (/^-?[\d.]+,\d{2}$/.test(s)) { tot += parseFloat(s.replace(/\./g, '').replace(',', '.')); break }
  }
  return tot
}

export default function Integracao() {
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId, plano } = useAppData()
  const { user } = useAuth()
  const cliente = empresas.find(e => e.id === empresaId)
  const integ = cliente?.integracao_financeira || 'Não usa'
  const sistema = (cliente?.sistema_financeiro || '').trim()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))

  // Persiste o estado da integração financeira (por banco) na competência.
  async function salvarFinanceira(novoFin) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, financeira: novoFin }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
  const [tab, setTab] = useState('fiscal')
  const [dados, setDados] = useState({}) // { tab: { nome, linhas } }
  const [estado, setEstado] = useState({}) // integrações validadas/sem movimento salvas na competência
  const [erro, setErro] = useState('')

  // Carrega o estado das integrações já salvas nesta competência.
  useEffect(() => {
    if (!empresaId) { setEstado({}); return }
    const [mes, ano] = (competencia || '').split('/').map(Number)
    supabase.from('competencias').select('integracoes')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      .then(({ data }) => setEstado(data?.integracoes || {}))
  }, [empresaId, competencia])

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para usar a integração." /></Wrapper>
  }

  async function importar(alvo, file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const linhas = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 300)
      setDados(d => ({ ...d, [alvo]: { nome: file.name, linhas } }))
      // Persiste: integração validada (documento importado) na competência → some do Status.
      const id = await getCompetenciaId()
      if (id) {
        const novo = { ...estado, [alvo]: { estado: 'validado', doc: file.name, usuario: user?.email || null } }
        await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
        setEstado(novo)
      }
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 500, border: tab === id ? 'none' : `1px solid ${theme.border}`, background: tab === id ? theme.accent : 'transparent', color: tab === id ? '#fff' : theme.text, cursor: 'pointer' }}>{label}</button>
        ))}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}

      {tab === 'financeira'
        ? (integ === 'Excel'
          ? <Financeira competencia={competencia} est={estado.financeira || {}} empresaId={empresaId} planoMap={planoMap} user={user} onEstado={salvarFinanceira} />
          : <FinanceiraViaSistema integ={integ} sistema={sistema} />)
        : <Cruzamento tab={tab} dados={dados[tab]} onImport={f => importar(tab, f)} est={estado[tab]} />}
    </Wrapper>
  )
}

function EstadoBadge({ est }) {
  if (!est?.estado) return null
  const semMov = est.estado === 'sem_movimento'
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: semMov ? theme.sub : theme.green, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 20, padding: '5px 12px', marginBottom: 12 }}>
      <i className={`ti ${semMov ? 'ti-circle-minus' : 'ti-circle-check'}`} />
      {semMov ? 'Sem movimento no período' : `Validado${est.doc ? ` · ${est.doc}` : ''}`}
    </div>
  )
}

function Cruzamento({ tab, dados, onImport, est }) {
  const total = dados ? somaNumerica(dados.linhas) : 0
  return (
    <>
      <div><EstadoBadge est={est} /></div>
      <ImpCard titulo={`Importar — ${DESC[tab].split(' ')[1] || 'relatório'}`} desc={DESC[tab]} onImport={onImport} nome={dados?.nome} qtd={dados?.linhas.length} />
      {dados && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12, marginTop: 16 }}>
          <Metric label="Total do relatório" valor={money(total)} icon="ti-receipt" />
          <Metric label="Linhas importadas" valor={dados.linhas.length} icon="ti-list-details" />
          <Metric label="Cruzar com o razão" valor="manual" icon="ti-arrows-diff" cor={theme.yellow} sub="confira na Conciliação" />
        </div>
      )}
    </>
  )
}

// Índice da coluna que melhor casa com um regex no cabeçalho; senão -1.
function achaColuna(header, re) {
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return (header || []).findIndex(h => re.test(norm(h)))
}

function Financeira({ competencia, est, empresaId, planoMap, user, onEstado }) {
  const [contas, setContas] = useState([])       // [{ conta_contabil, agencia, conta }]
  const [memoria, setMemoria] = useState([])     // [{ termo, conta }]
  const [memMeta, setMemMeta] = useState({ nomeArquivo: '', semCarga: false })
  const [carregReg, setCarregReg] = useState(true)
  const [novo, setNovo] = useState({ conta_contabil: '', agencia: '', conta: '' })
  const [modo, setModo] = useState('porBanco')   // 'porBanco' | 'combinado'
  const [raw, setRaw] = useState(null)           // { nome, header, linhasRaw, banco }
  const [map, setMap] = useState({ hist: -1, valor: -1, data: -1 })
  const [linhas, setLinhas] = useState([])       // classificação: [{ banco, historico, valor, entrada, contra, data }]
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')
  const bancosEst = est?.bancos || {}

  useEffect(() => {
    setCarregReg(true); setRaw(null); setLinhas([]); setErro(''); setMsg('')
    Promise.all([
      supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([bc, mem]) => {
      setContas(Array.isArray(bc.data?.dados) ? bc.data.dados : [])
      setMemoria(Array.isArray(mem.data?.dados) ? mem.data.dados : [])
      let meta = { nomeArquivo: '', semCarga: false }
      try { const m = JSON.parse(mem.data?.obs || ''); if (m && typeof m === 'object') meta = { nomeArquivo: m.nomeArquivo || '', semCarga: !!m.semCarga } } catch { /* obs antigo em texto */ }
      setMemMeta(meta)
      setCarregReg(false)
    })
  }, [empresaId])

  async function salvarCarga(tipo, arr, obs) {
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', tipo)
    await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo, vigencia: competencia, dados: arr, usuario: user?.email || null, obs })
  }
  async function salvarContas(arr) { setContas(arr); await salvarCarga('contas_bancarias', arr, 'Contas bancárias') }
  function addConta() {
    const cod = String(novo.conta_contabil || '').trim()
    if (!cod) return
    if (contas.some(c => String(c.conta_contabil).trim() === cod)) { setErro('Essa conta já está cadastrada.'); return }
    setErro(''); salvarContas([...contas, { conta_contabil: cod, agencia: novo.agencia.trim(), conta: novo.conta.trim() }])
    setNovo({ conta_contabil: '', agencia: '', conta: '' })
  }
  const removeConta = i => salvarContas(contas.filter((_, j) => j !== i))

  // Memória: grava entradas + metadados (arquivo de origem / marcado "sem carga").
  async function salvarMemoria(entries, meta) {
    setMemoria(entries); setMemMeta(meta)
    await salvarCarga('memoria_financeira', entries, JSON.stringify(meta))
  }
  async function excluirMemoria() {
    if (!window.confirm('Excluir a memória do financeiro deste cliente? As classificações aprendidas serão perdidas.')) return
    await salvarMemoria([], { nomeArquivo: '', semCarga: false }); setMsg('Memória excluída.')
  }
  async function marcarSemCarga() { await salvarMemoria([], { nomeArquivo: '', semCarga: true }); setMsg('Marcado: não tem carga inicial.') }

  // Estado por banco na competência (importado / sem movimento). Vazio = pendente.
  function marcarBanco(conta, estadoB, doc) {
    const bancos = { ...(est?.bancos || {}) }
    if (estadoB) bancos[conta] = { estado: estadoB, doc: doc || null, usuario: user?.email || null }
    else delete bancos[conta]
    onEstado({ ...est, bancos })
  }
  function marcarCombinado(doc) { onEstado({ ...est, combinado: { estado: 'validado', doc, usuario: user?.email || null } }) }

  // Reconstroi a classificação a partir do arquivo cru + mapa de colunas + memória.
  function classificar(rawX, mapX, memX, bancoFixo) {
    const codigos = new Set(contas.map(c => String(c.conta_contabil).trim()))
    return rawX.linhasRaw.map(cells => {
      let banco = bancoFixo || ''
      if (modo === 'combinado') { banco = ''; for (const c of cells) { const v = String(c ?? '').trim(); if (codigos.has(v)) { banco = v; break } } }
      const historico = mapX.hist >= 0 ? String(cells[mapX.hist] ?? '').trim() : ''
      const valor = mapX.valor >= 0 ? parseValor(cells[mapX.valor]) : 0
      const data = mapX.data >= 0 ? dataISO(cells[mapX.data]) : ''
      return { banco, historico, valor: Math.abs(valor), entrada: valor >= 0, contra: casarHistorico(historico, memX), data }
    })
  }

  async function importar(file, bancoFixo) {
    if (!file) return
    setErro(''); setMsg('')
    try {
      if (modo === 'combinado' && !contas.length) { setErro('Cadastre as contas bancárias antes de importar uma planilha combinada.'); return }
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const header = arr[0] || []
      const linhasRaw = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 1000)
      // Auto-detecta as colunas de histórico, valor e data.
      let hist = achaColuna(header, /hist|descri|lancament|memo|complemento/)
      let valor = achaColuna(header, /valor|montante|r\$|credito|debito/)
      const data = achaColuna(header, /^data|\bdata\b|dt\b/)
      if (hist < 0) {
        let melhor = -1, best = 0
        for (let j = 0; j < (header.length || (linhasRaw[0]?.length || 0)); j++) {
          const avg = linhasRaw.reduce((s, r) => s + (typeof r[j] === 'string' ? r[j].length : 0), 0) / (linhasRaw.length || 1)
          if (avg > best) { best = avg; melhor = j }
        }
        hist = melhor
      }
      if (valor < 0) {
        for (let j = 0; j < (header.length || 0); j++) { if (linhasRaw.filter(r => typeof r[j] === 'number' || parseValor(r[j])).length > linhasRaw.length / 2) { valor = j; break } }
      }
      const mapa = { hist, valor, data }
      const novoRaw = { nome: file.name, header, linhasRaw, banco: bancoFixo || '' }
      setRaw(novoRaw); setMap(mapa)
      const cl = classificar(novoRaw, mapa, memoria, bancoFixo)
      setLinhas(cl)
      const casadas = cl.filter(l => l.contra).length
      setMsg(`${cl.length} linha(s) · ${casadas} já classificada(s) pela memória.`)
      if (modo === 'combinado') marcarCombinado(file.name)
      else if (bancoFixo) marcarBanco(bancoFixo, 'validado', file.name)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  function trocarCol(campo, idx) {
    const mapa = { ...map, [campo]: idx }
    setMap(mapa)
    if (raw) setLinhas(classificar(raw, mapa, memoria, raw.banco))
  }
  const setLinha = (i, patch) => setLinhas(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))

  // Aprende: guarda histórico → contrapartida das linhas classificadas.
  async function aprenderSalvar() {
    const novas = linhas.filter(l => l.contra && l.historico).map(l => ({ historico: l.historico, conta: l.contra }))
    if (!novas.length) { setMsg('Classifique ao menos uma linha (contrapartida) antes de salvar.'); return }
    const mem = aprender(memoria, novas)
    await salvarMemoria(mem, { nomeArquivo: memMeta.nomeArquivo, semCarga: false })
    setMsg(`Memória atualizada — ${novas.length} classificação(ões) aprendida(s).`)
  }

  // Semeia/complementa a memória a partir de uma planilha (Histórico | Conta contrapartida).
  async function importarMemoria(file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const header = arr[0] || []
      const iH = achaColuna(header, /hist|descri|memo/)
      const iC = achaColuna(header, /conta|contrapart|codigo/)
      const rows = (iH >= 0 && iC >= 0) ? arr.slice(1) : arr
      const novas = []
      for (const r of rows) {
        const h = String((iH >= 0 ? r[iH] : r[0]) ?? '').trim()
        const c = String((iC >= 0 ? r[iC] : r[1]) ?? '').trim()
        if (h && c) novas.push({ historico: h, conta: c })
      }
      if (!novas.length) { setErro('Não achei as colunas Histórico e Conta na planilha.'); return }
      if (!window.confirm(`Importar ${novas.length} histórico(s) para a memória do financeiro deste cliente? Confira antes de confirmar.`)) return
      const mem = aprender(memoria, novas)
      await salvarMemoria(mem, { nomeArquivo: file.name, semCarga: false })
      setMsg(`Memória atualizada — ${novas.length} histórico(s) importado(s) (arquivo: ${file.name}).`)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  // Gera a partida completa para o Domínio (banco + contrapartida, por entrada/saída).
  function gerar() {
    const prontasL = linhas.filter(l => l.banco && l.contra && l.valor > 0)
    if (!prontasL.length) { setErro('Nenhuma linha com banco e contrapartida para gerar.'); return }
    const lanc = prontasL.map(l => ({
      data: l.data || null,
      conta_debito: l.entrada ? l.banco : l.contra,   // entrada: D banco; saída: D contrapartida
      conta_credito: l.entrada ? l.contra : l.banco,
      valor: l.valor,
      historico: l.historico,
    }))
    gerarDominioCSV(lanc, `financeiro_dominio_${competencia.replace('/', '-')}.csv`)
  }

  const prontas = linhas.filter(l => l.banco && l.contra && l.valor > 0).length
  const semContra = linhas.filter(l => !l.contra).length
  const memAtiva = memoria.length > 0

  return (
    <>
      {/* Cadastro das contas bancárias do cliente */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>Contas bancárias do cliente</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>Informe a <b style={{ color: theme.text }}>conta contábil</b> de cada banco (o nome vem do plano). Cada banco cadastrado vira um slot de importação abaixo. <span style={{ color: theme.accent }}>F4</span> abre o plano.</p>
        {carregReg ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Carregando…</p> : (
          <>
            {contas.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {contas.map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 13 }}>
                    <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                    <span style={{ fontWeight: 600, minWidth: 70 }}>{c.conta_contabil}</span>
                    <span style={{ flex: 1, color: theme.sub }}>{nomeBanco(c.conta_contabil)}{(c.agencia || c.conta) ? ` · ag ${c.agencia || '—'} / cc ${c.conta || '—'}` : ''}</span>
                    <i className="ti ti-trash" title="Remover" onClick={() => removeConta(i)} style={{ color: theme.sub, cursor: 'pointer' }} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ minWidth: 170 }}><label>Conta contábil</label><CampoConta value={novo.conta_contabil} onChange={v => setNovo(n => ({ ...n, conta_contabil: v }))} /></div>
              <div><label>Agência (opc.)</label><input className="input" style={{ maxWidth: 120 }} value={novo.agencia} onChange={e => setNovo(n => ({ ...n, agencia: e.target.value }))} /></div>
              <div><label>Conta (opc.)</label><input className="input" style={{ maxWidth: 130 }} value={novo.conta} onChange={e => setNovo(n => ({ ...n, conta: e.target.value }))} /></div>
              <button className="btn" onClick={addConta}><i className="ti ti-plus" /> Adicionar</button>
            </div>
          </>
        )}
      </div>

      {/* Memória do financeiro — verde (ativa) / pendente / sem carga */}
      {!carregReg && (
        <div style={{ background: theme.card, border: `1px solid ${memAtiva ? 'rgba(48,164,108,0.5)' : memMeta.semCarga ? theme.cb : 'rgba(245,166,35,0.5)'}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <i className="ti ti-brain" style={{ fontSize: 20, color: memAtiva ? theme.green : memMeta.semCarga ? theme.sub : theme.yellow }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>Memória do financeiro (histórico → contrapartida)</p>
              <p style={{ fontSize: 12, margin: '2px 0 0', color: memAtiva ? theme.green : memMeta.semCarga ? theme.sub : theme.yellow }}>
                {memAtiva ? <><i className="ti ti-circle-check" /> <b>Ativa</b> · {memoria.length} histórico(s){memMeta.nomeArquivo ? ` · arquivo: ${memMeta.nomeArquivo}` : ''}</>
                  : memMeta.semCarga ? <><i className="ti ti-circle-minus" /> Sem carga inicial (marcado)</>
                    : <><i className="ti ti-alert-triangle" /> Pendente — importe a carga inicial ou marque que não tem</>}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
              <i className="ti ti-upload" /> {memAtiva ? 'Complementar' : 'Importar carga inicial'}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importarMemoria(e.target.files?.[0])} />
            </label>
            {memAtiva && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={excluirMemoria}><i className="ti ti-trash" /> Excluir memória</button>}
            {!memAtiva && !memMeta.semCarga && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={marcarSemCarga}><i className="ti ti-circle-minus" /> Não tem carga inicial</button>}
            {!memAtiva && memMeta.semCarga && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => salvarMemoria([], { nomeArquivo: '', semCarga: false })}><i className="ti ti-rotate" /> Desfazer</button>}
          </div>
        </div>
      )}

      {/* Como o extrato vem */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className={modo === 'porBanco' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('porBanco')}><i className="ti ti-file" /> Um arquivo por banco</button>
        <button className={modo === 'combinado' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('combinado')}><i className="ti ti-files" /> Planilha combinada</button>
      </div>

      {modo === 'porBanco' ? (
        contas.length === 0
          ? <p style={{ color: theme.yellow, fontSize: 12.5, margin: '0 0 12px' }}>Cadastre as contas bancárias acima para liberar um slot de importação por banco.</p>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 14 }}>
              {contas.map(c => {
                const s = bancosEst[c.conta_contabil]
                const cor = s?.estado === 'validado' ? theme.green : s?.estado === 'sem_movimento' ? theme.sub : theme.red
                const txt = s?.estado === 'validado' ? `Importado${s.doc ? ` · ${s.doc}` : ''}` : s?.estado === 'sem_movimento' ? 'Sem movimento no mês' : 'Pendente'
                return (
                  <div key={c.conta_contabil} style={{ background: theme.card, border: `1px solid ${s?.estado === 'sem_movimento' ? theme.cb : cor}`, borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{c.conta_contabil} · {nomeBanco(c.conta_contabil)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: cor, margin: '0 0 10px', fontWeight: 500 }}><i className={`ti ${s?.estado === 'validado' ? 'ti-circle-check' : s?.estado === 'sem_movimento' ? 'ti-circle-minus' : 'ti-alert-triangle'}`} /> {txt}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <label className="btn" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
                        <i className="ti ti-cloud-upload" /> {s?.estado === 'validado' ? 'Reimportar' : 'Importar extrato'}
                        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importar(e.target.files?.[0], c.conta_contabil)} />
                      </label>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => marcarBanco(c.conta_contabil, 'sem_movimento')}><i className="ti ti-circle-minus" /> Sem movimento</button>
                      {s?.estado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => marcarBanco(c.conta_contabil, null)}>limpar</button>}
                    </div>
                  </div>
                )
              })}
            </div>
          )
      ) : (
        <>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 8px' }}>A planilha traz todos os bancos juntos — cada linha deve ter a <b style={{ color: theme.text }}>conta contábil</b> numa das colunas. A plataforma casa com o cadastro e separa por banco.</p>
          <ImpCard titulo="Importar planilha combinada" desc="Importe o extrato com todos os bancos (Excel/CSV)." onImport={f => importar(f)} nome={raw?.nome} qtd={linhas.length} />
        </>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}
      {msg && <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msg}</p>}

      {raw && (
        <>
          {/* Mapa de colunas (auto-detectado, ajustável) */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '14px 0 6px' }}>
            {[['hist', 'Histórico'], ['valor', 'Valor'], ['data', 'Data (opc.)']].map(([campo, lab]) => (
              <div key={campo}><label>{lab}</label>
                <select className="input" style={{ padding: '8px 10px', fontSize: 12.5 }} value={map[campo]} onChange={e => trocarCol(campo, Number(e.target.value))}>
                  <option value={-1}>—</option>
                  {(raw.header || []).map((h, j) => <option key={j} value={j}>{String(h || `Coluna ${j + 1}`)}</option>)}
                </select>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '6px 0 10px' }}>
            <span style={{ color: theme.green }}><b>{prontas}</b> pronta(s) p/ contabilizar</span>
            <span style={{ color: theme.yellow }}><b>{semContra}</b> sem contrapartida</span>
          </div>

          {/* Tabela de classificação */}
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxHeight: 460 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                  <th style={fth}>Banco</th><th style={fth}>Histórico</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>E/S</th><th style={fth}>Contrapartida</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: !l.banco ? 'rgba(245,166,35,0.06)' : 'transparent' }}>
                    <td style={{ ...ftd, fontSize: 11.5 }}>{l.banco ? `${l.banco} · ${nomeBanco(l.banco)}` : <span style={{ color: theme.yellow }}>sem banco</span>}</td>
                    <td style={{ ...ftd, color: theme.sub, fontSize: 11.5, maxWidth: 260 }}>{l.historico || '—'}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                    <td style={{ ...ftd }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: l.entrada ? theme.green : theme.red, borderColor: l.entrada ? theme.green : theme.red }} onClick={() => setLinha(i, { entrada: !l.entrada })}>{l.entrada ? 'Entrada' : 'Saída'}</button>
                    </td>
                    <td style={{ ...ftd, minWidth: 180 }}><CampoConta value={l.contra} onChange={v => setLinha(i, { contra: v })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn" onClick={aprenderSalvar}><i className="ti ti-brain" /> Aprender e salvar</button>
            <button className="btn btn-ghost" disabled={!prontas} onClick={gerar}><i className="ti ti-file-export" /> Gerar arquivo do Domínio ({prontas})</button>
          </div>
          <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>Preencha a contrapartida das linhas que faltam e clique em <b style={{ color: theme.text }}>Aprender e salvar</b> — no próximo mês elas já vêm classificadas. Entrada = D banco / C contrapartida; Saída = D contrapartida / C banco.</p>
        </>
      )}
    </>
  )
}

const fth = { textAlign: 'left', padding: '9px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const ftd = { padding: '7px 12px', fontSize: 12.5, color: theme.text, verticalAlign: 'middle' }

// Cliente sem integração por Excel: não habilita a importação, só informa a origem.
function FinanceiraViaSistema({ integ, sistema }) {
  const usaSistema = integ === 'Sistema' || (integ !== 'Excel' && sistema)
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '26px 24px', display: 'flex', alignItems: 'center', gap: 16, maxWidth: 640 }}>
      <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 12, width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <i className={`ti ${usaSistema ? 'ti-plug-connected' : 'ti-plug-off'}`} style={{ color: theme.accent, fontSize: 24 }} />
      </span>
      <div>
        {usaSistema ? (
          <>
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Financeiro importado via sistema</p>
            <p style={{ color: theme.sub, fontSize: 13.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Este cliente utiliza o sistema <b style={{ color: theme.text }}>{sistema || 'não informado'}</b>. A importação por Excel fica desabilitada — o financeiro vem direto do sistema.
              {!sistema && <span style={{ display: 'block', color: theme.yellow, marginTop: 6 }}>Informe o sistema no cadastro do cliente (campo “Sistema financeiro”).</span>}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Sem integração financeira</p>
            <p style={{ color: theme.sub, fontSize: 13.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Este cliente está marcado como <b style={{ color: theme.text }}>“Não usa”</b> integração financeira. Para habilitar a importação por Excel, ajuste o campo “Integração financeira” do cliente para <b style={{ color: theme.text }}>Excel</b>.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function ImpCard({ titulo, desc, onImport, nome, qtd }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <i className="ti ti-cloud-upload" style={{ color: theme.accent, fontSize: 20 }} />
      </span>
      <div style={{ flex: 1, minWidth: 180 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}>{titulo}</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '2px 0 0' }}>{nome ? `${nome} — ${qtd} linha(s)` : desc}</p>
      </div>
      <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <i className="ti ti-file-spreadsheet" /> Importar
        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => onImport(e.target.files?.[0])} />
      </label>
    </div>
  )
}

function Balde({ titulo, cor, icon, linhas, vazio }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${theme.border}` }}>
        <i className={`ti ${icon}`} style={{ color: cor }} />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{titulo}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.sub }}>{linhas.length}</span>
      </div>
      {linhas.length === 0
        ? <p style={{ padding: 18, color: theme.sub, fontSize: 12.5 }}>{vazio}</p>
        : <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {linhas.map((l, i) => (
            <div key={i} style={{ padding: '9px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12.5, color: theme.text, display: 'flex', gap: 12 }}>
              {l.slice(0, 4).map((c, j) => (
                <span key={j} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: typeof c === 'number' ? 'right' : 'left', color: typeof c === 'number' ? theme.text : theme.sub }}>
                  {typeof c === 'number' ? money(c) : String(c ?? '')}
                </span>
              ))}
            </div>
          ))}
        </div>}
    </div>
  )
}

function Metric({ label, valor, icon, cor, sub }) {
  return (
    <div style={{ background: theme.input, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 16 }} />
      </div>
      <p style={{ fontSize: 20, fontWeight: 700, margin: '8px 0 0', color: cor || theme.text }}>{valor}</p>
      {sub && <p style={{ color: theme.sub, fontSize: 11, margin: '3px 0 0' }}>{sub}</p>}
    </div>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Integração</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>As quatro integrações para o contábil. Tem que dar zero.</p>
      {children}
    </div>
  )
}
function Aviso({ texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
