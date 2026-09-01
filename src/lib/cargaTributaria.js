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

// Apura o imposto do período nas contas escolhidas (casando pelo código reduzido). Devolve:
//  - bruto:   total de DÉBITO (imposto apurado)
//  - credito: total de CRÉDITO (creditamento de crédito — recupera/estorna imposto)
//  - liquido: bruto − credito (o que REALMENTE onera; é o numerador da carga)
// O creditamento ABATE: por isso é débito − crédito, e NÃO a soma em módulo (que somava o crédito).
export function apurarImpostos(analit, cods) {
  const out = { bruto: 0, credito: 0, liquido: 0 }
  if (!cods || !cods.size) return out
  const r2 = v => Math.round(v * 100) / 100
  for (const l of (analit || [])) {
    if (!cods.has(String(l.reduzido ?? l.conta ?? '').trim())) continue
    out.bruto += num(l.debito)
    out.credito += num(l.credito)
  }
  out.bruto = r2(out.bruto); out.credito = r2(out.credito); out.liquido = r2(out.bruto - out.credito)
  return out
}
// Numerador da carga = imposto LÍQUIDO (débito − crédito).
export function somaImpostos(analit, cods) {
  return apurarImpostos(analit, cods).liquido
}

// Percentual da carga. `base` = 'bruto' | 'liquido' | null/'' (não configurado → null).
export function cargaPct(impostos, faturamento, base) {
  if (!base) return null
  const fat = num(faturamento)
  const den = base === 'liquido' ? fat - num(impostos) : fat
  return Math.abs(den) > 0.005 ? (num(impostos) / den) * 100 : null
}
