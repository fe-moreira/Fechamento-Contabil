// Saldo inicial (carga inicial): excluir para re-subir, com trava por período fechado.
// Regra: só pode mexer no saldo inicial se a COMPETÊNCIA DE ABERTURA do cliente NÃO estiver
// fechada (mexer nele muda a abertura, que arrasta para os meses seguintes). Registra auditoria.
import { supabase } from './supabase'

// Competência de abertura (competencia_inicio 'MM/AAAA') → { id, fechada }.
export async function aberturaComp(clienteId, competenciaInicio) {
  const [mes, ano] = String(competenciaInicio || '').split('/').map(Number)
  if (!mes || !ano) return { id: null, fechada: false }
  const { data } = await supabase.from('competencias').select('id, status')
    .eq('cliente_id', clienteId).eq('ano', ano).eq('mes', mes).maybeSingle()
  return { id: data?.id || null, fechada: data?.status === 'fechado' }
}

// Exclui TODA a carga inicial (saldo inicial) do cliente para re-subir. Bloqueia se a
// abertura estiver fechada. Registra na auditoria. Retorna quantos registros saíram.
export async function excluirSaldoInicialTudo(clienteId, competenciaInicio, usuario) {
  const ab = await aberturaComp(clienteId, competenciaInicio)
  if (ab.fechada) throw new Error('A competência de abertura está FECHADA — reabra-a para mexer no saldo inicial.')
  const { data } = await supabase.from('cargas_cadastro').select('id, obs').eq('cliente_id', clienteId).eq('tipo', 'financeiro')
  const cargas = (data || []).filter(c => String(c.obs || '').startsWith('Carga inicial'))
  for (const c of cargas) await supabase.from('cargas_cadastro').delete().eq('id', c.id)
  await supabase.from('clientes').update({ carga_inicial_feita: false }).eq('id', clienteId)
  if (ab.id) {
    try { await supabase.from('auditoria').insert({ competencia_id: ab.id, modulo: 'Correção', item: 'Saldo inicial', tipo: 'Correção', detalhe: `Saldo inicial (carga inicial) excluído para re-subir — ${cargas.length} registro(s)`, usuario: usuario || null }) } catch { /* auditoria é best-effort */ }
  }
  return cargas.length
}
