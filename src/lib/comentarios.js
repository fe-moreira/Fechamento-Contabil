import { supabase } from './supabase'

// Comentários/observações POR CONTA (cliente + conta), independentes da competência —
// formam um histórico (diário) que acompanha a conta em todos os meses. Cada comentário
// é uma linha, com usuário e data. Usado na Conciliação (escreve) e no Book (exibe).

// Histórico de uma conta, mais recente primeiro.
export async function listarComentariosConta(clienteId, conta) {
  if (!clienteId || !conta) return []
  const { data } = await supabase.from('conta_comentario')
    .select('id, texto, usuario, created_at')
    .eq('cliente_id', clienteId).eq('conta', String(conta))
    .order('created_at', { ascending: false })
  return data || []
}

// Todos os comentários do cliente agrupados por conta (para o Book carregar de uma vez).
export async function comentariosPorConta(clienteId) {
  if (!clienteId) return {}
  const { data } = await supabase.from('conta_comentario')
    .select('conta, texto, usuario, created_at')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
  const map = {}
  for (const r of (data || [])) (map[String(r.conta)] ||= []).push(r)
  return map
}

// Adiciona um comentário ao histórico da conta.
export async function adicionarComentario(clienteId, conta, texto, usuario) {
  const t = String(texto || '').trim()
  if (!clienteId || !conta || !t) return { error: 'vazio' }
  const { data, error } = await supabase.from('conta_comentario')
    .insert({ cliente_id: clienteId, conta: String(conta), texto: t, usuario: usuario || null })
    .select('id, texto, usuario, created_at').single()
  return { data, error }
}

export async function excluirComentario(id) {
  if (!id) return
  await supabase.from('conta_comentario').delete().eq('id', id)
}
