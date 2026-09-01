import { supabase } from './supabase'

// RESPONSÁVEL PELO FECHAMENTO, por CLIENTE e por VIGÊNCIA (nunca sobrescreve — cada troca é uma
// vigência nova, preservando o histórico). Guardado em `cargas_cadastro` (tipo 'depara' + obs
// 'responsavel_fechamento'), MESMO padrão da consolidação/carga tributária — não exige tabela nova.
const TIPO = 'depara', OBS = 'responsavel_fechamento'

// 'MM/AAAA' → número comparável (AAAA*100+MM). Aceita 'MM/AAAA' ou 'AAAA-MM'.
export const vigNum = v => {
  const s = String(v || '').trim()
  let m, a
  if (/^\d{4}-\d{1,2}$/.test(s)) { [a, m] = s.split('-').map(Number) }
  else { [m, a] = s.split('/').map(Number) }
  return (a || 0) * 100 + (m || 0)
}
// Normaliza para 'MM/AAAA' (vazio se inválido). Aceita 'MM/AAAA', 'AAAA-MM', 'M/AAAA' e também
// o que o Excel devolve quando trata a vigência como DATA: um objeto Date ou um número de série.
const mesAno = (mes, ano) => (mes >= 1 && mes <= 12 && ano >= 2000 && ano <= 2099) ? `${String(mes).padStart(2, '0')}/${ano}` : ''
export const normVigencia = v => {
  // Excel: célula formatada como data vira Date (cellDates) ou número de série (ex.: 46204).
  if (v instanceof Date && !isNaN(v)) return mesAno(v.getMonth() + 1, v.getFullYear())
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000) // epoch do Excel (bug 1900 incluso)
    if (!isNaN(d)) return mesAno(d.getUTCMonth() + 1, d.getUTCFullYear())
  }
  const s = String(v || '').trim()
  let m, a
  if (/^\d{4}-\d{1,2}$/.test(s)) { [a, m] = s.split('-').map(Number) }
  else if (/^\d{1,2}\/\d{4}$/.test(s)) { [m, a] = s.split('/').map(Number) }
  else return ''
  return mesAno(m, a)
}

// Histórico de responsáveis de um cliente (mais recente primeiro).
export async function carregarResponsavelHist(clienteId) {
  if (!clienteId) return []
  const { data } = await supabase.from('cargas_cadastro').select('id, vigencia, dados, usuario, created_at')
    .eq('cliente_id', clienteId).eq('tipo', TIPO).eq('obs', OBS)
  return (data || [])
    .map(r => ({ id: r.id, vigencia: r.vigencia, responsavel: r.dados?.responsavel || '', usuario: r.usuario, created_at: r.created_at }))
    .sort((x, y) => vigNum(y.vigencia) - vigNum(x.vigencia))
}

// Responsável vigente numa competência ('MM/AAAA'): a vigência mais recente <= competência.
export function responsavelNaCompetencia(hist, competencia) {
  const alvo = vigNum(competencia)
  const validas = (hist || []).filter(h => vigNum(h.vigencia) <= alvo).sort((x, y) => vigNum(y.vigencia) - vigNum(x.vigencia))
  return validas[0]?.responsavel || ''
}

// Grava/atualiza o responsável de UMA vigência (substitui a mesma vigência; vigência nova acrescenta).
export async function salvarResponsavel(clienteId, vigencia, responsavel, usuario) {
  const vig = normVigencia(vigencia)
  if (!clienteId || !vig) return { error: { message: 'cliente ou vigência inválidos' } }
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', TIPO).eq('obs', OBS).eq('vigencia', vig)
  return await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: TIPO, obs: OBS, vigencia: vig, dados: { responsavel: String(responsavel || '').trim() }, usuario: usuario || null })
}

// Remove uma vigência de responsável (pelo id da carga).
export async function excluirResponsavel(id) {
  return await supabase.from('cargas_cadastro').delete().eq('id', id)
}
