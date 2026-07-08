import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import { normHist, casarHistorico, aprender, parseValor, dataISO, aplicarPerfil, extrairEntidade, ehEmpresa, catByRowDeMerges } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
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
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId, plano, isAdmin } = useAppData()
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
          ? <Financeira competencia={competencia} est={estado.financeira || {}} empresaId={empresaId} planoMap={planoMap} user={user} onEstado={salvarFinanceira} isAdmin={isAdmin} usaCC={!!cliente?.usa_centro_custo} />
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

// Trava de competência: toda data do extrato precisa cair no mês do fechamento.
// Retorna a mensagem de erro (string vazia = ok).
function validarCompetencia(linhas, mapa, comp) {
  const [mm, yyyy] = String(comp || '').split('/')
  if (!mm || !yyyy) return ''
  const alvo = `${yyyy}-${mm.padStart(2, '0')}`
  if (mapa.data < 0) return `Não identifiquei a coluna de Data no arquivo. Selecione a coluna "Data" abaixo — o extrato precisa ser todo de ${comp}.`
  const fora = linhas.filter(l => l.data && l.data.slice(0, 7) !== alvo)
  if (fora.length) {
    const ex = [...new Set(fora.map(l => l.data.split('-').reverse().join('/')))].slice(0, 3).join(', ')
    return `O extrato tem ${fora.length} lançamento(s) fora de ${comp} (ex.: ${ex}). Importe apenas o extrato da competência ${comp}.`
  }
  const semData = linhas.filter(l => !l.data).length
  if (semData) return `${semData} linha(s) sem data reconhecida. Confira a coluna de Data — todas precisam ser de ${comp}.`
  return ''
}

