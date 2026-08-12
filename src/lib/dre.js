// Monta a DRE estruturada (modelo do sistema, igual ao Domínio) a partir das linhas do
// balancete hierárquico (montarBalancete).
//
// Duas estratégias, escolhidas automaticamente:
//   1) DETALHADA (plano no padrão Domínio) — usa a classificação:
//        31  Receitas líquidas   (311 Receita bruta · 312 Deduções)
//        43  CSV (custo)          (439 = depreciação do custo → sai do CSV p/ EBITDA)
//        51  Despesas com vendas
//        52  Despesas administrativas  (529 = depreciação adm → sai p/ EBITDA)
//        53  Outras receitas/despesas op. · 54 Equivalência · 55 Financeiro · 58 IR · 59 Descont.
//   2) SIMPLES (plano por grupo: 3=receita, 4=custo, 5=despesa) — quando a estrutura
//      detalhada NÃO reconcilia com o resultado real dos grupos 3/4/5 (ex.: plano do cliente
//      não segue o mascaramento 43/55/58 do Domínio). A DRE simples sempre fecha no resultado.
//
// A classificação é SEMPRE achatada (só dígitos) antes de casar os prefixos — o plano pode vir
// com pontos ("3.1.1.001") ou sem ("3101001"); "3.1.1".startsWith("31") daria falso e zerava tudo.
// Valor da DRE = −Σ saldo_final (receita credora vira +, custo/despesa devedora vira −).

const num = v => Number(v) || 0
const flat = l => String(l.classifRaw || l.classif || '').replace(/\D/g, '')
const RE_DEPREC = /deprecia|amortiza|exaust/i
const RE_FIN = /financeir|juros|\brendiment|encargo|\biof\b|desconto.*obtid|multa/i
const RE_IR = /\birpj\b|\bcsll\b|imposto de renda|contrib.*social/i

