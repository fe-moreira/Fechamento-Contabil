import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../components/AuthProvider'

// Estado compartilhado: empresa (cliente) e competência selecionadas no topo,
// usados pelos módulos de fechamento. Resolve/cria a linha de `competencias`
// (cliente × mês/ano) sob demanda, que é a chave de razao/balancete/lancamentos.
const Ctx = createContext(null)
export const useAppData = () => useContext(Ctx)

const COMPETENCIAS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}/2026`)

export function AppDataProvider({ children }) {
  const [empresas, setEmpresas] = useState([])
  const [empresaId, setEmpresaId] = useState('')
  const [competencia, setCompetencia] = useState('06/2026')
  const [pendencias, setPendencias] = useState(null)

  async function carregarEmpresas() {
    const { data } = await supabase
      .from('clientes').select('id, razao_social, codigo_dominio')
      .order('razao_social', { ascending: true })
    setEmpresas(data || [])
  }
  useEffect(() => { carregarEmpresas() }, [])

  // Conta as pendências do fechamento (mesma régua da tela Status) para o badge do menu.
  async function recalcularPendencias() {
    if (!empresaId) { setPendencias(null); return }
    const [mes, ano] = competencia.split('/').map(Number)
    const { data: comp } = await supabase.from('competencias')
      .select('id, documentos').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setPendencias(1); return } // razão ainda não importado
    let p = 0
    const { count } = await supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
    if (!count) p += 1
    p += (Array.isArray(comp.documentos) ? comp.documentos : []).filter(d => !d.rec).length
    const { data: bal } = await supabase.from('balancete').select('saldo_final').eq('competencia_id', comp.id)
    p += (bal || []).filter(b => Math.abs(Number(b.saldo_final)) > 0.01).length
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

  const value = {
    empresas, empresaId, setEmpresaId,
    competencia, setCompetencia, competencias: COMPETENCIAS,
    empresaNome, getCompetenciaId, carregarEmpresas,
    pendencias, recalcularPendencias,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
