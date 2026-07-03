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

// Lê um documento (PDF/imagem) via IA e devolve os campos extraídos.
// Chama a Edge Function `ler-documento` — a chave da IA fica no servidor.
export async function lerDocumento(tipo, file) {
  const arquivo_base64 = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
    r.readAsDataURL(file)
  })
  const { data, error } = await supabase.functions.invoke('ler-documento', {
    body: { tipo, arquivo_base64, mime: file.type || '' },
  })
  if (error) {
    // A Edge Function devolve mensagem amigável no corpo mesmo em erro (501/502…).
    let msg = error.message
    try { const ctx = await error.context?.json(); if (ctx?.error) msg = ctx.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return data?.dados || {}
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
