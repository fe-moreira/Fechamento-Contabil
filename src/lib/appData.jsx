import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

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

  async function carregarEmpresas() {
    const { data } = await supabase
      .from('clientes').select('id, razao_social, codigo_dominio')
      .order('razao_social', { ascending: true })
    setEmpresas(data || [])
  }
  useEffect(() => { carregarEmpresas() }, [])

  const empresaNome = empresas.find(e => e.id === empresaId)?.razao_social || ''

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
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