function Financeira({ competencia, est, empresaId, planoMap, user, onEstado, isAdmin, usaCC }) {
  const [contas, setContas] = useState([])       // [{ conta_contabil, agencia, conta }]
  const [memoria, setMemoria] = useState([])     // [{ termo, conta }]
  const [memMeta, setMemMeta] = useState({ nomeArquivo: '', semCarga: false })
  const [carregReg, setCarregReg] = useState(true)
  const [novo, setNovo] = useState({ conta_contabil: '', agencia: '', conta: '' })
  const [modo, setModo] = useState('porBanco')   // 'porBanco' | 'combinado'
  const [raw, setRaw] = useState(null)           // { nome, header, linhasRaw, banco, viaPerfil }
  const [map, setMap] = useState({ hist: -1, valor: -1, data: -1 })
  const [linhas, setLinhas] = useState([])       // classificação: [{ banco, historico, valor, entrada, contra, data }]
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [perfil, setPerfil] = useState(null)     // perfil de leitura do extrato deste cliente
  const [cfg, setCfg] = useState(null)           // { raw, banco, perfil } — painel de mapeamento aberto
  const [fSem, setFSem] = useState(false)        // filtro: só linhas sem contrapartida
  const [fHist, setFHist] = useState('')         // filtro por histórico
  const [fMode, setFMode] = useState('contem')   // 'contem' | 'exato'
  const [fData, setFData] = useState('')         // filtro por data (dd/mm)
  const [fES, setFES] = useState('')             // filtro entrada/saída ('' | 'entrada' | 'saida')
  const [fConta, setFConta] = useState('')       // filtro por conta de contrapartida
  const [lote, setLote] = useState('')           // conta para preencher em lote nas selecionadas
  const [sel, setSel] = useState(() => new Set())// linhas selecionadas (índice original)
  const [quebra, setQuebra] = useState(null)      // { i, linha } divisão de um lançamento
  const [saldoAnterior, setSaldoAnterior] = useState(null) // saldo do banco no balancete (abertura)
  const [saldoExtrato, setSaldoExtrato] = useState('')     // saldo do extrato informado pelo usuário
  const [cruza, setCruza] = useState(null)                 // resultado do cruzamento por dia com o extrato
  const refsContra = useRef({})                  // foco: Enter pula para a próxima linha

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')
  const bancosEst = est?.bancos || {}
  // Contas de adiantamento (nome contém "adiant") — usadas para a regra: com nota não é adiantamento.
  const adiantContas = new Set(Object.entries(planoMap).filter(([, pl]) => /adiant/i.test(pl?.nome || '')).map(([cod]) => cod))

  useEffect(() => {
    setCarregReg(true); setRaw(null); setLinhas([]); setErro(''); setMsg('')
    Promise.all([
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([bc, mem]) => {
      setContas(Array.isArray(bc.data?.dados) ? bc.data.dados : [])
      let perf = null
      try { const o = JSON.parse(bc.data?.obs || ''); if (o && typeof o === 'object' && o.perfil) perf = o.perfil } catch { /* obs antigo em texto */ }
      setPerfil(perf); setCfg(null)
      setMemoria(Array.isArray(mem.data?.dados) ? mem.data.dados : [])
      let meta = { nomeArquivo: '', semCarga: false }
      try { const m = JSON.parse(mem.data?.obs || ''); if (m && typeof m === 'object') meta = { nomeArquivo: m.nomeArquivo || '', semCarga: !!m.semCarga } } catch { /* obs antigo em texto */ }
      setMemMeta(meta)
      setCarregReg(false)
    })
  }, [empresaId])

  // Cadastro de bancos e memória valem para todas as competências (o cliente
  // cadastra uma vez). Por isso é lido sempre pelo registro mais recente, sem
  // filtro de mês, e persiste para os próximos meses.
  async function salvarCarga(tipo, arr, obs) {
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', tipo)
    const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo, vigencia: competencia, dados: arr, usuario: user?.email || null, obs })
    if (error) setErro('Não consegui gravar: ' + error.message)
    return error
  }
  // O perfil de leitura do extrato vive no obs da carga de contas bancárias
  // (uma vez por cliente, vale para todos os meses).
  async function salvarContas(arr, perf = perfil) { setContas(arr); await salvarCarga('contas_bancarias', arr, JSON.stringify({ perfil: perf || null })) }
  async function salvarPerfil(perf) { setPerfil(perf); await salvarCarga('contas_bancarias', contas, JSON.stringify({ perfil: perf || null })) }
  function addConta() {
    const cod = String(novo.conta_contabil || '').trim()
    if (!cod) return
    if (contas.some(c => String(c.conta_contabil).trim() === cod)) { setErro('Essa conta já está cadastrada.'); return }
    setErro(''); salvarContas([...contas, { conta_contabil: cod, agencia: novo.agencia.trim(), conta: novo.conta.trim() }])
    setNovo({ conta_contabil: '', agencia: '', conta: '' })
  }
  const removeConta = i => salvarContas(contas.filter((_, j) => j !== i))
  // Excluir banco do cadastro (só admin): tira o slot e limpa o estado da competência.
  async function excluirBanco(c) {
    if (!window.confirm(`Excluir o banco ${c.conta_contabil} · ${nomeBanco(c.conta_contabil)} do cadastro? Ele deixa de exigir integração nesta e nas próximas competências.`)) return
    marcarBanco(c.conta_contabil, null)
    await salvarContas(contas.filter(x => String(x.conta_contabil) !== String(c.conta_contabil)))
  }

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
  // Salva o banco com o rascunho da classificação (linhas), para continuar depois.
  // estado 'rascunho' = em andamento (ainda pendente no Status); 'validado' = concluído.
  function salvarBancoDraft(conta, estadoB, doc, draftLinhas) {
    const bancos = { ...(est?.bancos || {}) }
    bancos[conta] = { estado: estadoB, doc: doc || null, usuario: user?.email || null, draft: draftLinhas || null, saldoExtrato: saldoExtrato || null }
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

  // Palpite inicial do perfil (o usuário confere/ajusta no painel de mapeamento).
  function perfilPadrao(arr) {
    let ini = 1
    for (let i = 0; i < Math.min(arr.length, 40); i++) {
      const r = arr[i] || []
      const filled = r.filter(c => c !== '' && c != null).length
      const hasNum = r.some(c => typeof c === 'number' || parseValor(c) > 1)
      if (filled >= 3 && hasNum) { ini = i; break }
    }
    const rows = arr.slice(ini, ini + 60)
    const nc = arr.reduce((m, r) => Math.max(m, (r || []).length), 0)
    let colValor = -1, colData = -1, colCredor = -1, best = 0, bestLen = 0
    for (let j = 0; j < nc; j++) {
      const nums = rows.filter(r => { const v = parseValor(r?.[j]); return v && Math.abs(v) >= 1 }).length
      if (nums > best) { best = nums; colValor = j }
      if (colData < 0 && rows.filter(r => dataISO(r?.[j])).length > rows.length / 3) colData = j
      const avg = rows.reduce((s, r) => { const t = String(r?.[j] ?? ''); return s + (/[A-Za-z]{3,}/.test(t) ? t.length : 0) }, 0) / (rows.length || 1)
      if (avg > bestLen) { bestLen = avg; colCredor = j }
    }
    return { linhaInicio: ini, colValor, colData, colCredor, colDoc: -1, colCategoria: -1, histCols: [], es: { modo: 'sinal', col: -1, entrada: [] }, filtro: { col: -1, pularVazio: false } }
  }

  // Aplica o perfil já salvo a um extrato por banco e segue (marca o banco).
  function aplicarEProsseguir(arr, nome, bancoFixo, perf, catByRow) {
    const norm = aplicarPerfil(arr, perf, memoria, catByRow, adiantContas).map(l => ({ ...l, banco: bancoFixo }))
    // Reimport do mesmo arquivo: preserva as contrapartidas já preenchidas no
    // rascunho (mesmo arquivo → mesma ordem), atualizando histórico/valor/data.
    const prevBanco = (est?.bancos || {})[bancoFixo]
    const prev = prevBanco?.draft
    let mantidas = 0
    if (Array.isArray(prev) && prev.length === norm.length) {
      norm.forEach((l, i) => { if (prev[i]?.contra) { l.contra = prev[i].contra; mantidas++ } })
    }
    if (prevBanco?.saldoExtrato) setSaldoExtrato(prevBanco.saldoExtrato)
    setRaw({ nome, banco: bancoFixo, viaPerfil: true, arr, catByRow })
    setLinhas(norm); setSel(new Set())
    if (!norm.length) { setErro('O perfil de leitura não encontrou lançamentos. Clique em “Ajustar leitura” e revise o mapeamento.'); return }
    const erroComp = validarCompetencia(norm, { data: (perf.colData != null && perf.colData >= 0) ? 0 : -1 }, competencia)
    if (erroComp) { setErro(erroComp); return }
    const casadas = norm.filter(l => l.contra).length
    setMsg(`${norm.length} linha(s) · ${casadas} classificada(s)${mantidas ? ` · ${mantidas} do rascunho preservada(s)` : ' pela memória'}. Rascunho salvo — conclua quando tudo estiver contabilizado.`)
    // Salva como rascunho (em andamento); só vira "concluído" ao clicar Concluir.
    salvarBancoDraft(bancoFixo, 'rascunho', nome, norm)
  }

  // Salva o progresso atual (rascunho) sem concluir.
  function salvarRascunho() {
    if (!raw?.banco) return
    salvarBancoDraft(raw.banco, 'rascunho', raw.nome, linhas)
    setMsg('Rascunho salvo — você pode fechar e continuar depois.')
  }
  // Conclui o banco (marca como contabilizado) — some do pendente no Status.
  function concluirBanco() {
    if (!raw?.banco) return
    const faltam = linhas.filter(l => !l.contra).length
    if (faltam && !window.confirm(`Ainda há ${faltam} linha(s) sem contrapartida. Concluir assim mesmo?`)) return
    salvarBancoDraft(raw.banco, 'validado', raw.nome, linhas)
    setMsg('Banco concluído — lançamentos contabilizados.')
  }
  // Continua um rascunho salvo (carrega as linhas para a tela).
  function continuarRascunho(conta) {
    const s = (est?.bancos || {})[conta]
    if (!s?.draft) return
    setRaw({ nome: s.doc || 'Rascunho', banco: conta, viaPerfil: true, resumo: true })
    setLinhas(s.draft); setSel(new Set()); setErro(''); setSaldoExtrato(s.saldoExtrato || '')
    setMsg(`Rascunho carregado — ${s.draft.length} linha(s). Continue de onde parou.`)
  }

  // Desfaz a importação atual: limpa a prévia/filtros e volta o banco a pendente.
  function desfazerImport() {
    if (raw?.viaPerfil && raw.banco) marcarBanco(raw.banco, null)
    else if (modo === 'combinado') { const e = { ...est }; delete e.combinado; onEstado(e) }
    setRaw(null); setLinhas([]); setSel(new Set())
    setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta(''); setLote('')
    setErro(''); setMsg('Importação desfeita — pode iniciar uma nova.')
  }

  async function importar(file, bancoFixo) {
    if (!file) return
    setErro(''); setMsg('')
    try {
      if (modo === 'combinado' && !contas.length) { setErro('Cadastre as contas bancárias antes de importar uma planilha combinada.'); return }
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      const catByRow = catByRowDeMerges(ws['!merges'], arr)
      // Extrato por banco: cada cliente exporta diferente → usa o perfil salvo;
      // se ainda não houver, abre o mapeamento (uma vez por cliente).
      if (modo === 'porBanco' && bancoFixo) {
        if (perfil) return aplicarEProsseguir(arr, file.name, bancoFixo, perfil, catByRow)
        setCfg({ arr, catByRow, nome: file.name, banco: bancoFixo, perfil: perfilPadrao(arr) })
        return
      }
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
      // Trava de competência: se houver data fora do mês, mostra a prévia mas NÃO sobe.
      const erroComp = validarCompetencia(cl, mapa, competencia)
      if (erroComp) { setErro(erroComp); return }
      const casadas = cl.filter(l => l.contra).length
      setMsg(`${cl.length} linha(s) · ${casadas} já classificada(s) pela memória · competência ${competencia} conferida.`)
      if (modo === 'combinado') marcarCombinado(file.name)
      else if (bancoFixo) marcarBanco(bancoFixo, 'validado', file.name)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  function trocarCol(campo, idx) {
    const mapa = { ...map, [campo]: idx }
    setMap(mapa)
    if (!raw) return
    const cl = classificar(raw, mapa, memoria, raw.banco)
    setLinhas(cl)
    // Reconfere a competência ao trocar a coluna de data (ex.: quando não foi auto-detectada).
    const erroComp = validarCompetencia(cl, mapa, competencia)
    setErro(erroComp)
    if (!erroComp && campo === 'data') {
      if (modo === 'combinado') marcarCombinado(raw.nome)
      else if (raw.banco) marcarBanco(raw.banco, 'validado', raw.nome)
      setMsg(`${cl.length} linha(s) · competência ${competencia} conferida.`)
    }
  }
  const setLinha = (i, patch) => setLinhas(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))

  // Filtros da tabela de classificação + preenchimento em lote.
  const dataBR = iso => iso ? iso.split('-').reverse().join('/') : ''
  const normTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  function linhaVisivel(l) {
    if (fSem && l.contra) return false
    if (fHist) {
      const h = normTxt(l.historico), q = normTxt(fHist)
      if (fMode === 'exato' ? h !== q : !h.includes(q)) return false
    }
    if (fData && !dataBR(l.data).includes(fData.trim())) return false
    if (fES && (fES === 'entrada') !== !!l.entrada) return false
    if (fConta && String(l.contra || '').trim() !== String(fConta).trim()) return false
    return true
  }
  const toggleUm = i => setSel(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  // Saldo de abertura do banco (balancete da competência) para conferência do extrato.
  async function carregarSaldoAnterior(banco) {
    const [mes, ano] = (competencia || '').split('/').map(Number)
    const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setSaldoAnterior(null); return }
    const { data: bal } = await supabase.from('balancete').select('saldo_inicial').eq('competencia_id', comp.id).eq('conta', String(banco)).limit(1).maybeSingle()
    setSaldoAnterior(bal ? Number(bal.saldo_inicial) : null)
  }
  useEffect(() => { if (raw?.banco) carregarSaldoAnterior(raw.banco); else { setSaldoAnterior(null); setSaldoExtrato(''); setCruza(null) } }, [raw?.banco, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cruza os lançamentos classificados com o extrato do banco (saldos diários) para
  // achar o dia onde começa a diferença. O sinal é a MUDANÇA da diferença de um dia
  // para o outro (independe do saldo de abertura estar alinhado).
  async function cruzarSaldos(file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      // Acha a linha de cabeçalho (a que tem Data e Saldo) — extratos costumam ter
      // várias linhas de topo (nome, agência, período) antes da tabela.
      let hIdx = 0, iData = -1, iSaldo = -1
      for (let i = 0; i < Math.min(arr.length, 40); i++) {
        const hd = arr[i] || []
        const d = achaColuna(hd, /^data|\bdata\b|dt\b/)
        const s = achaColuna(hd, /saldo|balance/)
        if (d >= 0 && s >= 0) { hIdx = i; iData = d; iSaldo = s; break }
      }
      const rows = arr.slice(hIdx + 1).filter(r => r.some(c => c !== '' && c != null))
      if (iData < 0) iData = achaColuna(arr[hIdx] || [], /^data|\bdata\b|dt\b/)
      if (iSaldo < 0) { // fallback: última coluna com números na maioria das linhas
        for (let j = ((arr[hIdx] || []).length || (rows[0]?.length || 0)) - 1; j >= 0; j--) {
          if (rows.filter(r => typeof r[j] === 'number' || parseValor(r[j])).length > rows.length / 2) { iSaldo = j; break }
        }
      }
      if (iData < 0 || iSaldo < 0) { setErro('Não identifiquei as colunas de Data e Saldo no extrato. Confira se há uma coluna Data e uma Saldo.'); return }
      // extrato: saldo de fim de dia (último por data, assumindo ordem cronológica)
      const extratoDia = new Map()
      for (const r of rows) { const d = dataISO(r[iData]); if (d) extratoDia.set(d, parseValor(r[iSaldo])) }
      // movimento por dia a partir da classificação
      const movDia = {}
      for (const l of linhas) { if (!l.data) continue; movDia[l.data] = (movDia[l.data] || 0) + (l.entrada ? l.valor : -l.valor) }
      const dias = [...new Set([...extratoDia.keys(), ...Object.keys(movDia)])].sort()
      let corrente = saldoAnterior || 0, prevDif = null, primeiroDiv = null
      const out = []
      for (const d of dias) {
        corrente += (movDia[d] || 0)
        const ext = extratoDia.has(d) ? extratoDia.get(d) : null
        const dif = ext == null ? null : Math.round((corrente - ext) * 100) / 100
        const delta = (dif == null || prevDif == null) ? null : Math.round((dif - prevDif) * 100) / 100
        if (delta != null && Math.abs(delta) >= 0.005 && !primeiroDiv) primeiroDiv = d
        out.push({ data: d, mov: movDia[d] || 0, calc: corrente, ext, dif, delta })
        if (dif != null) prevDif = dif
      }
      setCruza({ dias: out, primeiroDiv })
    } catch (e) { setErro('Não consegui ler o extrato: ' + e.message) }
  }
  // Divide um lançamento em vários (ex.: 1 DARF → 3 lançamentos contábeis).
  function confirmarQuebra(i, partes) {
    const base = linhas[i]
    const novas = partes.map(p => ({ ...base, valor: Math.abs(Number(p.valor) || 0), contra: String(p.contra || '').trim() }))
    setLinhas(ls => [...ls.slice(0, i), ...novas, ...ls.slice(i + 1)])
    setSel(new Set()); setQuebra(null)
    setMsg(`Lançamento dividido em ${novas.length}.`)
  }
  function aplicarLote() {
    const cod = String(lote || '').trim()
    if (!cod) { setMsg('Informe a conta para aplicar em lote.'); return }
    if (!sel.size) { setMsg('Selecione as linhas (caixas à esquerda) para aplicar a conta.'); return }
    const n = sel.size
    setLinhas(ls => ls.map((l, j) => sel.has(j) ? { ...l, contra: cod } : l))
    // Volta ao estado original para a próxima aplicação: limpa filtro, seleção e conta.
    setSel(new Set()); setLote(''); setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta('')
    setMsg(`Conta ${cod} aplicada em ${n} linha(s). Pronto para a próxima seleção.`)
  }

  // Aprende: guarda credor/devedor → contrapartida das linhas classificadas
  // (casa pelo nome da empresa; cai no histórico montado se não houver credor).
  async function aprenderSalvar() {
    const novas = linhas.filter(l => l.contra && (l.credor || l.historico)).map(l => ({ historico: l.credor || l.historico, conta: l.contra }))
    if (!novas.length) { setMsg('Classifique ao menos uma linha (contrapartida) antes de salvar.'); return }
    const mem = aprender(memoria, novas)
    await salvarMemoria(mem, { nomeArquivo: memMeta.nomeArquivo, semCarga: false })
    setMsg(`Memória atualizada — ${novas.length} classificação(ões) aprendida(s).`)
  }

  // Semeia/complementa a memória a partir do layout de lançamentos do Domínio
  // (Complemento Histórico + contas de débito/crédito). A contrapartida é o lado
  // que NÃO é o banco. Aceita também uma planilha simples "Histórico | Conta".
  async function importarMemoria(file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const header = arr[0] || []
      const iCompl = achaColuna(header, /complement/)
      const iDeb = achaColuna(header, /conta.*debito/)
      const iCred = achaColuna(header, /conta.*credito/)
      const novas = []
      if (iCompl >= 0 && iDeb >= 0 && iCred >= 0) {
        // Layout do Domínio: descobre o banco (contas cadastradas; se não houver,
        // infere pelo código de conta mais frequente — o banco aparece em quase
        // toda linha) e aprende histórico → contrapartida (o lado não-banco).
        const rows = arr.slice(1).filter(r => r.some(c => c !== '' && c != null))
        let bancos = new Set(contas.map(c => String(c.conta_contabil).trim()))
        if (!bancos.size) {
          const freq = {}
          for (const r of rows) for (const i of [iDeb, iCred]) { const v = String(r[i] ?? '').trim(); if (v) freq[v] = (freq[v] || 0) + 1 }
          const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
          if (top) bancos = new Set([top[0]])
        }
        for (const r of rows) {
          const compl = String(r[iCompl] ?? '').trim()
          const d = String(r[iDeb] ?? '').trim(), c = String(r[iCred] ?? '').trim()
          if (!compl) continue
          const contra = bancos.has(d) ? c : bancos.has(c) ? d : ''
          const ent = extrairEntidade(compl)
          // Não aprende credor→adiantamento: adiantamento é contextual (sem nota),
          // não é regra fixa do credor. Pula pela conta (nome "adiant") e pela
          // categoria da linha (trecho antes do " - " no complemento).
          const catBase = String(compl).split(/\s-\s/)[0]
          if (contra && ent && ehEmpresa(ent) && !adiantContas.has(String(contra)) && !/adiant/i.test(catBase)) novas.push({ historico: ent, conta: contra })
        }
      } else {
        // Planilha simples: Histórico | Conta contrapartida.
        const iH = achaColuna(header, /hist|descri|memo/)
        const iC = achaColuna(header, /conta|contrapart|codigo/)
        const rows = (iH >= 0 && iC >= 0) ? arr.slice(1) : arr
        for (const r of rows) {
          const h = String((iH >= 0 ? r[iH] : r[0]) ?? '').trim()
          const c = String((iC >= 0 ? r[iC] : r[1]) ?? '').trim()
          if (h && c) novas.push({ historico: h, conta: c })
        }
      }
      if (!novas.length) { setErro('Não reconheci o layout. Baixe o modelo e use as mesmas colunas (Complemento Histórico e as contas de débito/crédito).'); return }
      // A memória casa pelo TEXTO do histórico (sem datas/números). Linhas cujo
      // histórico é só número/código não geram termo — descarta e avisa.
      const validas = novas.filter(n => normHist(n.historico))
      if (!validas.length) { setErro(`Li ${novas.length} linha(s), mas o histórico (Complemento) parece ter só números/códigos — não há texto para a memória aprender. Confira o arquivo.`); return }
      if (!window.confirm(`Importar ${validas.length} histórico(s) para a memória do financeiro deste cliente? Confira antes de confirmar.`)) return
      const mem = aprender(memoria, validas)
      if (!mem.length) { setErro('Nada para gravar na memória.'); return }
      await salvarMemoria(mem, { nomeArquivo: file.name, semCarga: false })
      setMsg(`Memória atualizada — ${mem.length} histórico(s) na memória (${validas.length} do arquivo ${file.name}).`)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  // Modelo no layout de lançamentos do Domínio — com as 2 colunas de centro de
  // custo para clientes que usam, e sem elas (igual Aço e Ferro) para os demais.
  async function baixarModeloMemoria() {
    const XLSX = await import('xlsx')
    const base = ['Data', 'Cód. Conta Débito', 'Cód. Conta Crédito', 'Valor', 'Cód. Histórico', 'Complemento Histórico', 'Código Matriz/Filial']
    const head = usaCC ? [...base, 'Centro de Custo Débito', 'Centro de Custo Crédito'] : base
    const ex1 = ['04/05/2026', '204', '14', '3.696,00', '10', 'PGTO. COMPRA DE MERCADORIA - FORNECEDOR EXEMPLO', '6091']
    const ex2 = ['05/05/2026', '763', '14', '48,16', '10', 'PGTO. DESPESAS BANCARIAS', '6091']
    const rows = usaCC ? [head, [...ex1, '', ''], [...ex2, '1', '']] : [head, ex1, ex2]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = head.map((_, i) => ({ wch: i === 5 ? 48 : 16 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos')
    XLSX.writeFile(wb, `modelo_financeiro_${usaCC ? 'com' : 'sem'}_centro_custo.xlsx`)
  }

  // Exporta a classificação atual para Excel (para conferência/validação).
  async function exportarExcel() {
    if (!linhas.length) { setMsg('Nada para exportar.'); return }
    const cols = [
      { nome: 'Data', largura: 12 }, { nome: 'Banco', largura: 34 }, { nome: 'Histórico', largura: 60, wrap: true },
      { nome: 'Valor', largura: 15 }, { nome: 'E/S', largura: 9 }, { nome: 'Contrapartida', largura: 13 }, { nome: 'Conta (nome)', largura: 40 },
    ]
    const rows = linhas.map(l => [
      l.data ? l.data.split('-').reverse().join('/') : '', `${l.banco || ''} ${nomeBanco(l.banco)}`.trim(),
      l.historico || '', Number(l.valor) || 0, l.entrada ? 'Entrada' : 'Saída',
      l.contra || '', planoMap[String(l.contra)]?.nome || (l.contra ? '(fora do plano)' : ''),
    ])
    await gerarExcelTimbrado({
      titulo: `Financeiro classificado · ${competencia}`, sub: `${linhas.length} lançamento(s)`,
      colunas: cols, linhas: rows, totais: null, arquivo: `financeiro_classificado_${competencia.replace('/', '-')}.xlsx`, aba: 'Lançamentos',
    })
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
  const totEnt = linhas.filter(l => l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const totSai = linhas.filter(l => !l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const saldoFinal = (saldoAnterior || 0) + totEnt - totSai
  const temExtrato = String(saldoExtrato).trim() !== ''
  const difSaldo = Math.round((saldoFinal - parseValor(saldoExtrato)) * 100) / 100
  const visiveis = linhas.map((l, i) => ({ l, i })).filter(({ l }) => linhaVisivel(l))
  const visIdx = visiveis.map(v => v.i)
  const todosSel = visIdx.length > 0 && visIdx.every(i => sel.has(i))
  const toggleTodos = () => setSel(prev => { const n = new Set(prev); if (todosSel) visIdx.forEach(i => n.delete(i)); else visIdx.forEach(i => n.add(i)); return n })
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
                    {isAdmin
                      ? <i className="ti ti-trash" title="Excluir banco (admin)" onClick={() => excluirBanco(c)} style={{ color: theme.sub, cursor: 'pointer' }} />
                      : <i className="ti ti-lock" title="Só administradores excluem bancos" style={{ color: theme.border }} />}
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
          <p style={{ fontSize: 11.5, color: theme.sub, margin: '8px 0 0' }}>Use o <b style={{ color: theme.text }}>layout do Domínio</b> ({usaCC ? 'com' : 'sem'} centro de custo — este cliente {usaCC ? 'usa' : 'não usa'}). A memória aprende pelo <b style={{ color: theme.text }}>Complemento Histórico</b> e pela contrapartida (o lado que não é o banco). Baixe o modelo para acertar as colunas.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
              <i className="ti ti-upload" /> {memAtiva ? 'Complementar' : 'Importar carga inicial'}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importarMemoria(e.target.files?.[0])} />
            </label>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={baixarModeloMemoria}><i className="ti ti-download" /> Baixar modelo</button>
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
                const cor = s?.estado === 'validado' ? theme.green : s?.estado === 'sem_movimento' ? theme.sub : s?.estado === 'rascunho' ? theme.yellow : theme.red
                const txt = s?.estado === 'validado' ? `Concluído${s.doc ? ` · ${s.doc}` : ''}` : s?.estado === 'sem_movimento' ? 'Sem movimento no mês' : s?.estado === 'rascunho' ? `Em andamento${s.draft ? ` · ${s.draft.length} lançto(s)` : ''}` : 'Pendente'
                const icon = s?.estado === 'validado' ? 'ti-circle-check' : s?.estado === 'sem_movimento' ? 'ti-circle-minus' : s?.estado === 'rascunho' ? 'ti-progress' : 'ti-alert-triangle'
                return (
                  <div key={c.conta_contabil} style={{ background: theme.card, border: `1px solid ${s?.estado === 'sem_movimento' ? theme.cb : cor}`, borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{c.conta_contabil} · {nomeBanco(c.conta_contabil)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: cor, margin: '0 0 10px', fontWeight: 500 }}><i className={`ti ${icon}`} /> {txt}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {s?.draft && <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => continuarRascunho(c.conta_contabil)}><i className="ti ti-player-play" /> Continuar</button>}
                      <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
                        <i className="ti ti-cloud-upload" /> {(s?.estado === 'validado' || s?.estado === 'rascunho') ? 'Reimportar' : 'Importar extrato'}
                        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importar(e.target.files?.[0], c.conta_contabil)} />
                      </label>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => marcarBanco(c.conta_contabil, 'sem_movimento')}><i className="ti ti-circle-minus" /> Sem movimento</button>
                      {s?.estado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => marcarBanco(c.conta_contabil, null)}>limpar</button>}
                      {isAdmin && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={() => excluirBanco(c)}><i className="ti ti-trash" /> Excluir banco</button>}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', margin: '14px 0 4px' }}>
            <span style={{ fontSize: 12.5, color: theme.text }}><i className="ti ti-file-spreadsheet" style={{ color: theme.accent }} /> {raw.nome || 'Extrato importado'} · {linhas.length} linha(s)</span>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={desfazerImport}><i className="ti ti-arrow-back-up" /> Desfazer / nova importação</button>
          </div>
          {/* Extrato lido pelo perfil do cliente: layout único, sem mapa manual. */}
          {raw.viaPerfil ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '14px 0 6px' }}>
              <span style={{ fontSize: 12, color: theme.sub }}><i className="ti ti-adjustments" style={{ color: theme.accent }} /> Extrato normalizado pelo perfil de leitura deste cliente.</span>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCfg({ arr: raw.arr, catByRow: raw.catByRow, nome: raw.nome, banco: raw.banco, perfil: perfil || perfilPadrao(raw.arr) })}><i className="ti ti-adjustments" /> Ajustar leitura</button>
            </div>
          ) : (
            /* Mapa de colunas (auto-detectado, ajustável) — modo combinado/legado */
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
          )}

          {/* Filtros + preenchimento em lote */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0 8px' }}>
            <button className={fSem ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setFSem(v => !v)}><i className="ti ti-filter" /> Só sem contrapartida</button>
            <input className="input" style={{ maxWidth: 200, fontSize: 12, padding: '6px 10px' }} placeholder="Filtrar histórico…" value={fHist} onChange={e => setFHist(e.target.value)} />
            <select className="input" style={{ maxWidth: 110, fontSize: 12, padding: '6px 8px' }} value={fMode} onChange={e => setFMode(e.target.value)}>
              <option value="contem">Contém</option><option value="exato">Exato</option>
            </select>
            <input className="input" style={{ maxWidth: 130, fontSize: 12, padding: '6px 10px' }} placeholder="Data (dd/mm)" value={fData} onChange={e => setFData(e.target.value)} />
            <select className="input" style={{ maxWidth: 120, fontSize: 12, padding: '6px 8px' }} value={fES} onChange={e => setFES(e.target.value)}>
              <option value="">Entrada/Saída</option><option value="entrada">Só entradas</option><option value="saida">Só saídas</option>
            </select>
            <CampoConta value={fConta} onChange={setFConta} placeholder="Filtrar conta (F4)" style={{ width: 170 }} />
            {(fSem || fHist || fData || fES || fConta) && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => { setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta('') }}>limpar filtros</button>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: theme.sub }}>Aplicar às selecionadas:</span>
            <CampoConta value={lote} onChange={setLote} onEnter={aplicarLote} placeholder="Conta (F4)" style={{ width: 190 }} />
            {lote.trim() && <span style={{ fontSize: 11.5, maxWidth: 220, color: planoMap[String(lote).trim()]?.nome ? theme.green : theme.red }}>{planoMap[String(lote).trim()]?.nome || 'conta não encontrada'}</span>}
            <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} disabled={!sel.size} onClick={aplicarLote}><i className="ti ti-wand" /> Aplicar ({sel.size})</button>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '0 0 6px' }}>
            <span style={{ color: theme.green }}><b>{prontas}</b> pronta(s) p/ contabilizar</span>
            <span style={{ color: theme.yellow }}><b>{semContra}</b> sem contrapartida</span>
            <span style={{ color: theme.sub }}>mostrando <b>{visiveis.length}</b> de {linhas.length}{sel.size ? ` · ${sel.size} selecionada(s)` : ''}</span>
            {sel.size > 0 && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px', color: theme.sub }} onClick={() => setSel(new Set())}>limpar seleção</button>}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, margin: '0 0 10px', padding: '10px 12px', background: theme.input, borderRadius: 8 }}>
            <span style={{ color: theme.sub }}>Saldo anterior {raw.banco ? `(${raw.banco} · ${nomeBanco(raw.banco)})` : ''}: <b style={{ color: theme.text }}>{saldoAnterior == null ? '—' : money(saldoAnterior)}</b></span>
            <span style={{ color: theme.green }}>+ Entradas: <b>{money(totEnt)}</b></span>
            <span style={{ color: theme.red }}>− Saídas: <b>{money(totSai)}</b></span>
            <span style={{ color: theme.text }}>= Saldo final: <b>{money(saldoFinal)}</b></span>
            <span style={{ flex: 1 }} />
            <label style={{ color: theme.sub, display: 'flex', alignItems: 'center', gap: 6 }}>Saldo do extrato:
              <input className="input" style={{ width: 130, fontSize: 12, padding: '5px 8px' }} value={saldoExtrato} onChange={e => setSaldoExtrato(e.target.value)}
                onBlur={() => { if (raw.banco) salvarBancoDraft(raw.banco, bancosEst[raw.banco]?.estado || 'rascunho', raw.nome, linhas) }} placeholder="0,00" />
            </label>
            {temExtrato && (Math.abs(difSaldo) < 0.005
              ? <span style={{ color: theme.green, fontWeight: 600 }}><i className="ti ti-circle-check" /> confere</span>
              : <span style={{ color: theme.red, fontWeight: 600 }}><i className="ti ti-alert-triangle" /> diferença {money(difSaldo)}</span>)}
            <label className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px', cursor: 'pointer' }} title="Importar o extrato do banco (com saldos diários) para achar o dia da diferença">
              <i className="ti ti-file-search" /> Achar diferença por dia
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => cruzarSaldos(e.target.files?.[0])} />
            </label>
          </div>
          {saldoAnterior == null && <p style={{ color: theme.yellow, fontSize: 11.5, margin: '-4px 0 10px' }}>Saldo anterior indisponível (balancete da competência não importado) — o saldo final considera abertura zero.</p>}

          {/* Tabela de classificação */}
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxHeight: 460 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                  <th style={{ ...fth, width: 34, textAlign: 'center' }}><input type="checkbox" checked={todosSel} onChange={toggleTodos} title="Selecionar os visíveis" /></th>
                  <th style={fth}>Data</th><th style={fth}>Banco</th><th style={fth}>Histórico</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>E/S</th><th style={fth}>Contrapartida</th><th style={fth}>Conta (nome)</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map(({ l, i }, pos) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: sel.has(i) ? 'rgba(74,124,255,0.10)' : !l.banco ? 'rgba(245,166,35,0.06)' : 'transparent' }}>
                    <td style={{ ...ftd, textAlign: 'center' }}><input type="checkbox" checked={sel.has(i)} onChange={() => toggleUm(i)} /></td>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{dataBR(l.data) || '—'}</td>
                    <td style={{ ...ftd, fontSize: 11.5 }}>{l.banco ? `${l.banco} · ${nomeBanco(l.banco)}` : <span style={{ color: theme.yellow }}>sem banco</span>}</td>
                    <td style={{ ...ftd, minWidth: 240, maxWidth: 340 }}>
                      <input className="input" style={{ fontSize: 11.5, padding: '4px 7px', width: '100%' }} value={l.historico || ''} onChange={e => setLinha(i, { historico: e.target.value })} title="Editar histórico" />
                    </td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                    <td style={{ ...ftd }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: l.entrada ? theme.green : theme.red, borderColor: l.entrada ? theme.green : theme.red }} onClick={() => setLinha(i, { entrada: !l.entrada })}>{l.entrada ? 'Entrada' : 'Saída'}</button>
                    </td>
                    <td style={{ ...ftd, minWidth: 180 }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}><ContraCell value={l.contra} onCommit={v => setLinha(i, { contra: v })}
                          inputRef={el => { refsContra.current[pos] = el }} onEnter={() => refsContra.current[pos + 1]?.focus()} /></div>
                        <i className="ti ti-arrows-split-2" title="Dividir em vários lançamentos" onClick={() => setQuebra({ i, linha: l })} style={{ color: theme.sub, cursor: 'pointer', fontSize: 16, flexShrink: 0 }} />
                      </div>
                    </td>
                    <td style={{ ...ftd, fontSize: 11.5, maxWidth: 220 }}>
                      {!l.contra ? <span style={{ color: theme.sub }}>—</span>
                        : planoMap[String(l.contra)]?.nome
                          ? <span style={{ color: theme.green }}>{planoMap[String(l.contra)].nome}</span>
                          : <span style={{ color: theme.red }}><i className="ti ti-alert-triangle" /> conta não encontrada no plano</span>}
                    </td>
                  </tr>
                ))}
                {!visiveis.length && <tr><td colSpan={8} style={{ ...ftd, color: theme.sub, fontSize: 12 }}>Nenhuma linha com os filtros atuais.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {raw.banco && <button className="btn btn-ghost" onClick={salvarRascunho}><i className="ti ti-device-floppy" /> Salvar e continuar depois</button>}
            <button className="btn" onClick={aprenderSalvar}><i className="ti ti-brain" /> Aprender e salvar</button>
            {raw.banco && <button className="btn btn-ghost" style={{ color: theme.green, borderColor: theme.green }} onClick={concluirBanco}><i className="ti ti-circle-check" /> Concluir banco</button>}
            <button className="btn btn-ghost" onClick={exportarExcel}><i className="ti ti-file-spreadsheet" /> Exportar Excel</button>
            <button className="btn btn-ghost" disabled={!prontas || (temExtrato && Math.abs(difSaldo) >= 0.005)}
              title={temExtrato && Math.abs(difSaldo) >= 0.005 ? 'O saldo do extrato ainda não confere — zere a diferença antes de gerar.' : ''}
              onClick={gerar}><i className="ti ti-file-export" /> Gerar arquivo do Domínio ({prontas})</button>
          </div>
          <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>Preencha a contrapartida das linhas que faltam e clique em <b style={{ color: theme.text }}>Aprender e salvar</b> — no próximo mês elas já vêm classificadas. Entrada = D banco / C contrapartida; Saída = D contrapartida / C banco.</p>
        </>
      )}

      {quebra && (
        <ModalQuebra linha={quebra.linha} nomeBanco={nomeBanco} planoMap={planoMap}
          onClose={() => setQuebra(null)} onConfirmar={partes => confirmarQuebra(quebra.i, partes)} />
      )}

      {cruza && <ModalCruzaSaldo cruza={cruza} onClose={() => setCruza(null)} />}

      {cfg && (
        <PerfilExtratoCfg
          arr={cfg.arr} catByRow={cfg.catByRow} adiantContas={adiantContas} nome={cfg.nome} bancoNome={nomeBanco(cfg.banco)} perfilInicial={cfg.perfil} memoria={memoria}
          onCancelar={() => setCfg(null)}
          onSalvar={async (perf) => { await salvarPerfil(perf); setCfg(null); aplicarEProsseguir(cfg.arr, cfg.nome, cfg.banco, perf, cfg.catByRow) }}
        />
      )}
    </>
  )
}

