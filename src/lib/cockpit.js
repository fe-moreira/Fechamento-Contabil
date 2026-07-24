import { supabase } from './supabase'
import { lerTudo } from './lerTudo'
import { apurarVariacoes } from './variacoes'
import { apurarDistribuicao } from './distribuicao'
import { montarBalancete } from './balancete'
import { extrairEntidade } from './financeiro'

// Apuração do COCKPIT FINANCEIRO — fonte única dos números da tela PainelCliente e do
// relatório "Financeiro" (PDF). Fonte VIVA: balancete (razão + lançamentos confirmados).
// Retorna o mesmo objeto que a tela consome.

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const pct = (a, b) => (b ? (a / b) * 100 : null)
const BANCO_RE = /\bBANCO\b|SANTANDER|ITA[UÚ]|BRADESCO|\bCAIXA\b|SICOOB|SICREDI|\bINTER\b|NUBANK|\bBTG\b|SAFRA|DAYCOVAL|VOTORANTIM|PAGSEGURO|MERCADO ?PAGO|\bC6\b|BANRISUL|\bBB\b/i
const LIXO_ENT = new Set(['VALOR', 'VALORES', 'RENDIMENTO', 'RENDIMENTOS', 'APLICACAO', 'APLICACOES', 'JUROS', 'SALDO', 'RESGATE', 'CDB', 'POUPANCA', 'TARIFA', 'TARIFAS', 'IOF', 'RECEITA', 'RECEITAS', 'FINANCEIRA', 'FINANCEIRAS', 'DIVERSOS', 'DIVERSAS', 'CLIENTE', 'CLIENTES', 'DEPOSITO', 'TRANSFERENCIA', 'TED', 'PIX', 'DOC'])
const ehCliente = ent => { const n = String(ent || '').trim().toUpperCase(); return !!n && !BANCO_RE.test(n) && !LIXO_ENT.has(n) }
const RE_IMPOSTO = /impost|tribut|\bicms\b|\bpis\b|cofins|\birpj\b|\bcsll\b|\biss\b|simples|\bdas\b|inss|fgts|contrib/i
const RE_RECEBER = /client|duplicat.*receb|\ba\s*receber|receb.*client|cart[aã]o/i
const RE_PAGAR = /fornec|\ba\s*pagar|duplicat.*pag|obrig.*pag/i
const RE_DISP = /\bcaixa\b|banc|aplica|dispon|financeir|conta\s*corrente/i

