import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../components/AuthProvider'
import { apurarDistribuicao } from './distribuicao'
import { apurarBancoResultado } from './bancoResultado'
import { apurarVariacoes } from './variacoes'
import { parsePlano, applyMask } from './balancete'

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
      .from('clientes').select('id, razao_social, codigo_dominio, tipo, codigo_matriz, tipo_fechamento, prazo_entrega, integracao_financeira, sistema_financeiro')
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
    const { data: bal } = await supabase.from('balancete').select('saldo_final').eq('competencia_id', comp.id)
    p += (bal || []).filter(b => Math.abs(Number(b.saldo_final)) > 0.005).length
    // Integrações não validadas (mesma régua do gate no Status).
    p += ['fiscal', 'folha', 'patrimonio', 'financeira'].filter(k => !comp.integracoes?.[k]?.estado).length
    const dist = await apurarDistribuicao(empresaId, comp.id)
    p += (dist.socios || []).filter(s => s.excede).length
    const br = await apurarBancoResultado(empresaId, comp.id)
    p += (br.lancamentos || []).length
    const variacoes = await apurarVariacoes(empresaId)
    p += (variacoes.itens || []).length
    setPendencias(p)
  }
  useEffect(() => { recalcularPendencias() }, [empresaId, competencia])

  const empresaNome = empresas.find(e => e.id === empresaId)?.razao_social || ''

  // --- Timesheet: registra o tempo trabalhado por cliente enquanto a empresa está ativa ---
  const { user } = useAuth()
  const userRef = useRef(user); userRef.current = user
  const track = useRef({ cliente_id: null, nome: '', start: null })

  function flushTempo(finalizar) {
    const tr = track.current
    if (tr.cliente_id && tr.start && document.visibilityState === 'visible') {
      const secs = Math.round((Date.now() - tr.start) / 1000)
      if (secs >= 5) {
        supabase.from('timesheet').insert({ usuario: userRef.current?.email || null, cliente_id: tr.cliente_id, cliente_nome: tr.nome, segundos: secs }).then(() => {})
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

  // Persiste a cada 60s, pausa quando a aba fica oculta, e fecha ao sair.
  useEffect(() => {
    const iv = setInterval(() => flushTempo(false), 60000)
    const onVis = () => {
      if (document.visibilityState === 'hidden') flushTempo(true)
      else if (track.current.cliente_id) track.current.start = Date.now()
    }
    const onUnload = () => flushTempo(true)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(iv)
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

  const value = {
    empresas, empresaId, setEmpresaId,
    competencia, setCompetencia, competencias: COMPETENCIAS,
    empresaNome, getCompetenciaId, carregarEmpresas,
    pendencias, recalcularPendencias, isAdmin,
    fechamentoAtivo, setFechamentoAtivo, abrirFechamento,
    plano, recarregarPlano,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
