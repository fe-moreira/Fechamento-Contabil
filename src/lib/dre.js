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

// Resumo do balancete (igual ao Domínio): totais por grupo (Ativo/Passivo/PL/Receitas/
// Custos/Despesas), Contas Devedoras/Credoras e Resultado do mês/exercício. Cada linha traz
// { ini, deb, cred, fim } (saldos com sinal: devedor +, credor −). Ativo/Passivo/PL vêm com
// Saldo Anterior por arrasto; nas contas de resultado o Saldo Anterior depende de meses
// anteriores importados (senão vem só do mês).
export function montarResumoBalancete(linhas) {
  const analit = (linhas || []).filter(l => !l.sintetica)
  const raw = l => String(l.classifRaw || l.classif || '')
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