export async function apurarCockpit(empresaId, compId, mes, ano) {
  // Balancete hierárquico VIVO (razão + lançamentos confirmados).
  const { linhas: hier } = await montarBalancete(empresaId, compId, 0, { comLancamentos: true })
  const analit = (hier || []).filter(l => !l.sintetica)
  const g = l => String(l.classifRaw || '')[0]

  const comparativo = await apurarVariacoes(empresaId, { comLancamentos: true })
  const dist = await apurarDistribuicao(empresaId, compId, ano, mes)

  // Receita/Custo/Despesa/Resultado por mês do ano — VIVO.
  const { data: compsAno } = await supabase.from('competencias').select('id, mes')
    .eq('cliente_id', empresaId).eq('ano', ano).order('mes', { ascending: true })
  const porMes = {}, meses = []
  for (const c of (compsAno || [])) {
    const linhasC = c.id === compId ? hier : (await montarBalancete(empresaId, c.id, 0, { comLancamentos: true })).linhas
    const res = (linhasC || []).filter(l => !l.sintetica && ['3', '4', '5'].includes(String(l.classifRaw || '')[0]))
    if (!res.length) continue
    let g3 = 0, g4 = 0, g5 = 0
    for (const l of res) {
      const sf = Number(l.saldo_final) || 0
      const grp = String(l.classifRaw || '')[0]
      if (grp === '3') g3 += sf; else if (grp === '4') g4 += sf; else g5 += sf
    }
    const receita = -g3, custo = g4, despesa = g5
    meses.push(c.mes)
    porMes[c.mes] = { receita, custo, despesa, resultado: receita - custo - despesa }
  }
  meses.sort((a, b) => a - b)
  const receitaMes = m => porMes[m]?.receita || 0
  const custoMes = m => porMes[m]?.custo || 0
  const despesaMes = m => porMes[m]?.despesa || 0
  const resMes = m => porMes[m]?.resultado || 0
  const serie = meses.map(m => ({ mes: m, receita: receitaMes(m), despesa: custoMes(m) + despesaMes(m), resultado: resMes(m) }))
  const resultado = resMes(mes)
  const acumulado = meses.filter(m => m <= mes).reduce((s, m) => s + resMes(m), 0)

  const serieCombo = meses.map(m => {
    const p = porMes[m] || { receita: 0, custo: 0, despesa: 0, resultado: 0 }
    const receitaLiq = p.receita, ebitda = p.receita - p.custo, lucroLiq = p.resultado
    return {
      mes: m, rotulo: MESES[m - 1], receitaLiq, ebitda, lucroLiq,
      margemEbitda: receitaLiq ? (ebitda / receitaLiq) * 100 : 0,
      margemLiquida: receitaLiq ? (lucroLiq / receitaLiq) * 100 : 0,
    }
  })

  const faturamento = receitaMes(mes)
  const custo = custoMes(mes)
  const despesa = despesaMes(mes)
  const lucro = resultado

  // Balanço.
  const ativoLinhas = analit.filter(l => g(l) === '1')
  const passivoLinhas = analit.filter(l => g(l) === '2')
  const totAtivo = ativoLinhas.reduce((s, l) => s + num(l.saldo_final), 0)
  const totPassivo = passivoLinhas.reduce((s, l) => s + num(l.saldo_final), 0)
  const somaFiltro = (arr, re) => arr.filter(l => re.test(l.nome || '')).reduce((s, l) => s + Math.abs(num(l.saldo_final)), 0)
  const clientes = somaFiltro(ativoLinhas, RE_RECEBER)
  const fornecedores = somaFiltro(passivoLinhas, RE_PAGAR)
  const impostos = somaFiltro(passivoLinhas, RE_IMPOSTO)

  // Disponibilidades (caixa/bancos/aplicações).
  const sintDisp = (hier || [])
    .filter(l => l.sintetica && g(l) === '1' && /dispon|caixa\s*e\s*equival|disponibilidad/i.test(l.nome || ''))
    .sort((a, b) => String(a.classifRaw || '').length - String(b.classifRaw || '').length)[0]
  let dispPrefix = sintDisp?.classifRaw
  if (!dispPrefix && analit.some(l => String(l.classifRaw || '').startsWith('111'))) dispPrefix = '111'
  const ehDisp = l => dispPrefix ? String(l.classifRaw || '').startsWith(dispPrefix) : RE_DISP.test(l.nome || '')
  const disponiveis = ativoLinhas.filter(ehDisp)
    .map(l => ({ nome: l.nome || l.reduzido, ini: num(l.saldo_inicial), fim: num(l.saldo_final) }))
    .filter(l => Math.abs(l.ini) > 0.005 || Math.abs(l.fim) > 0.005)
    .sort((a, b) => b.fim - a.fim)
  const totDispIni = disponiveis.reduce((s, l) => s + l.ini, 0)
  const totDispFim = disponiveis.reduce((s, l) => s + l.fim, 0)
  const geracaoCaixa = totDispFim - totDispIni

  const ultDia = (a, m) => new Date(a, m, 0).getDate()
  const fmtDia = (a, m) => `${String(ultDia(a, m)).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`
  const mAnt = mes === 1 ? 12 : mes - 1, aAnt = mes === 1 ? ano - 1 : ano
  const dataIni = fmtDia(aAnt, mAnt), dataFim = fmtDia(ano, mes)

  const somaClassif = pref => analit.filter(l => String(l.classif || '').startsWith(pref)).reduce((s, l) => s + num(l.saldo_final), 0)
  const ac = somaClassif('1.1')
  const pc = somaClassif('2.1')
  const pnc = somaClassif('2.2')
  const indices = {
    margem: faturamento ? ((faturamento - custo - despesa) / faturamento) * 100 : null,
    cargaTrib: faturamento ? (impostos / faturamento) * 100 : null,
    liquidez: pc ? ac / Math.abs(pc) : null,
    endividamento: totAtivo ? pct(Math.abs(pc) + Math.abs(pnc), Math.abs(totAtivo)) : null,
    prazoReceb: faturamento ? Math.round((clientes / faturamento) * 30) : null,
  }

  const distTotal = (dist?.socios || []).reduce((s, x) => s + num(x.total), 0)

  // Principais clientes (nome do histórico das NFs de receita).
  const receitaCods = [...new Set(analit.filter(l => g(l) === '3').map(l => String(l.reduzido)))]
  let topClientes = [], totReceitaRazao = 0
  if (receitaCods.length) {
    const rz = await lerTudo(() => supabase.from('razao').select('conta, historico, debito, credito')
      .eq('competencia_id', compId).in('conta', receitaCods))
    const mapa = {}
    for (const l of (rz || [])) {
      const v = num(l.credito) - num(l.debito)
      if (v <= 0) continue
      totReceitaRazao += v
      const ent = extrairEntidade(l.historico)
      if (!ent || /^[\d.,\s]+$/.test(ent) || ent.replace(/[^A-Za-zÀ-ú]/g, '').length < 3) continue
      if (!ehCliente(ent)) continue
      mapa[ent] = (mapa[ent] || 0) + v
    }
    topClientes = Object.entries(mapa).map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor).slice(0, 6)
  }

  return {
    faturamento, custo, despesa, resultado, lucro, acumulado, serie, serieCombo,
    totAtivo, totPassivo, clientes, fornecedores,
    impostos, disponiveis, totDispIni, totDispFim, geracaoCaixa, dataIni, dataFim,
    indices, dist, distTotal, ata: dist.ata || { distribuido: 0, pago: 0, pagoMes: 0, saldo: 0 },
    comparativo,
    variacoesConta: new Set((comparativo.itens || []).map(i => String(i.conta))).size,
    topClientes, totReceitaRazao,
  }
}