// Resultado do cruzamento do saldo diário calculado vs o saldo do extrato do banco.
function ModalCruzaSaldo({ cruza, onClose }) {
  const brd = iso => iso ? iso.split('-').reverse().join('/') : '—'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(680px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-search" style={{ color: theme.accent }} /> Diferença por dia (extrato × classificado)</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ fontSize: 13, margin: '0 0 12px', color: cruza.primeiroDiv ? theme.red : theme.green }}>
          {cruza.primeiroDiv
            ? <><i className="ti ti-alert-triangle" /> A diferença começa em <b>{brd(cruza.primeiroDiv)}</b> — confira os lançamentos desse dia.</>
            : <><i className="ti ti-circle-check" /> Nenhuma divergência de movimento entre os dias. Se ainda há diferença, é no saldo de abertura.</>}
        </p>
        <div style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead><tr style={{ background: theme.input }}><th style={fth}>Data</th><th style={{ ...fth, textAlign: 'right' }}>Movimento</th><th style={{ ...fth, textAlign: 'right' }}>Saldo calc.</th><th style={{ ...fth, textAlign: 'right' }}>Saldo extrato</th><th style={{ ...fth, textAlign: 'right' }}>Dif. do dia</th></tr></thead>
            <tbody>
              {cruza.dias.map((d, i) => {
                const marca = cruza.primeiroDiv === d.data || (d.delta != null && Math.abs(d.delta) >= 0.005)
                return (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: marca ? 'rgba(229,72,77,0.10)' : 'transparent' }}>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap' }}>{brd(d.data)}</td>
                    <td style={{ ...ftd, textAlign: 'right', fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{money(d.mov)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(d.calc)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{d.ext == null ? '—' : money(d.ext)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap', color: (d.delta && Math.abs(d.delta) >= 0.005) ? theme.red : theme.sub }}>{d.delta == null ? '—' : money(d.delta)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11, margin: '10px 0 0' }}>"Dif. do dia" é a mudança da diferença de um dia para o outro — onde ela salta, falta ou sobra um lançamento naquele dia.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={onClose}>Fechar</button></div>
      </div>
    </div>
  )
}

// Campo da contrapartida na tabela: só confirma (grava na linha) ao apertar Enter,
// sair do campo ou escolher pelo F4 — enquanto digita não é interpretado como lançado.
function ContraCell({ value, onCommit, onEnter, inputRef }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  const commit = val => { const s = String(val ?? '').trim(); if (s !== String(value ?? '')) onCommit(s) }
  return (
    <CampoConta value={v} onChange={setV} inputRef={inputRef}
      onPick={p => { setV(p.cod); onCommit(p.cod) }}
      onEnter={() => { commit(v); onEnter && onEnter() }}
      onBlur={() => commit(v)} />
  )
}

// Divide um lançamento em várias partes (ex.: 1 DARF → 3 lançamentos contábeis).
// A soma das partes precisa fechar com o valor original.
function ModalQuebra({ linha, nomeBanco, planoMap, onClose, onConfirmar }) {
  const [partes, setPartes] = useState([{ valor: linha.valor, contra: linha.contra || '' }, { valor: 0, contra: '' }])
  const set = (i, patch) => setPartes(ps => ps.map((p, j) => j === i ? { ...p, ...patch } : p))
  const add = () => setPartes(ps => [...ps, { valor: 0, contra: '' }])
  const rem = i => setPartes(ps => ps.length > 2 ? ps.filter((_, j) => j !== i) : ps)
  const soma = partes.reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const dif = Math.round((linha.valor - soma) * 100) / 100
  const ok = Math.abs(dif) < 0.005 && partes.every(p => Number(p.valor) > 0 && String(p.contra).trim())
  const nomeC = c => planoMap[String(c).trim()]?.nome || ''
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-arrows-split-2" style={{ color: theme.accent }} /> Dividir lançamento</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 2px' }}>{linha.banco} · {nomeBanco(linha.banco)} · {linha.entrada ? 'Entrada' : 'Saída'}</p>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '0 0 10px' }}>{linha.historico}</p>
        <p style={{ fontSize: 13, margin: '0 0 12px' }}>Valor original: <b style={{ color: theme.text }}>{money(linha.valor)}</b></p>
        <div style={{ display: 'grid', gap: 8 }}>
          {partes.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input" type="number" step="0.01" style={{ width: 130, fontSize: 12 }} value={p.valor} onChange={e => set(i, { valor: e.target.value })} placeholder="Valor" />
              <div style={{ flex: 1, minWidth: 170 }}><CampoConta value={p.contra} onChange={v => set(i, { contra: v })} placeholder="Contrapartida (F4)" /></div>
              <span style={{ fontSize: 11, color: nomeC(p.contra) ? theme.green : theme.sub, minWidth: 110, maxWidth: 160 }}>{nomeC(p.contra)}</span>
              {partes.length > 2 && <i className="ti ti-trash" onClick={() => rem(i)} style={{ color: theme.sub, cursor: 'pointer' }} />}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={add}><i className="ti ti-plus" /> Adicionar parte</button>
          <span style={{ fontSize: 12.5, color: Math.abs(dif) < 0.005 ? theme.green : theme.red }}>Soma {money(soma)} · {Math.abs(dif) < 0.005 ? 'confere' : `diferença ${money(dif)}`}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!ok} onClick={() => onConfirmar(partes)}><i className="ti ti-check" /> Dividir</button>
        </div>
      </div>
    </div>
  )
}

// Painel de mapeamento por cliente: define como ler o extrato (linha de início,
// colunas, entrada/saída) e monta o histórico no padrão do Domínio. Prévia ao vivo.
function PerfilExtratoCfg({ arr, catByRow, adiantContas, nome, bancoNome, perfilInicial, memoria, onCancelar, onSalvar }) {
  const [p, setP] = useState(perfilInicial)
  const set = patch => setP(x => ({ ...x, ...patch }))
  const nc = (arr || []).reduce((m, r) => Math.max(m, (r || []).length), 0)
  const ini = Number.isInteger(p.linhaInicio) ? p.linhaInicio : 1
  const amostra = (j) => { for (const r of arr.slice(ini, ini + 60)) { const v = String(r?.[j] ?? '').trim(); if (v) return v } return '' }
  const cols = Array.from({ length: nc }, (_, j) => ({ j, label: `Col ${j + 1} · ${amostra(j).slice(0, 26) || '—'}` }))
  const Sel = ({ val, on, vazio = '—' }) => (
    <select className="input" style={{ padding: '7px 9px', fontSize: 12 }} value={val ?? -1} onChange={e => on(Number(e.target.value))}>
      <option value={-1}>{vazio}</option>
      {cols.map(c => <option key={c.j} value={c.j}>{c.label}</option>)}
    </select>
  )
  const todas = aplicarPerfil(arr, p, memoria, catByRow, adiantContas)
  const prev = todas.slice(0, 6)
  const total = todas.length
  const casadas = todas.filter(l => l.contra).length
  return (
    <div onClick={onCancelar} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(900px,97vw)', maxHeight: '92vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-adjustments" style={{ color: theme.accent }} /> Perfil de leitura — {bancoNome}</h2>
          <span onClick={onCancelar} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 14px' }}>Diga como ler <b style={{ color: theme.text }}>{nome}</b>. Salvo no cliente — nos próximos meses o extrato entra sozinho, no layout do Domínio.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          <div><label>Linha de início (dados)</label><input className="input" type="number" min="1" style={{ fontSize: 12 }} value={ini + 1} onChange={e => set({ linhaInicio: Math.max(0, (Number(e.target.value) || 1) - 1) })} /></div>
          <div><label>Valor</label><Sel val={p.colValor} on={v => set({ colValor: v })} /></div>
          <div><label>Data</label><Sel val={p.colData} on={v => set({ colData: v })} /></div>
          <div><label>Credor/Devedor (contrapartida)</label><Sel val={p.colCredor} on={v => set({ colCredor: v })} /></div>
          <div><label>Documento (opc.)</label><Sel val={p.colDoc} on={v => set({ colDoc: v })} /></div>
          <div><label>Categoria (coluna mesclada, opc.)</label><Sel val={p.colCategoria} on={v => set({ colCategoria: v })} /></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10, marginTop: 12, alignItems: 'end' }}>
          <div>
            <label>Entrada × Saída</label>
            <select className="input" style={{ fontSize: 12 }} value={p.es?.modo || 'sinal'} onChange={e => set({ es: { ...(p.es || {}), modo: e.target.value } })}>
              <option value="sinal">Pelo sinal do valor</option>
              <option value="coluna">Por uma coluna</option>
            </select>
          </div>
          {p.es?.modo === 'coluna' && <div><label>Coluna do indicador</label><Sel val={p.es?.col} on={v => set({ es: { ...(p.es || {}), col: v } })} /></div>}
          {p.es?.modo === 'coluna' && <div><label>Valores que são ENTRADA (vírgula)</label><input className="input" style={{ fontSize: 12 }} placeholder="ex.: CAR, LAN" value={(p.es?.entrada || []).join(', ')} onChange={e => set({ es: { ...(p.es || {}), entrada: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></div>}
          <div>
            <label>Ignorar linha quando esta coluna estiver vazia</label>
            <Sel val={p.filtro?.col} on={v => set({ filtro: { col: v, pularVazio: v >= 0 } })} vazio="não filtrar" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '14px 0 6px' }}>
          <span style={{ color: theme.text }}><b>{total}</b> lançamento(s)</span>
          <span style={{ color: theme.green }}><b>{casadas}</b> classificada(s) pela memória</span>
        </div>
        <div style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead><tr style={{ background: theme.input }}><th style={fth}>E/S</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>Data</th><th style={fth}>Histórico montado</th><th style={fth}>Contrap.</th></tr></thead>
            <tbody>
              {prev.map((l, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...ftd, fontSize: 11, color: l.entrada ? theme.green : theme.red }}>{l.entrada ? 'Entrada' : 'Saída'}</td>
                  <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.sub, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.sub, maxWidth: 320 }}>{l.historico || '—'}</td>
                  <td style={{ ...ftd, fontSize: 11.5 }}>{l.contra || '—'}</td>
                </tr>
              ))}
              {!prev.length && <tr><td colSpan={5} style={{ ...ftd, color: theme.yellow, fontSize: 12 }}>Nenhum lançamento com este mapeamento. Ajuste a linha de início e a coluna de valor.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onCancelar}>Cancelar</button>
          <button className="btn" disabled={!total} onClick={() => onSalvar(p)}><i className="ti ti-check" /> Salvar perfil e importar</button>
        </div>
      </div>
    </div>
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
