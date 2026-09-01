import { supabase } from './supabase'
import { normVigencia, vigNum } from './responsavel'

// INATIVAÇÃO DO CLIENTE a partir de uma COMPETÊNCIA de corte. Daquele mês em diante ninguém abre
// fechamento novo — o cliente fica só como consulta (o passado continua acessível). Guardado em
// `cargas_cadastro` (tipo 'depara' + obs 'inativacao'), MESMO padrão da consolidação/responsável —
// não exige tabela nova. Também espelha a flag `ativo` da tabela clientes (que já existe).
const TIPO = 'depara', OBS = 'inativacao'

// Mapa cliente_id -> { id, desde, usuario, created_at } de todas as inativações (para listas/painel).
export async function carregarInativacoes() {
  const { data } = await supabase.from('cargas_cadastro').select('id, cliente_id, vigencia, dados, usuario, created_at')
    .eq('tipo', TIPO).eq('obs', OBS)
  const map = {}
  for (const r of (data || [])) map[r.cliente_id] = { id: r.id, desde: r.dados?.desde || r.vigencia || '', usuario: r.usuario, created_at: r.created_at }
  return map
}

// Inativação de UM cliente (ou null se ativo).
export async function inativacaoDoCliente(clienteId) {
  if (!clienteId) return null
  const { data } = await supabase.from('cargas_cadastro').select('id, vigencia, dados, usuario, created_at')
    .eq('cliente_id', clienteId).eq('tipo', TIPO).eq('obs', OBS).maybeSingle()
  if (!data) return null
  return { id: data.id, desde: data.dados?.desde || data.vigencia || '', usuario: data.usuario, created_at: data.created_at }
}

// O cliente está inativo NAQUELA competência? (competência >= desde). rec = { desde } | null.
export function inativoNaCompetencia(rec, ano, mes) {
  if (!rec?.desde) return false
  const alvo = (Number(ano) || 0) * 100 + (Number(mes) || 0)
  return alvo >= vigNum(rec.desde)
}

// Desativa o cliente a partir de uma competência (MM/AAAA) e marca ativo=false.
export async function desativarCliente(clienteId, desde, usuario) {
  const vig = normVigencia(desde)
  if (!clienteId || !vig) return { error: { message: 'cliente ou competência inválidos' } }
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', TIPO).eq('obs', OBS)
  const r = await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: TIPO, obs: OBS, vigencia: vig, dados: { desde: vig }, usuario: usuario || null })
  if (r.error) return r
  await supabase.from('clientes').update({ ativo: false }).eq('id', clienteId)
  return r
}

// Reativa o cliente: remove a inativação e marca ativo=true.
export async function reativarCliente(clienteId) {
  if (!clienteId) return { error: { message: 'cliente inválido' } }
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', TIPO).eq('obs', OBS)
  return await supabase.from('clientes').update({ ativo: true }).eq('id', clienteId)
}
