import { supabase } from './supabase'

// CRUD genérico das tabelas de Outras Contabilizações (todas por cliente_id).
export async function listar(tabela, clienteId) {
  const { data, error } = await supabase.from(tabela).select('*')
    .eq('cliente_id', clienteId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function inserir(tabela, row) {
  const { data, error } = await supabase.from(tabela).insert(row).select().single()
  if (error) throw error
  return data
}

export async function remover(tabela, id) {
  const { error } = await supabase.from(tabela).delete().eq('id', id)
  if (error) throw error
}

// Gera um lançamento real na fila que alimenta o Status / arquivo do Domínio.
export async function gerarLancamento(l) {
  const { error } = await supabase.from('lancamentos').insert({
    competencia_id: l.competencia_id,
    data: l.data || null,
    conta_debito: l.conta_debito || null,
    conta_credito: l.conta_credito || null,
    valor: Number(l.valor) || 0,
    historico: l.historico || null,
    origem: l.origem || 'outras',
    documento: l.documento || null,
    usuario: l.usuario || null,
  })
  if (error) throw error
}
