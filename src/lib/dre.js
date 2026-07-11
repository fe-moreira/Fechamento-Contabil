// Monta a DRE estruturada (modelo do sistema, igual ao Domínio) a partir das linhas do
// balancete hierárquico (montarBalancete). Usa a classificação do plano padrão:
//   31  Receitas líquidas          (311 Receita bruta · 312 Deduções)
//   43  CSV (custo dos serviços)    (439 = depreciação do custo, sai do CSV → EBITDA)
//   51  Despesas com vendas
//   52  Despesas administrativas    (529 = depreciação adm, sai das despesas → EBITDA)
//   53  Outras receitas/despesas op.
//   54  Equivalência patrimonial
//   55  Resultado financeiro
//   58  IR e CSLL
//   59  Operações descontinuadas
// Valor da DRE = −Σ saldo_final (receita credora vira +, custo/despesa devedora vira −).
// Subtotais (Receita Líquida, Lucro Bruto, EBITDA, LAIR, Lucro Líquido) são somas correntes.
export function montarDRE(linhas) {
  const analit = (linhas || []).filter(l => !l.sintetica)
  const raw = l => String(l.classifRaw || l.classif || '')
  const soma = (pref, exclui = []) => -analit
    .filter(l => { const c = raw(l); return c.startsWith(pref) && !exclui.some(e => c.startsWith(e)) })
    .reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)

  const receitaBruta = soma('31', ['312'])
  const deducoes = soma('312')
  const receitaLiquida = receitaBruta + deducoes
  const csv = soma('43', ['439'])
  const lucroBruto = receitaLiquida + csv
  const despVendas = soma('51')
  const despAdmin = soma('52', ['529'])
  const outras = soma('53')
  const equiv = soma('54')
  const ebitda = lucroBruto + despVendas + despAdmin + outras + equiv
  const deprec = soma('439') + soma('529')
  const financeiro = soma('55')
  const lair = ebitda + deprec + financeiro
  const ir = soma('58')
  const descont = soma('59')
  const lucroLiquido = lair + ir + descont

  const rows = []
  const grp = (label, valor) => rows.push({ label, valor, sub: false })
  const sub = (label, valor) => rows.push({ label, valor, sub: true })
  const grpSe = (label, valor) => { if (Math.abs(valor) > 0.005) grp(label, valor) }

  grp('RECEITA BRUTA', receitaBruta)
  grp('IMPOSTOS E DEDUÇÕES', deducoes)
  sub('RECEITA LÍQUIDA', receitaLiquida)
  grp('CUSTO DOS SERVIÇOS VENDIDOS - CSV', csv)
  sub('LUCRO BRUTO', lucroBruto)
  grpSe('DESPESAS COM VENDAS', despVendas)
  grp('DESPESAS ADMINISTRATIVAS', despAdmin)
  grpSe('OUTRAS RECEITAS E DESPESAS OPERACIONAIS', outras)
  grpSe('RESULTADO DA EQUIVALÊNCIA PATRIMONIAL', equiv)
  sub('RESULTADO OPERACIONAL (EBITDA)', ebitda)
  grp('DEPRECIAÇÃO E AMORTIZAÇÃO', deprec)
  grp('RESULTADO FINANCEIRO', financeiro)
  sub('LUCRO ANTES DOS IMPOSTOS', lair)
  grpSe('IMPOSTO DE RENDA E CSLL', ir)
  grpSe('RESULTADO DAS OPERAÇÕES DESCONTINUADAS', descont)
  sub('LUCRO LÍQUIDO DO EXERCÍCIO', lucroLiquido)
  return rows
}