export function montarDRE(linhas) {
  const analit = (linhas || []).filter(l => !l.sintetica)
  const soma = (pref, exclui = []) => -analit
    .filter(l => { const c = flat(l); return c.startsWith(pref) && !exclui.some(e => c.startsWith(e)) })
    .reduce((s, l) => s + num(l.saldo_final), 0)

  // --- Tentativa DETALHADA (padrão Domínio) ---
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

  // Resultado REAL dos grupos de resultado (1º dígito 3/4/5) — invariante, sempre correto.
  const resultadoReal = -analit
    .filter(l => ['3', '4', '5'].includes(flat(l)[0]))
    .reduce((s, l) => s + num(l.saldo_final), 0)

  // Se há resultado mas a DRE detalhada não fecha com ele, o plano não segue a estrutura
  // Domínio (31/43/55/58…) — cai para a DRE SIMPLES por grupo (que reconcilia por construção).
  const detalhadaFecha = Math.abs(resultadoReal) < 0.005 || Math.abs(lucroLiquido - resultadoReal) < 0.01
  if (!detalhadaFecha) return dreSimples(analit)

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

// DRE SIMPLES por grupo (1º dígito): 3 = receita, 4 = custo, 5 = despesa. Separa dedução
// (deve/haver dentro do grupo 3), depreciação, resultado financeiro e IR pelo NOME da conta.
// Reconcilia sempre: Lucro líquido = −Σ(saldo_final dos grupos 3/4/5).
// NÚMEROS da DRE simples (por grupo: 3=receita, 4=custo, 5=despesa). Separa depreciação,
// resultado financeiro e IR/CSLL pelo NOME da conta — para o EBITDA sair certo (resultado
// OPERACIONAL, sem financeiro/juros, sem IR e sem depreciação). Exportado para o painel e o
// cockpit calcularem EBITDA/margens do mesmo jeito que a DRE, sem depender da estrutura Domínio.
export function apurarResultadoSimples(analit) {
  const g = d => (analit || []).filter(l => flat(l)[0] === String(d))
  const somaNeg = arr => -arr.reduce((s, l) => s + num(l.saldo_final), 0) // −Σ (credor → +)
  const g3 = g('3'), g4 = g('4'), g5 = g('5')
  // Grupo 3: receita (credora, saldo_final < 0) × deduções (devedora, saldo_final > 0).
  const receitaBruta = somaNeg(g3.filter(l => num(l.saldo_final) < 0))
  const deducoes = somaNeg(g3.filter(l => num(l.saldo_final) >= 0))
  const receitaLiquida = receitaBruta + deducoes
  // Custos (grupo 4) — separa depreciação do custo p/ o EBITDA.
  const deprecCusto = somaNeg(g4.filter(l => RE_DEPREC.test(l.nome || '')))
  const csv = somaNeg(g4.filter(l => !RE_DEPREC.test(l.nome || '')))
  const lucroBruto = receitaLiquida + csv
  // Despesas (grupo 5) — separa financeiro, IR/CSLL e depreciação pelo nome; o resto é operacional.
  const financeiro = somaNeg(g5.filter(l => RE_FIN.test(l.nome || '') && !RE_IR.test(l.nome || '')))
  const ir = somaNeg(g5.filter(l => RE_IR.test(l.nome || '')))
  const deprecDesp = somaNeg(g5.filter(l => RE_DEPREC.test(l.nome || '') && !RE_FIN.test(l.nome || '') && !RE_IR.test(l.nome || '')))
  const despOper = somaNeg(g5.filter(l => !RE_FIN.test(l.nome || '') && !RE_IR.test(l.nome || '') && !RE_DEPREC.test(l.nome || '')))
  const deprec = deprecCusto + deprecDesp
  const ebitda = lucroBruto + despOper                 // resultado OPERACIONAL (sem fin/IR/deprec)
  const lair = ebitda + deprec + financeiro
  const lucroLiquido = lair + ir
  return { receitaBruta, deducoes, receitaLiquida, csv, lucroBruto, despOper, ebitda, deprec, financeiro, lair, ir, lucroLiquido }
}

function dreSimples(analit) {
  const { receitaBruta, deducoes, receitaLiquida, csv, lucroBruto, despOper, ebitda, deprec, financeiro, lair, ir, lucroLiquido } = apurarResultadoSimples(analit)

  const rows = []
  const grp = (label, valor) => rows.push({ label, valor, sub: false })
  const sub = (label, valor) => rows.push({ label, valor, sub: true })
  const grpSe = (label, valor) => { if (Math.abs(valor) > 0.005) grp(label, valor) }

  grp('RECEITA BRUTA', receitaBruta)
  grpSe('IMPOSTOS E DEDUÇÕES', deducoes)
  sub('RECEITA LÍQUIDA', receitaLiquida)
  grp('CUSTO DOS SERVIÇOS VENDIDOS - CSV', csv)
  sub('LUCRO BRUTO', lucroBruto)
  grp('DESPESAS OPERACIONAIS', despOper)
  sub('RESULTADO OPERACIONAL (EBITDA)', ebitda)
  grpSe('DEPRECIAÇÃO E AMORTIZAÇÃO', deprec)
  grpSe('RESULTADO FINANCEIRO', financeiro)
  sub('LUCRO ANTES DOS IMPOSTOS', lair)
  grpSe('IMPOSTO DE RENDA E CSLL', ir)
  sub('LUCRO LÍQUIDO DO EXERCÍCIO', lucroLiquido)
  return rows
}

// Resumo do balancete (igual ao Domínio): totais por grupo (Ativo/Passivo/PL/Receitas/
// Custos/Despesas), Contas Devedoras/Credoras e Resultado do mês/exercício. Cada linha traz
// { ini, deb, cred, fim } (saldos com sinal: devedor +, credor −). A classificação é achatada
// (só dígitos) antes de casar o prefixo — o plano pode vir com ou sem pontos.
export function montarResumoBalancete(linhas) {
  const analit = (linhas || []).filter(l => !l.sintetica)
  const raw = l => String(l.classifRaw || l.classif || '').replace(/\D/g, '')
  const grupo = (pref, exclui = []) => {
    const rs = analit.filter(l => { const c = raw(l); return c.startsWith(pref) && !exclui.some(e => c.startsWith(e)) })
    return {
      ini: rs.reduce((s, l) => s + (Number(l.saldo_inicial) || 0), 0),
      deb: rs.reduce((s, l) => s + (Number(l.debito) || 0), 0),
      cred: rs.reduce((s, l) => s + (Number(l.credito) || 0), 0),
      fim: rs.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0),
    }
  }
  const soma = (...gs) => gs.reduce((a, g) => ({ ini: a.ini + g.ini, deb: a.deb + g.deb, cred: a.cred + g.cred, fim: a.fim + g.fim }), { ini: 0, deb: 0, cred: 0, fim: 0 })

  const ativo = grupo('1')
  const passivo = grupo('2', ['23'])
  const pl = grupo('23')
  const receitas = grupo('3')
  const custos = grupo('4')
  const despesas = grupo('5')
  const apuracao = grupo('6')
  const grupos = [
    { label: 'ATIVO', ...ativo },
    { label: 'PASSIVO', ...passivo },
    { label: 'PATRIMONIO LIQUIDO', ...pl },
    { label: 'RECEITAS', ...receitas },
    { label: 'CUSTOS DAS VENDAS', ...custos },
    { label: 'DESPESAS OPERACIONAIS', ...despesas },
  ]
  if (Math.abs(apuracao.fim) > 0.005 || Math.abs(apuracao.deb) > 0.005 || Math.abs(apuracao.cred) > 0.005)
    grupos.push({ label: 'APURACAO DE RESULTADO - TRANSITORIA', ...apuracao })

  const devedoras = { label: 'CONTAS DEVEDORAS', ...soma(ativo, custos, despesas) }
  const credoras = { label: 'CONTAS CREDORAS', ...soma(passivo, pl, receitas) }
  const rExerc = soma(receitas, custos, despesas)
  const resultadoExerc = { label: 'RESULTADO DO EXERCÍCIO', ini: rExerc.ini, deb: rExerc.deb, cred: rExerc.cred, fim: rExerc.fim }
  const resultadoMes = { label: 'RESULTADO DO MES', ini: 0, deb: rExerc.deb, cred: rExerc.cred, fim: rExerc.deb - rExerc.cred }

  return { grupos, devedoras, credoras, resultadoMes, resultadoExerc }
}
