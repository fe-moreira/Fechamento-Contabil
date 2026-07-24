import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../components/AuthProvider'
import { apurarDistribuicao } from './distribuicao'
import { apurarBancoResultado } from './bancoResultado'
import { apurarVariacoes } from './variacoes'
import { parsePlano, applyMask, contasConciliacaoAbertas } from './balancete'

// Estado compartilhado: empresa (cliente) e competência selecionadas no topo,
// usados pelos módulos de fechamento. Resolve/cria a linha de `competencias`
// (cliente × mês/ano) sob demanda, que é a chave de razao/balancete/lancamentos.
const Ctx = createContext(null)
export const useAppData = () => useContext(Ctx)

const COMPETENCIAS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}/2026`)


export function AppDataProvider({ children }) {
  const [empresas, setEmpresas] = useState([])
  // Seleção persiste no navegador — ao atualizar a página, o cliente e a
  // competência escolhidos continuam ativos (não precisa reselecionar).
  const [empresaId, setEmpresaId] = useState(() => localStorage.getItem('empresaId') || '')
  const [competencia, setCompetencia] = useState(() => localStorage.getItem('competencia') || '06/2026')
  useEffect(() => { if (empresaId) localStorage.setItem('empresaId', empresaId); else localStorage.removeItem('empresaId') }, [empresaId])
  useEffect(() => { if (competencia) localStorage.setItem('competencia', competencia) }, [competencia])
  const [pendencias, setPendencias] = useState(null)
  // Fechamento ativo: as funções só liberam com um fechamento aberto/criado.
  const [fechamentoAtivo, setFechamentoAtivo] = useState(false)
  // Ao trocar de cliente, fecha a seleção — precisa escolher/abrir um fechamento de novo.
  useEffect(() => { setFechamentoAtivo(false) }, [empresaId])
  function abrirFechamento(mes, ano) {
    setCompetencia(`${String(mes).padStart(2, '0')}/${ano}`)
    setFechamentoAtivo(true)
  }

  // Plano de contas do cliente (para o seletor de conta com F4).
  const [plano, setPlano] = useState([])
  // Recarrega o plano do cliente. Exposto no contexto para que, ao importar um
  // plano novo, a plataforma atualize tudo na hora — sem precisar dar refresh.
  async function recarregarPlano(id = empresaId) {
    if (!id) { setPlano([]); return }
    const { data } = await supabase.from('cargas_cadastro').select('dados').eq('cliente_id', id).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    const mask = parsePlano(data?.dados).find(p => p.mascara)?.mascara || '9.9.9.999.9999'
    setPlano(parsePlano(data?.dados).map(p => ({ cod: p.reduzido, nome: p.nome, classif: applyMask(p.classif, mask), sintetica: p.sintetica })).filter(p => p.cod))
  }
  useEffect(() => { recarregarPlano() }, [empresaId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function carregarEmpresas() {
    const { data } = await supabase
      .from('clientes').select('id, razao_social, codigo_dominio, cnpj, tipo, codigo_matriz, tipo_fechamento, prazo_entrega, integracao_financeira, sistema_financeiro, usa_centro_custo, competencia_inicio')
      .order('razao_social', { ascending: true })
    setEmpresas(data || [])
  }
  useEffect(() => { carregarEmpresas() }, [])

  // Conta as pendências do fechamento (mesma régua da tela Status) para o badge do menu.
  async function recalcularPendencias() {
    if (!empresaId) { setPendencias(null); return }
    let p = 0
    // Carga inicial: se a empresa tem saldo inicial e ainda não lançou, é pendência.
    const { data: cli } = await supabase.from('clientes').select('carga_saldos, carga_inicial_feita').eq('id', empresaId).maybeSingle()
    if (cli?.carga_saldos && !cli?.carga_inicial_feita) p += 1
    const [mes, ano] = competencia.split('/').map(Number)
    const { data: comp } = await supabase.from('competencias')
      .select('id, documentos, integracoes').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setPendencias(p + 1); return } // razão ainda não importado
    const { count } = await supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
    if (!count) p += 1
    // Só documento indeciso (pendente) conta; "não tem"/"não enviou" não bloqueiam.
    p += (Array.isArray(comp.documentos) ? comp.documentos : []).filter(d => (d?.situacao ?? (d?.rec ? 'recebido' : '')) === '').length
    // Conciliação: mesma régua da tela Status (fonte única) — só Ativo/Passivo ainda em aberto.
    p += (await contasConciliacaoAbertas(empresaId, comp.id)).length
    // Integrações não validadas (mesma régua do gate no Status).
    p += ['fiscal', 'folha', 'patrimonio', 'financeira'].filter(k => !comp.integracoes?.[k]?.estado).length
    const dist = await apurarDistribuicao(empresaId, comp.id)
    p += (dist.socios || []).filter(s => s.excede).length
    const br = await apurarBancoResultado(empresaId, comp.id)
    p += (br.lancamentos || []).filter(l => !l.tratado).length // justificados/corrigidos saem da contagem
    const variacoes = await apurarVariacoes(empresaId)
    // Conta por CONTA (não por mês/lançamento) — bate com a lista do Status.
    p += new Set((variacoes.itens || []).map(i => String(i.conta))).size
    setPendencias(p)
  }
  useEffect(() => { recalcularPendencias() }, [empresaId, competencia])

  // Competência ENCERRADA (fechada) = somente leitura em toda a plataforma. Reabrir no
  // Status é o único caminho para voltar a editar.
  const [competenciaFechada, setCompetenciaFechada] = useState(false)
  async function refreshStatusCompetencia() {
    if (!empresaId) { setCompetenciaFechada(false); return }
    const [mes, ano] = competencia.split('/').map(Number)
    const { data } = await supabase.from('competencias').select('status')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    setCompetenciaFechada(data?.status === 'fechado')
  }
  useEffect(() => { refreshStatusCompetencia() }, [empresaId, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  const empresaNome = empresas.find(e => e.id === empresaId)?.razao_social || ''

  // --- Timesheet: registra o tempo trabalhado por cliente enquanto a empresa está ativa ---
  const { user } = useAuth()
  const userRef = useRef(user); userRef.current = user
  // Lista de empresas sempre atual (para resolver o NOME do cliente na hora de gravar o
  // timesheet — antes, se as empresas ainda não tinham carregado quando o cliente foi
  // selecionado, o nome ia vazio e o relatório não mostrava o cliente).
  const empresasRef = useRef(empresas); empresasRef.current = empresas
  const track = useRef({ cliente_id: null, nome: '', start: null })
  // Timesheet pausa após 10 min sem interação do usuário com o cliente.
  const lastAtiv = useRef(Date.now())
  const OCIOSO_TS_MS = 10 * 60 * 1000

  function flushTempo(finalizar) {
    const tr = track.current
    if (tr.cliente_id && tr.start && document.visibilityState === 'visible') {
      const secs = Math.round((Date.now() - tr.start) / 1000)
      if (secs >= 5) {
        const nome = empresasRef.current.find(e => e.id === tr.cliente_id)?.razao_social || tr.nome || ''
        supabase.from('timesheet').insert({ usuario: userRef.current?.email || null, cliente_id: tr.cliente_id, cliente_nome: nome, segundos: secs }).then(() => {})
      }
    }
    tr.start = finalizar ? null : Date.now()
  }

  // Troca de empresa: fecha o tempo da anterior e inicia o da nova.
  useEffect(() => {
    flushTempo(true)
    const emp = empresas.find(e => e.id === empresaId)
    track.current = { cliente_id: empresaId || null, nome: emp?.razao_social || '', start: empresaId ? Date.now() : null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId])

  // Persiste a cada 60s. Pausa quando a aba fica oculta OU após 10 min sem
  // interação. Retoma na próxima interação (se houver cliente e a aba visível).
  useEffect(() => {
    const iv = setInterval(() => {
      const ocioso = Date.now() - lastAtiv.current >= OCIOSO_TS_MS
      if (ocioso) {
        // Fecha o tempo acumulado e não conta mais até voltar a interagir.
        if (track.current.start) flushTempo(true)
      } else {
        flushTempo(false)
      }
    }, 60000)
    const onAtiv = () => {
      lastAtiv.current = Date.now()
      // Retoma a contagem se estava pausado por inatividade.
      if (track.current.cliente_id && !track.current.start && document.visibilityState === 'visible') {
        track.current.start = Date.now()
      }
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flushTempo(true)
      else if (track.current.cliente_id) { lastAtiv.current = Date.now(); track.current.start = Date.now() }
    }
    const onUnload = () => flushTempo(true)
    const eventos = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    eventos.forEach(ev => window.addEventListener(ev, onAtiv, { passive: true }))
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(iv)
      eventos.forEach(ev => window.removeEventListener(ev, onAtiv))
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onUnload)
      flushTempo(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Retorna o id da competência (cliente × mês/ano), criando-a se ainda não existir.
  async function getCompetenciaId() {
    if (!empresaId) return null
    const [mes, ano] = competencia.split('/').map(Number)
    const { data: existente } = await supabase
      .from('competencias').select('id')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (existente) return existente.id
    const { data: criada, error } = await supabase
      .from('competencias').insert({ cliente_id: empresaId, ano, mes }).select('id').single()
    if (error) throw error
    return criada.id
  }

  // Perfil único por enquanto: todo usuário logado é ADM.
  const isAdmin = !!user

  // ===================================================================================
  // CACHE DE RELATÓRIOS (Cockpit, Book, …): guarda o resultado já processado por
  // (tela · cliente · competência) e só reprocessa se os dados MUDARAM. Vive aqui no
  // provider (acima das telas), então sobrevive à troca de tela — sai e volta, aparece
  // a última versão na hora, sem remontar. O "carimbo" (versaoRelatorio) é barato:
  // contagem + data da última alteração das tabelas que alimentam os relatórios.
  // ===================================================================================
  const relCacheRef = useRef(new Map())
  // Carimbo dos dados do fechamento: se ele não muda, nada que alimenta os relatórios
  // mudou (lançamentos, razão, auditoria/justificativas, conciliação, ajuste de leitura,
  // cadastros/apelidos, comentários e a própria competência).
  async function versaoRelatorio(id, compId) {
    if (!id || !compId) return 'sem'
    const ult = (tbl, col, filtroCol, val) => supabase.from(tbl).select(col, { count: 'exact' }).eq(filtroCol, val).order(col, { ascending: false }).limit(1)
    const [lanc, razao, bal, aud, conc, aju, carg, com, compRow] = await Promise.all([
      ult('lancamentos', 'created_at', 'competencia_id', compId),
      // razão: count + data da última importação (reimport carimba created_at=now(), então
      // detecta mesmo quando o número de linhas não muda).
      ult('razao', 'created_at', 'competencia_id', compId),
      // balancete (saldos) não tem timestamp — conta as linhas para pegar mudança de contas.
      supabase.from('balancete').select('id', { count: 'exact', head: true }).eq('competencia_id', compId),
      ult('auditoria', 'created_at', 'competencia_id', compId),
      ult('conciliacao_conta', 'updated_at', 'competencia_id', compId),
      ult('ajuste_leitura', 'updated_at', 'competencia_id', compId),
      supabase.from('cargas_cadastro').select('created_at').eq('cliente_id', id).order('created_at', { ascending: false }).limit(1),
      ult('conta_comentario', 'created_at', 'cliente_id', id),
      supabase.from('competencias').select('updated_at').eq('id', compId).maybeSingle(),
    ])
    const c = (r, col) => `${r?.count ?? ''}:${r?.data?.[0]?.[col] || ''}`
    return [
      c(lanc, 'created_at'), c(razao, 'created_at'), bal?.count ?? '', c(aud, 'created_at'),
      c(conc, 'updated_at'), c(aju, 'updated_at'),
      carg?.data?.[0]?.created_at || '', c(com, 'created_at'),
      compRow?.data?.updated_at || '',
    ].join('|')
  }
  // Carimbo do ANO inteiro (para o Comparativo, que lê os 12 meses de uma vez): cobre
  // lançamentos, razão e balancete de TODAS as competências do ano + os cadastros do cliente.
  async function versaoRelatorioAno(id, ano) {
    if (!id || !ano) return 'sem'
    const { data: comps } = await supabase.from('competencias').select('id, updated_at').eq('cliente_id', id).eq('ano', ano)
    const ids = (comps || []).map(c => c.id)
    if (!ids.length) return `vazio:${ano}`
    const maxComp = (comps || []).reduce((m, c) => (c.updated_at > m ? c.updated_at : m), '')
    const inUlt = (tbl, col) => supabase.from(tbl).select(col, { count: 'exact' }).in('competencia_id', ids).order(col, { ascending: false }).limit(1)
    const [lanc, razao, bal, carg] = await Promise.all([
      inUlt('lancamentos', 'created_at'),
      inUlt('razao', 'created_at'),
      supabase.from('balancete').select('id', { count: 'exact', head: true }).in('competencia_id', ids),
      supabase.from('cargas_cadastro').select('created_at').eq('cliente_id', id).order('created_at', { ascending: false }).limit(1),
    ])
    const c = (r, col) => `${r?.count ?? ''}:${r?.data?.[0]?.[col] || ''}`
    return [ids.length, maxComp, c(lanc, 'created_at'), c(razao, 'created_at'), bal?.count ?? '', carg?.data?.[0]?.created_at || ''].join('|')
  }
  const lerRelCache = chave => relCacheRef.current.get(chave)
  const gravarRelCache = (chave, versao, dados) => relCacheRef.current.set(chave, { versao, dados })
  const limparRelCache = () => relCacheRef.current.clear()

  // ===================================================================================
  // DOWNLOADS EM SEGUNDO PLANO (ex.: o .zip do Book): a geração roda aqui no provider,
  // então CONTINUA mesmo se você trocar de tela. Ao terminar, o navegador baixa o
  // arquivo e o item fica na bandeja do sino (topo) marcado como "não visto" até você abrir.
  // ===================================================================================
  const [downloads, setDownloads] = useState([]) // { id, nome, estado:'gerando'|'pronto'|'erro', url, nomeArquivo, visto, erro }
  const downloadSeq = useRef(0)
  function baixarBlobUrl(url, nomeArquivo) {
    const a = document.createElement('a')
    a.href = url; a.download = nomeArquivo || 'download'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }
  // Roda uma geração (gerar → { blob, nomeArquivo }) em segundo plano. Devolve o id.
  async function iniciarDownload(nome, gerar) {
    const id = `dl-${++downloadSeq.current}`
    setDownloads(ds => [{ id, nome, estado: 'gerando', visto: false }, ...ds])
    try {
      const { blob, nomeArquivo } = await gerar()
      const url = URL.createObjectURL(blob)
      setDownloads(ds => ds.map(d => d.id === id ? { ...d, estado: 'pronto', url, nomeArquivo, visto: false } : d))
      baixarBlobUrl(url, nomeArquivo) // baixa na hora; fica na bandeja para rebaixar
    } catch (e) {
      setDownloads(ds => ds.map(d => d.id === id ? { ...d, estado: 'erro', erro: String(e?.message || e), visto: false } : d))
    }
    return id
  }
  function rebaixarDownload(idOuItem) {
    const d = typeof idOuItem === 'string' ? downloads.find(x => x.id === idOuItem) : idOuItem
    if (d?.url) baixarBlobUrl(d.url, d.nomeArquivo)
  }
  function marcarDownloadsVistos() { setDownloads(ds => ds.some(d => !d.visto) ? ds.map(d => ({ ...d, visto: true })) : ds) }
  function removerDownload(id) {
    setDownloads(ds => { const d = ds.find(x => x.id === id); if (d?.url) URL.revokeObjectURL(d.url); return ds.filter(x => x.id !== id) })
  }
  const downloadsNaoVistos = downloads.filter(d => !d.visto && d.estado !== 'gerando').length
  const downloadsGerando = downloads.filter(d => d.estado === 'gerando').length

  const value = {
    empresas, empresaId, setEmpresaId,
    competencia, setCompetencia, competencias: COMPETENCIAS,
    empresaNome, getCompetenciaId, carregarEmpresas,
    pendencias, recalcularPendencias, isAdmin,
    fechamentoAtivo, setFechamentoAtivo, abrirFechamento,
    plano, recarregarPlano,
    competenciaFechada, refreshStatusCompetencia,
    // cache de relatórios
    versaoRelatorio, versaoRelatorioAno, lerRelCache, gravarRelCache, limparRelCache,
    // downloads em segundo plano
    downloads, iniciarDownload, rebaixarDownload, marcarDownloadsVistos, removerDownload,
    downloadsNaoVistos, downloadsGerando,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// Hook de relatório COM CACHE: resolve a competência, confere o "carimbo" dos dados e só
// chama `computar(compId, {mes,ano})` se algo mudou desde a última vez — senão devolve a
// versão pronta na hora. Como o cache vive no provider, sair e voltar da tela é instantâneo.
// Retorna { carregando, dados, semComp, erro }. `extraDep` (ex.: o plano) força recomputar
// quando muda, mesmo sem tocar no banco.
export function useRelatorio({ tela, empresaId, competencia, computar, ativo = true, extraDep }) {
  const { versaoRelatorio, lerRelCache, gravarRelCache } = useAppData()
  const [estado, setEstado] = useState({ carregando: true, dados: null, semComp: false, erro: null })
  const computarRef = useRef(computar); computarRef.current = computar
  useEffect(() => {
    if (!ativo) return
    if (!empresaId) { setEstado({ carregando: false, dados: null, semComp: false, erro: null }); return }
    let vivo = true
    setEstado(s => ({ ...s, carregando: true, erro: null }))
    ;(async () => {
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setEstado({ carregando: false, dados: null, semComp: true, erro: null }); return }
        const chave = `${tela}|${empresaId}|${competencia}`
        const versao = await versaoRelatorio(empresaId, comp.id)
        if (!vivo) return
        const cache = lerRelCache(chave)
        if (cache && cache.versao === versao) { setEstado({ carregando: false, dados: cache.dados, semComp: false, erro: null }); return }
        const dados = await computarRef.current(comp.id, { mes, ano })
        if (!vivo) return
        gravarRelCache(chave, versao, dados)
        setEstado({ carregando: false, dados, semComp: false, erro: null })
      } catch (e) {
        if (vivo) setEstado({ carregando: false, dados: null, semComp: false, erro: String(e?.message || e) })
      }
    })()
    return () => { vivo = false }
  }, [tela, empresaId, competencia, ativo, extraDep]) // eslint-disable-line react-hooks/exhaustive-deps
  return estado
}
