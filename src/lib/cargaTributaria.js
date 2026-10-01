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

// Códigos das contas marcadas como CREDITAMENTO (papel === 'credito'). As demais são 'apurado'
// (padrão — compatível com configs antigas que não têm o campo papel).
export function codsCargaCredito(cfg) {
  return new Set((cfg?.contas || []).filter(c => c?.papel === 'credito').map(c => String(c?.cod ?? '').trim()).filter(Boolean))
}

// Apura o imposto do período nas contas escolhidas (casando pelo código reduzido). Devolve:
//  - bruto:   imposto APURADO — soma do MOVIMENTO LÍQUIDO (débito − crédito) das contas de APURAÇÃO
//  - credito: CREDITAMENTO — soma do movimento (em módulo) das contas marcadas como CREDITAMENTO
//  - liquido: bruto − credito (o que REALMENTE onera; é o numerador da carga)
//
// O usuário marca, na configuração, QUAIS contas vão para a linha "Apurado (bruto)" e quais vão
// para "(−) Creditamento" (creditoCods). Sem marcação, toda conta é de apuração.
//
// Por que NET (débito − crédito) por conta na apuração, e não o débito bruto: contas de IRPJ/CSLL
// apuradas de forma ACUMULADA (lucro real/presumido anual) debitam todo mês o NOVO acumulado e
// CREDITAM (estornam) o acumulado do mês anterior. Esse crédito NÃO é creditamento — é estorno da
// própria provisão. Fazendo o líquido por conta, o estorno se cancela dentro da própria conta e o
// "Apurado" mostra só o imposto real do período (ex.: APPROVATA → R$ 37 mil só no Apurado, sem o
// R$ 95 mil de "creditamento" que era estorno acumulado).
export function apurarImpostos(analit, cods, creditoCods) {
  const out = { bruto: 0, credito: 0, liquido: 0 }
  if (!cods || !cods.size) return out
  const credSet = creditoCods || new Set()
  const r2 = v => Math.round(v * 100) / 100
  for (const l of (analit || [])) {
    const cod = String(l.reduzido ?? l.conta ?? '').trim()
    if (!cods.has(cod)) continue
    const net = num(l.debito) - num(l.credito) // movimento líquido DA CONTA no período
    if (credSet.has(cod)) out.credito += Math.abs(net) // conta marcada como creditamento
    else out.bruto += net                               // conta de apuração (estorno acumulado se cancela)
  }
  out.bruto = r2(out.bruto); out.credito = r2(out.credito); out.liquido = r2(out.bruto - out.credito)
  return out
}
// Numerador da carga = imposto LÍQUIDO (apurado − creditamento).
export function somaImpostos(analit, cods, creditoCods) {
  return apurarImpostos(analit, cods, creditoCods).liquido
}

// Percentual da carga. `base` = 'bruto' | 'liquido' | null/'' (não configurado → null).
export function cargaPct(impostos, faturamento, base) {
  if (!base) return null
  const fat = num(faturamento)
  const den = base === 'liquido' ? fat - num(impostos) : fat
  return Math.abs(den) > 0.005 ? (num(impostos) / den) * 100 : null
}
