import { supabase } from './supabase'

// ============================================================
// CARGA TRIBUTÁRIA CONFIGURÁVEL (por cliente)
// ------------------------------------------------------------
// Antes, a carga era calculada como: SOMA DO SALDO das contas de imposto do
// PASSIVO (por nome, via regex) ÷ receita do período. Isso misturava o SALDO
// ACUMULADO a recolher/provisionado (foto do passivo) com o MOVIMENTO do período
// (receita) e ainda pegava encargos de folha (INSS/FGTS) e contribuições diversas
// — estourando o percentual (ex.: 86,9%).
//
// Agora o contador cadastra, na Base de Informações, QUAIS contas compõem a carga
// (as contas de RESULTADO/DEDUÇÃO — cujo MOVIMENTO do período é a apuração do
// imposto) e a BASE do denominador:
//   - 'bruto'   → faturamento bruto (receita, grupo 3)
//   - 'liquido' → receita líquida = faturamento − impostos selecionados
// O numerador é sempre o MOVIMENTO do período das contas escolhidas (não o saldo).
// ============================================================

const num = v => Number(v) || 0

// Config do cliente ({ contas: [{ cod, nome }], base }) ou null se não configurado.
// Guardada em `cargas_cadastro` (tipo 'depara' + obs 'carga_tributaria') — MESMO padrão da
// consolidação de grupo, para NÃO exigir criar tabela nova (a `carga_tributaria_config` não
// precisa existir). Tolerante a falha: qualquer erro → devolve null (não quebra a tela).
export async function carregarCargaTribCfg(empresaId) {
  if (!empresaId) return null
  const { data, error } = await supabase.from('cargas_cadastro')
    .select('dados').eq('cliente_id', empresaId).eq('tipo', 'depara').eq('obs', 'carga_tributaria')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  const d = data.dados || {}
  return { contas: Array.isArray(d.contas) ? d.contas : [], base: d.base || 'bruto' }
}

// Conjunto de códigos reduzidos das contas escolhidas (para casar com as linhas do balancete).
export function codsCarga(cfg) {
  return new Set((cfg?.contas || []).map(c => String(c?.cod ?? '').trim()).filter(Boolean))
}

// Numerador: soma o MOVIMENTO do período (|saldo_final|) das contas escolhidas, casando
// pelo código reduzido. As linhas analíticas do balancete VIVO trazem `reduzido` e `saldo_final`.
export function somaImpostos(analit, cods) {
  if (!cods || !cods.size) return 0
  return (analit || [])
    .filter(l => cods.has(String(l.reduzido ?? l.conta ?? '').trim()))
    .reduce((s, l) => s + Math.abs(num(l.saldo_final ?? l.saldo)), 0)
}

// Percentual da carga. `base` = 'bruto' | 'liquido' | null/'' (não configurado → null).
export function cargaPct(impostos, faturamento, base) {
  if (!base) return null
  const fat = num(faturamento)
  const den = base === 'liquido' ? fat - num(impostos) : fat
  return Math.abs(den) > 0.005 ? (num(impostos) / den) * 100 : null
}
