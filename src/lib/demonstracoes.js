// Demonstrações Contábeis — relatório consolidado para o cliente, montado por FOLHAS
// (páginas) no estilo do relatório da CEMIG (tipografia Cambria/Calibri), reaproveitando os
// geradores que já existem: montarBalancete (razão vivo), montarDRE, extrairEntidade,
// apurarDistribuicao. Os relatórios "modelo Domínio" (DRE, Balancete, Comparativo) saem em
// Arial, iguais ao Domínio; o invólucro (capa, cockpit, balanço, DFC) sai no estilo CEMIG.
//
// A tela escolhe O QUE incluir (Cockpit, DRE, Balancete, Balanço, DFC, Comparativo) e o
// PERÍODO (mês, trimestre, semestre, anual ou personalizado). Como DRE/Balancete são por
// competência, aqui há uma camada de AGREGAÇÃO por período: roda montarBalancete mês a mês e
// consolida (saldo inicial da 1ª ponta, movimento somado, saldo final da última ponta para
// contas patrimoniais; soma do movimento para contas de resultado).

import { supabase } from './supabase'
import { lerTudo } from './lerTudo'
import { montarBalancete, apurarBalanco } from './balancete'
import { montarDRE } from './dre'
import { extrairEntidade } from './financeiro'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const g1 = l => String(l.classifRaw || l.classif || '')[0] // grupo pelo 1º dígito da classificação

// Heurísticas de nome de conta (mesmas do Cockpit) para os índices/balanço-resumo.
const RE_IMPOSTO = /impost|tribut|\bicms\b|\bpis\b|cofins|\birpj\b|\bcsll\b|\biss\b|simples|\bdas\b|inss|fgts|contrib/i
const RE_RECEBER = /client|duplicat.*receb|\ba\s*receber|receb.*client|cart[aã]o/i
const RE_PAGAR = /fornec|\ba\s*pagar|duplicat.*pag|obrig.*pag/i
const RE_DEPREC = /deprecia|amortiza|exaust/i
const BANCO_RE = /\bBANCO\b|SANTANDER|ITA[UÚ]|BRADESCO|\bCAIXA\b|SICOOB|SICREDI|\bINTER\b|NUBANK|\bBTG\b|SAFRA|DAYCOVAL|VOTORANTIM|PAGSEGURO|MERCADO ?PAGO|\bC6\b|BANRISUL|\bBB\b/i
const LIXO_ENT = new Set(['VALOR', 'VALORES', 'RENDIMENTO', 'RENDIMENTOS', 'APLICACAO', 'APLICACOES', 'JUROS', 'SALDO', 'RESGATE', 'CDB', 'POUPANCA', 'TARIFA', 'TARIFAS', 'IOF', 'RECEITA', 'RECEITAS', 'FINANCEIRA', 'FINANCEIRAS', 'DIVERSOS', 'DIVERSAS', 'CLIENTE', 'CLIENTES', 'DEPOSITO', 'TRANSFERENCIA', 'TED', 'PIX', 'DOC'])
const ehCliente = ent => { const n = String(ent || '').trim().toUpperCase(); return !!n && !BANCO_RE.test(n) && !LIXO_ENT.has(n) }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// ---- formatação ----
export const brl = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const brlR = v => 'R$ ' + brl(v)
const pctBR = p => p == null ? '—' : `${Number(p).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
// Saldo com sufixo D/C (Domínio): saldo devedor → D, credor → C. Parênteses em deduções.
const dc = v => `${brl(Math.abs(v))} ${num(v) < -0.005 ? 'C' : 'D'}`
const par = v => { const n = num(v); const a = brl(Math.abs(n)); return n < -0.005 ? `(${a})` : a }
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const ultimoDia = (a, m) => new Date(a, m, 0).getDate()
const diaBR = (a, m) => `${String(ultimoDia(a, m)).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`

// ---------------------------------------------------------------------------
// Período → lista de meses {ano, mes}. tipo: 'mes' | 'tri' | 'sem' | 'ano' | 'custom'.
// ref: { ano, mes, tri, sem, de:'YYYY-MM', ate:'YYYY-MM' }.
export function mesesDoPeriodo(tipo, ref = {}) {
  const ano = Number(ref.ano)
  let lista = []
  let label = ''
  if (tipo === 'mes') {
    lista = [{ ano, mes: Number(ref.mes) }]
    label = `${MESES[Number(ref.mes) - 1]} / ${ano}`
  } else if (tipo === 'tri') {
    const t = Number(ref.tri); const m0 = (t - 1) * 3 + 1
    lista = [0, 1, 2].map(k => ({ ano, mes: m0 + k }))
    label = `${t}º trimestre / ${ano}`
  } else if (tipo === 'sem') {
    const s = Number(ref.sem); const m0 = (s - 1) * 6 + 1
    lista = Array.from({ length: 6 }, (_, k) => ({ ano, mes: m0 + k }))
    label = `${s}º semestre / ${ano}`
  } else if (tipo === 'ano') {
    lista = Array.from({ length: 12 }, (_, k) => ({ ano, mes: k + 1 }))
    label = `Exercício de ${ano}`
  } else { // custom 'YYYY-MM'
    const [ai, mi] = String(ref.de || '').split('-').map(Number)
    const [af, mf] = String(ref.ate || '').split('-').map(Number)
    if (ai && mi && af && mf) {
      let a = ai, m = mi
      while (a < af || (a === af && m <= mf)) {
        lista.push({ ano: a, mes: m }); m++; if (m > 12) { m = 1; a++ }
      }
      label = `${String(mi).padStart(2, '0')}/${ai} a ${String(mf).padStart(2, '0')}/${af}`
    }
  }
  return { lista, label }
}

// ---------------------------------------------------------------------------
// Consolida vários balancetes mensais (na ordem cronológica) num balancete de PERÍODO.
// perMonth: [{ ano, mes, linhas }] já em ordem. Chaveia por 'reduzido'.
export function agregarBalancete(perMonth) {
  const mapa = new Map()
  perMonth.forEach((mm, idx) => {
    const ehPrimeiro = idx === 0, ehUltimo = idx === perMonth.length - 1
    for (const l of (mm.linhas || [])) {
      const k = String(l.reduzido)
      let a = mapa.get(k)
      if (!a) { a = { ...l, saldo_inicial: 0, debito: 0, credito: 0, saldo_final: 0, _iniSet: false }; mapa.set(k, a) }
      // nome/classif/hierarquia: mantém o mais recente
      a.nome = l.nome; a.classif = l.classif; a.classifRaw = l.classifRaw; a.sintetica = l.sintetica; a.grau = l.grau; a.folha = l.folha
      if (ehPrimeiro || !a._iniSet) { a.saldo_inicial = num(l.saldo_inicial); a._iniSet = true }
      a.debito += num(l.debito)
      a.credito += num(l.credito)
      const grp = String(l.classifRaw || '')[0]
      if (grp === '3' || grp === '4' || grp === '5' || grp === '6') a.saldo_final += num(l.saldo_final) // resultado: soma o movimento
      else if (ehUltimo) a.saldo_final = num(l.saldo_final) // patrimonial: foto do fim do período
    }
  })
  return [...mapa.values()].sort((x, y) => String(x.classifRaw || '').localeCompare(String(y.classifRaw || '')))
}

// ---------------------------------------------------------------------------
// Indicadores do Cockpit para o período (mesma lógica do PainelCliente, adaptada ao período).
// agg = balancete agregado; perMonth p/ a série; razaoReceita p/ principais clientes.
function apurarCockpit(agg, perMonth, razaoReceita, primeiro, ultimo, serieMonths) {
  const analit = agg.filter(l => !l.sintetica)
  const ativo = analit.filter(l => g1(l) === '1')
  const passivo = analit.filter(l => g1(l) === '2')
  const totAtivo = ativo.reduce((s, l) => s + num(l.saldo_final), 0)
  const totPassivo = passivo.reduce((s, l) => s + num(l.saldo_final), 0)
  const somaFiltro = (arr, re) => arr.filter(l => re.test(l.nome || '')).reduce((s, l) => s + Math.abs(num(l.saldo_final)), 0)
  const clientes = somaFiltro(ativo, RE_RECEBER)
  const fornecedores = somaFiltro(passivo, RE_PAGAR)
  const impostos = somaFiltro(passivo, RE_IMPOSTO)

  // Resultado do período (grupos 3/4/5 do agregado)
  const resGrupo = d => analit.filter(l => g1(l) === d).reduce((s, l) => s + num(l.saldo_final), 0)
  const receita = -resGrupo('3'), custo = resGrupo('4'), despesa = resGrupo('5')
  const resultado = receita - custo - despesa

  // Série mês a mês (gráfico do Cockpit) — usa os meses do ANO quando fornecidos (igual ao
  // Cockpit/prévia, que mostram jan→mês), senão os meses do próprio período.
  const serie = (serieMonths && serieMonths.length ? serieMonths : perMonth).map(mm => {
    const an = (mm.linhas || []).filter(l => !l.sintetica)
    const r = -an.filter(l => g1(l) === '3').reduce((s, l) => s + num(l.saldo_final), 0)
    const c = an.filter(l => g1(l) === '4').reduce((s, l) => s + num(l.saldo_final), 0)
    const d = an.filter(l => g1(l) === '5').reduce((s, l) => s + num(l.saldo_final), 0)
    return { rotulo: MESES[mm.mes - 1], receitaLiq: r, ebitda: r - c, lucroLiq: r - c - d,
      margemEbitda: r ? ((r - c) / r) * 100 : 0, margemLiquida: r ? ((r - c - d) / r) * 100 : 0 }
  })
  // Acumulado do ano = soma dos resultados dos meses da série (jan→mês do período).
  const acumuladoAno = serie.reduce((s, m) => s + m.lucroLiq, 0)

  // Disponibilidades: analíticas da sintética "Disponível" (ini = 1ª ponta, fim = última ponta)
  const sintDisp = agg.filter(l => l.sintetica && g1(l) === '1' && /dispon|caixa\s*e\s*equival|disponibilidad/i.test(l.nome || ''))
    .sort((a, b) => String(a.classifRaw || '').length - String(b.classifRaw || '').length)[0]
  let pref = sintDisp?.classifRaw
  if (!pref && analit.some(l => String(l.classifRaw || '').startsWith('111'))) pref = '111'
  const ehDisp = l => pref ? String(l.classifRaw || '').startsWith(pref) : /\bcaixa\b|banc|aplica|dispon|financeir|conta\s*corrente/i.test(l.nome || '')
  const disponiveis = ativo.filter(ehDisp)
    .map(l => ({ nome: l.nome || l.reduzido, ini: num(l.saldo_inicial), fim: num(l.saldo_final) }))
    .filter(l => Math.abs(l.ini) > 0.005 || Math.abs(l.fim) > 0.005)
    .sort((a, b) => b.fim - a.fim)
  const totDispIni = disponiveis.reduce((s, l) => s + l.ini, 0)
  const totDispFim = disponiveis.reduce((s, l) => s + l.fim, 0)
  const geracaoCaixa = totDispFim - totDispIni

  // Índices — circulante robusto (acha a sintética "circulante"; senão cai no prefixo 1.1/2.1/2.2)
  const somaRaw = p => analit.filter(l => String(l.classifRaw || '').startsWith(p)).reduce((s, l) => s + num(l.saldo_final), 0)
  const somaClassif = p => analit.filter(l => String(l.classif || '').startsWith(p)).reduce((s, l) => s + num(l.saldo_final), 0)
  const NAOCIRC = /n[ao] circulante|nao-circulante|longo prazo/
  const prefSint = (grupo, re, exc) => {
    const s = agg.filter(l => l.sintetica && g1(l) === grupo && re.test(norm(l.nome || '')) && !(exc && exc.test(norm(l.nome || ''))))
      .sort((a, b) => String(a.classifRaw || '').length - String(b.classifRaw || '').length)[0]
    return s?.classifRaw || null
  }
  const preAC = prefSint('1', /circulante/, NAOCIRC), prePC = prefSint('2', /circulante/, NAOCIRC), prePNC = prefSint('2', NAOCIRC, null)
  const ac = preAC ? somaRaw(preAC) : somaClassif('1.1')
  const pc = prePC ? somaRaw(prePC) : somaClassif('2.1')
  const pnc = prePNC ? somaRaw(prePNC) : somaClassif('2.2')
  const indices = {
    margem: receita ? (resultado / receita) * 100 : null,
    margemBruta: receita ? ((receita - custo) / receita) * 100 : null,
    cargaTrib: receita ? (impostos / receita) * 100 : null,
    liquidez: Math.abs(pc) > 0.005 ? ac / Math.abs(pc) : null,
    endividamento: Math.abs(totAtivo) > 0.005 ? ((Math.abs(pc) + Math.abs(pnc)) / Math.abs(totAtivo)) * 100 : null,
    prazoReceb: receita ? Math.round((clientes / receita) * 30 * perMonth.length) : null,
  }

  // Principais clientes (nome no histórico das NFs de receita, somando o período)
  const mapaCli = {}; let totReceitaRazao = 0
  for (const l of (razaoReceita || [])) {
    const v = num(l.credito) - num(l.debito)
    if (v <= 0) continue
    totReceitaRazao += v
    const ent = extrairEntidade(l.historico)
    if (!ent || /^[\d.,\s]+$/.test(ent) || ent.replace(/[^A-Za-zÀ-ú]/g, '').length < 3) continue
    if (!ehCliente(ent)) continue
    mapaCli[ent] = (mapaCli[ent] || 0) + v
  }
  const topClientes = Object.entries(mapaCli).map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor).slice(0, 6)

  return { receita, custo, despesa, resultado, acumuladoAno, totAtivo, totPassivo, clientes, fornecedores, impostos,
    disponiveis, totDispIni, totDispFim, geracaoCaixa, indices, serie, topClientes, totReceitaRazao,
    ac, pc, pnc,
    dataIni: diaBR(primeiro.mes === 1 ? primeiro.ano - 1 : primeiro.ano, primeiro.mes === 1 ? 12 : primeiro.mes - 1), // fim do mês anterior à 1ª ponta
    dataFim: diaBR(ultimo.ano, ultimo.mes) }
}

// DFC método indireto (aproximado) reconciliado à variação de caixa do período.
function apurarDFC(agg, cockpit) {
  const analit = agg.filter(l => !l.sintetica)
  const lucro = cockpit.resultado
  const deprec = analit.filter(l => RE_DEPREC.test(l.nome || '') && (g1(l) === '1' || g1(l) === '5' || g1(l) === '4'))
    .reduce((s, l) => s + Math.abs(num(l.debito)), 0) // depreciação do período (movimento)
  const varCaixa = cockpit.geracaoCaixa
  // Financiamento: variação de empréstimos/financiamentos e capital (fim − ini)
  const RE_EMPREST = /empr[eé]stim|financiam|debentur|arrendam/i
  const RE_CAPITAL = /capital\s*social|reserva|adiantamento.*futuro.*aumento/i
  const varConta = re => analit.filter(l => re.test(l.nome || '') && (g1(l) === '2'))
    .reduce((s, l) => s + (num(l.saldo_final) - num(l.saldo_inicial)), 0)
  // passivo credor: saldo_final negativo; aumento de dívida = entrada de caixa. (fim−ini) em passivo credor
  // já vem com sinal correto p/ caixa quando invertido:
  const financiamento = -(varConta(RE_EMPREST) + varConta(RE_CAPITAL))
  // Investimento: variação do imobilizado/investimentos (grupo 1 não circulante), fora depreciação
  const RE_IMOB = /imobiliz|investiment|intangiv|imposto.*diferido/i
  const varImob = analit.filter(l => RE_IMOB.test(l.nome || '') && g1(l) === '1' && !RE_DEPREC.test(l.nome || ''))
    .reduce((s, l) => s + (num(l.saldo_final) - num(l.saldo_inicial)), 0)
  const investimento = -varImob // aumento de ativo = saída de caixa
  // Operacional = variação de caixa − investimento − financiamento (fecha por diferença)
  const operacional = varCaixa - investimento - financiamento
  const capitalGiro = operacional - lucro - deprec // plug que fecha o operacional
  return { lucro, deprec, capitalGiro, operacional, investimento, financiamento, varCaixa,
    saldoIni: cockpit.totDispIni, saldoFim: cockpit.totDispFim }
}

// ---------------------------------------------------------------------------
// Monta TODOS os dados a partir dos balancetes mensais já lidos + razão de receita do período.
// perMonth: [{ ano, mes, linhas }] em ordem cronológica (dados do PERÍODO).
// anoPerMonth: meses do ANO (jan→mês do período) só p/ o gráfico do Cockpit + acumulado do ano.
// perMonthComp: meses que alimentam o COMPARATIVO (colunas). Por padrão = perMonth (o período),
// mas a tela pode passar uma faixa própria (botão de data do Comparativo).
export function montarDadosDemonstracoes(perMonth, razaoReceita, anoPerMonth, perMonthComp) {
  const agg = agregarBalancete(perMonth)
  const primeiro = perMonth[0], ultimo = perMonth[perMonth.length - 1]
  const dre = montarDRE(agg)
  const cockpit = apurarCockpit(agg, perMonth, razaoReceita, primeiro, ultimo, anoPerMonth)
  const dfc = apurarDFC(agg, cockpit)
  // Matriz do comparativo (contas de resultado, mês a mês) — usa a faixa própria se houver.
  const pmComp = (perMonthComp && perMonthComp.length) ? perMonthComp : perMonth
  const meses = pmComp.map(m => m.mes)
  // Estrutura da CLASSIFICAÇÃO (igual ao Comparativo de Movimento dos Relatórios): inclui
  // sintéticas E analíticas dos grupos de resultado (3/4/5), com classif/grau, para render
  // hierárquico ordenado pela classificação (não pelo código).
  const contasRes = {}
  pmComp.forEach(mm => (mm.linhas || []).filter(l => ['3', '4', '5'].includes(g1(l))).forEach(l => {
    const classifRaw = String(l.classifRaw || l.classif || '')
    const k = l.sintetica ? ('S:' + classifRaw) : ('#' + String(l.reduzido))
    if (!contasRes[k]) contasRes[k] = {
      cod: l.reduzido || '', nome: l.nome, grupo: g1(l),
      classif: l.classif, classifRaw, grau: l.grau || classifRaw.split('.').length, sintetica: !!l.sintetica,
      vals: {},
    }
    contasRes[k].vals[mm.mes] = (contasRes[k].vals[mm.mes] || 0) + num(l.saldo_final)
    contasRes[k].nome = l.nome
  }))
  return { agg, dre, cockpit, dfc, meses, contasRes }
}

// ---------------------------------------------------------------------------
// BUILDER do documento HTML (folhas). blocos: Set com 'cockpit','dre','balancete','balanco','dfc','comparativo'.
export function abrirDemonstracoesContabeis({ empresa, cnpj, periodoLabel, periodoIni, periodoFim, blocos, dados, modelo = 'sistema', nivel = 'tudo' }) {
  const B = new Set(blocos)
  const { agg, dre, cockpit, dfc, meses, contasRes } = dados
  const c = cockpit
  const emissao = new Date().toLocaleDateString('pt-BR')
  // Nível de detalhe (igual ao Comparativo): 'tudo' = todas as contas; N = só sintéticas até o
  // nível N (colapsa as analíticas e as sintéticas mais fundas). Aplica SÓ ao Balanço.
  const nvl = nivel === 'tudo' ? 'tudo' : Number(nivel)
  const passaNivel = l => nvl === 'tudo' || (l.sintetica && (l.grau || 1) <= nvl)
  let folha = 1 // a capa é a folha 1 (sem marca); os blocos seguintes começam na 2
  const marca = () => `<div class="pmark">Folha ${++folha}</div>`
  const bandCmp = per => `<div class="cmp"><div class="wm">Attentive</div><div class="per">Período</div><div class="perv">${esc(per)}</div></div>`

  const paginas = []

  // ---- Capa / desempenho (sempre) ----
  const ix = c.indices
  const grafico = svgDesempenho(c.serie)
  const custoP = c.receita ? (c.custo / c.receita) * 100 : 0
  const despP = c.receita ? (c.despesa / c.receita) * 100 : 0
  const fmt2 = v => v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  paginas.push(`
  <div class="page">
    <div class="band"><div><div class="tt">Demonstrações Contábeis</div><div class="ss">Demonstrações e desempenho do período</div></div>${bandCmp(periodoLabel)}</div>
    <div class="meta">
      <div><div class="l">Empresa</div><div class="v">${esc(empresa)}</div></div>
      <div><div class="l">CNPJ</div><div class="v">${esc(cnpj || '—')}</div></div>
      <div><div class="l">Emissão</div><div class="v">${esc(emissao)}</div></div>
    </div>
    <div class="content">
      <h2 class="sec">Resumo do desempenho</h2>
      <p class="lead">No período <b>${esc(periodoLabel)}</b>, a ${esc(empresa)} registrou receita de <b>${brlR(c.receita)}</b> e resultado de <span class="up">${brlR(c.resultado)}</span>, uma <b>margem líquida de ${pctBR(ix.margem)}</b>. Custo de ${brlR(c.custo)} (${pctBR(custoP)} da receita) e despesas de ${brlR(c.despesa)} (${pctBR(despP)}). No <b>acumulado do ano</b>: <b>${brlR(c.acumuladoAno)}</b>.</p>
      <div class="kpis">
        <div class="kpi"><div class="k">Receita do período</div><div class="v">${brlR(c.receita)}</div></div>
        <div class="kpi"><div class="k">Resultado</div><div class="v ${c.resultado >= 0 ? 'g' : 'r'}">${brlR(c.resultado)}</div></div>
        <div class="kpi"><div class="k">Margem líquida</div><div class="v ${c.resultado >= 0 ? 'g' : 'r'}">${pctBR(ix.margem)}</div></div>
        <div class="kpi"><div class="k">Acumulado do ano</div><div class="v">${brlR(c.acumuladoAno)}</div></div>
      </div>
      <h2 class="sec">Indicadores</h2>
      <table class="gtab">
        <tr><td>Margem líquida</td><td class="r">${pctBR(ix.margem)}</td><td class="mut">resultado ÷ receita</td></tr>
        <tr><td>Margem bruta</td><td class="r">${pctBR(ix.margemBruta)}</td><td class="mut">(receita − custo) ÷ receita</td></tr>
        <tr><td>Liquidez corrente</td><td class="r">${fmt2(ix.liquidez)}</td><td class="mut">ativo circ. ÷ passivo circ.</td></tr>
        <tr><td>Endividamento</td><td class="r">${pctBR(ix.endividamento)}</td><td class="mut">passivo exig. ÷ ativo</td></tr>
        <tr><td>Carga tributária</td><td class="r">${pctBR(ix.cargaTrib)}</td><td class="mut">impostos ÷ receita</td></tr>
        <tr><td>Prazo médio de recebimento</td><td class="r">${ix.prazoReceb == null ? '—' : ix.prazoReceb + ' dias'}</td><td class="mut">a receber ÷ receita</td></tr>
      </table>
      ${c.serie.length > 1 ? `<h2 class="sec">Desempenho por mês (gráfico do Cockpit)</h2>
      <div class="chart">${grafico}
        <div class="leg"><span><i style="background:#4A7CFF"></i>Receita Líquida</span><span><i style="background:#E5484D"></i>EBITDA</span><span><i style="background:#30A46C"></i>Lucro Líquido</span><span><i class="ln" style="border-top:2px dashed #E5484D"></i>Margem EBITDA</span><span><i class="ln" style="border-top:2px dotted #30A46C"></i>Margem Líquida</span></div>
      </div>` : ''}
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)

  // ---- Cockpit ----
  if (B.has('cockpit')) {
    const disp = c.disponiveis.length
      ? c.disponiveis.map(l => `<tr><td>${esc(l.nome)}</td><td class="r">${brl(l.ini)}</td><td class="r">${brl(l.fim)}</td></tr>`).join('')
      : `<tr><td colspan="3" class="mut">Sem contas de disponibilidade no período.</td></tr>`
    const maxCli = Math.max(1, ...c.topClientes.map(x => x.valor))
    const baseCli = c.totReceitaRazao || c.topClientes.reduce((s, x) => s + x.valor, 0)
    const cliRows = c.topClientes.length
      ? c.topClientes.map(x => `<div class="cli"><span style="font-weight:600">${esc(x.nome)}</span><span>${brlR(x.valor)} <small class="mut">· ${pctBR(baseCli ? (x.valor / baseCli) * 100 : null)}</small></span></div><div class="bar"><span style="width:${(x.valor / maxCli) * 100}%"></span></div>`).join('')
      : `<p class="mut" style="font-size:11px;margin:6px 0 0">Sem nomes de clientes identificados no histórico das NFs de receita.</p>`
    paginas.push(`
  <div class="page">
    ${marca()}
    <div class="band"><div><div class="tt">Painel do Cockpit</div><div class="ss">Resultado · balanço · financeiro · impostos · clientes · índices</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <h2 class="sec">Comparativo de movimento — resumo (nível 1)</h2>
      <div class="tiles">
        <div class="tile"><div class="k">Total de faturamento</div><div class="v a">${brlR(c.receita)}</div></div>
        <div class="tile"><div class="k">Total de custo</div><div class="v y">${brlR(c.custo)}</div></div>
        <div class="tile"><div class="k">Despesa</div><div class="v y">${brlR(c.despesa)}</div></div>
        <div class="tile"><div class="k">Lucro / resultado</div><div class="v ${c.resultado >= 0 ? 'g' : 'r'}">${brlR(c.resultado)}</div><div class="s">margem ${pctBR(ix.margem)}</div></div>
      </div>
      <h2 class="sec">Balanço patrimonial</h2>
      <div class="tiles">
        <div class="tile"><div class="k">Total do ativo</div><div class="v">${brlR(c.totAtivo)}</div></div>
        <div class="tile"><div class="k">Total do passivo + PL</div><div class="v">${brlR(Math.abs(c.totPassivo))}</div></div>
        <div class="tile"><div class="k">Clientes (a receber)</div><div class="v g">${brlR(c.clientes)}</div></div>
        <div class="tile"><div class="k">Fornecedores (a pagar)</div><div class="v r">${brlR(c.fornecedores)}</div></div>
      </div>
      <h2 class="sec">Financeiro — disponibilidades e geração de caixa</h2>
      <div class="fin2">
        <table class="ftab"><thead><tr><td>Conta</td><td class="r">${esc(c.dataIni)}</td><td class="r">${esc(c.dataFim)}</td></tr></thead>
          <tbody>${disp}</tbody>
          <tfoot><tr><td>Total disponível</td><td class="r">${brl(c.totDispIni)}</td><td class="r">${brl(c.totDispFim)}</td></tr></tfoot>
        </table>
        <div class="tiles" style="grid-template-columns:1fr">
          <div class="tile"><div class="k">Total disponível (fim)</div><div class="v a">${brlR(c.totDispFim)}</div></div>
          <div class="tile"><div class="k">Geração de caixa no período</div><div class="v ${c.geracaoCaixa >= 0 ? 'g' : 'r'}">${brlR(c.geracaoCaixa)}</div></div>
        </div>
      </div>
      <h2 class="sec">Impostos</h2>
      <div class="tiles">
        <div class="tile"><div class="k">Impostos apurados</div><div class="v">${brlR(c.impostos)}</div><div class="s">${pctBR(ix.cargaTrib)} do faturamento</div></div>
        <div class="tile"><div class="k">Carga tributária</div><div class="v">${pctBR(ix.cargaTrib)}</div><div class="s">impostos ÷ faturamento</div></div>
      </div>
      <h2 class="sec">Principais clientes do período</h2>
      <div class="clibox">${cliRows}</div>
      <h2 class="sec">Índices financeiros</h2>
      <div class="tiles">
        <div class="tile"><div class="k">Liquidez corrente</div><div class="v">${ix.liquidez == null ? '—' : ix.liquidez.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div class="s">ativo circ. ÷ passivo circ.</div></div>
        <div class="tile"><div class="k">Margem líquida</div><div class="v">${pctBR(ix.margem)}</div><div class="s">resultado ÷ receita</div></div>
        <div class="tile"><div class="k">Endividamento</div><div class="v">${pctBR(ix.endividamento)}</div><div class="s">passivo exig. ÷ ativo</div></div>
        <div class="tile"><div class="k">Carga tributária</div><div class="v">${pctBR(ix.cargaTrib)}</div><div class="s">impostos ÷ receita</div></div>
        <div class="tile"><div class="k">Prazo médio receb.</div><div class="v">${ix.prazoReceb == null ? '—' : ix.prazoReceb + ' dias'}</div><div class="s">a receber ÷ receita</div></div>
      </div>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
  }

  // ---- DRE (Domínio) ----
  if (B.has('dre')) {
    // Linhas de resultado (lucro/prejuízo) destacadas: lucro (≥0) verde, prejuízo (<0) vermelho.
    const ehResultado = lbl => /lucro|preju[ií]zo|resultado/i.test(lbl)
    const corDre = (lbl, v) => ehResultado(lbl) ? ` style="color:${(Number(v) || 0) >= 0 ? '#0a7d33' : '#c0341d'};font-weight:bold"` : ''
    const linhasDre = dre.map(r => r.sub
      ? `<tr class="s"><td${corDre(r.label, r.valor)}>${esc(r.label)}</td><td class="r"></td><td class="r"${corDre(r.label, r.valor)}>${par(r.valor)}</td></tr>`
      : `<tr><td>${esc(r.label)}</td><td class="r">${par(r.valor)}</td><td class="r">${par(r.valor)}</td></tr>`).join('')
    paginas.push(`
  <div class="page">
    ${marca()}
    <div class="band"><div><div class="tt">Demonstração do Resultado</div><div class="ss">Modelo Domínio</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <div class="dominio">
        <div class="cab"><table>
          <tr><td class="lab">Empresa:</td><td>${esc(empresa)}</td><td style="text-align:right;white-space:nowrap">Folha:&nbsp;&nbsp;0001</td></tr>
          <tr><td class="lab">C.N.P.J.:</td><td>${esc(cnpj || '—')}</td><td></td></tr>
          <tr><td class="lab">Período:</td><td>${esc(periodoIni)} - ${esc(periodoFim)}</td><td></td></tr>
        </table></div>
        <h3>DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO</h3>
        <table class="dtab">
          <tr><th>Descrição</th><th class="r">Saldo</th><th class="r">Total</th></tr>
          ${linhasDre}
        </table>
      </div>
      <p class="mut" style="font-size:10px;margin:8px 0 0"><b>Modelo Domínio</b> — apurado do razão vivo do período.</p>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
  }

  // ---- Balancete completo (Domínio) — 2 folhas: Patrimoniais e Resultado (igual à prévia) ----
  if (B.has('balancete')) {
    const temMov = l => Math.abs(num(l.saldo_final)) > 0.005 || Math.abs(num(l.debito)) > 0.005 || Math.abs(num(l.credito)) > 0.005
    const linhaBal = l => {
      const cls = l.sintetica ? (String(l.classifRaw || '').length <= 1 ? 'g' : 'n') : ''
      const ind = l.sintetica ? (String(l.classifRaw || '').length <= 1 ? '' : 'i1') : 'i2'
      return `<tr class="${cls}"><td>${esc(l.reduzido)}</td><td>${esc(l.classif)}</td><td class="${ind}">${esc(l.nome)}</td><td class="r">${dc(l.saldo_inicial)}</td><td class="r">${brl(l.debito)}</td><td class="r">${brl(l.credito)}</td><td class="r">${dc(l.saldo_final)}</td></tr>`
    }
    const folhaBal = (titulo, sub, h3, grupos, folhaNo, rodape) => {
      const rows = agg.filter(l => temMov(l) && grupos.includes(g1(l))).map(linhaBal).join('')
      if (!rows) return
      paginas.push(`
  <div class="page">
    ${marca()}
    <div class="band"><div><div class="tt">${titulo}</div><div class="ss">${sub}</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <div class="dominio">
        <div class="cab"><table>
          <tr><td class="lab">Empresa:</td><td>${esc(empresa)}</td><td style="text-align:right;white-space:nowrap">Folha:&nbsp;&nbsp;${folhaNo}</td></tr>
          <tr><td class="lab">C.N.P.J.:</td><td>${esc(cnpj || '—')}</td><td></td></tr>
          <tr><td class="lab">Período:</td><td>${esc(periodoIni)} - ${esc(periodoFim)}</td><td></td></tr>
        </table></div>
        <h3>${h3}</h3>
        <div style="overflow:auto"><table class="dtab">
          <tr><th>Código</th><th>Classificação</th><th>Descrição da conta</th><th class="r">Saldo anterior</th><th class="r">Débito</th><th class="r">Crédito</th><th class="r">Saldo atual</th></tr>
          ${rows}
        </table></div>
      </div>
      <p class="mut" style="font-size:10px;margin:8px 0 0">${rodape}</p>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
    }
    folhaBal('Balancete', 'Modelo Domínio · completo (1/2)', 'BALANCETE — CONTAS PATRIMONIAIS', ['1', '2'], '0001',
      `Fecha <b>Ativo = Passivo + PL = ${brlR(Math.abs(c.totAtivo))}</b>. <i>Contas de resultado na próxima folha →</i>`)
    folhaBal('Balancete (continuação)', 'Modelo Domínio · completo (2/2)', 'BALANCETE — CONTAS DE RESULTADO', ['3', '4', '5'], '0002',
      `Balancete <b>completo</b> — todos os níveis (grupo, sintéticas e analíticas). Receitas − Custos − Despesas = <b>resultado do período ${brlR(c.resultado)}</b>.`)
  }

  // ---- Balanço Patrimonial (modelo Domínio) — hierárquico, 2 colunas (Ativo | Passivo+PL) ----
  if (B.has('balanco')) {
    // Duas colunas independentes, top-down: grupo → subgrupo → sintéticas → analíticas, com D/C.
    const lado = grupo => agg.filter(l => g1(l) === grupo && Math.abs(num(l.saldo_final)) > 0.005 && passaNivel(l))
      .sort((a, b) => String(a.classifRaw || '').localeCompare(String(b.classifRaw || ''), 'pt-BR', { numeric: true }))
    const A = lado('1'), P = lado('2')
    // FONTE ÚNICA (apurarBalanco) — mesmo cálculo do card Balanço. O resultado ACUMULADO vem do
    // Comparativo de Movimento (soma dos movimentos de resultado no período, = RESULTADO DO
    // EXERCÍCIO), entra no PL e soma no total do Passivo.
    const resAcumComp = -Object.values(contasRes).filter(x => !x.sintetica)
      .reduce((s, x) => s + meses.reduce((a, m) => a + (x.vals[m] || 0), 0), 0)
    const balc = apurarBalanco(agg.filter(l => !l.sintetica), { resultado: resAcumComp })
    const cellDesc = l => {
      const ind = 6 + Math.max(0, (l.grau || 1) - 1) * 13
      return `<td style="padding-left:${ind}px${l.sintetica ? ';font-weight:bold' : ''}">${esc(l.nome)}</td>`
    }
    const cellSal = l => `<td class="r"${l.sintetica ? ' style="font-weight:bold"' : ''}>${dc(l.saldo_final)}</td>`
    const vazio = '<td></td><td class="r"></td>'
    const nrows = Math.max(A.length, P.length)
    let corpo = ''
    for (let i = 0; i < nrows; i++) {
      const a = A[i], p = P[i]
      corpo += `<tr>${a ? cellDesc(a) + cellSal(a) : vazio}<td class="sep">${p ? '' : ''}</td>${p ? cellDesc(p) + cellSal(p) : vazio}</tr>`
    }
    // Resultado do exercício no PL (fecha o balanço) + linha de TOTAIS batendo dos dois lados.
    corpo += `<tr class="g"><td></td><td class="r"></td><td class="sep"></td><td style="font-weight:bold">${esc(balc.labelResultado)}</td><td class="r" style="font-weight:bold">${brl(balc.resultado)}</td></tr>`
    corpo += `<tr class="s"><td>TOTAL DO ATIVO</td><td class="r">${brlR(balc.totAtivo)}</td><td class="sep"></td><td>TOTAL DO PASSIVO + PL</td><td class="r">${brlR(balc.totPassivo)}</td></tr>`
    paginas.push(`
  <div class="page">
    ${marca()}
    <div class="band"><div><div class="tt">Balanço Patrimonial</div><div class="ss">Modelo Domínio · encerrado em ${esc(periodoFim)}</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <div class="dominio">
        <div class="cab"><table>
          <tr><td class="lab">Empresa:</td><td>${esc(empresa)}</td><td style="text-align:right;white-space:nowrap">Balanço encerrado em:&nbsp;&nbsp;${esc(periodoFim)}</td></tr>
          <tr><td class="lab">C.N.P.J.:</td><td>${esc(cnpj || '—')}</td><td></td></tr>
        </table></div>
        <h3>BALANÇO PATRIMONIAL</h3>
        <div style="overflow:auto"><table class="dtab baltab">
          <tr><th>Descrição</th><th class="r">Saldo Atual</th><th class="sep"></th><th>Descrição</th><th class="r">Saldo Atual</th></tr>
          ${corpo}
        </table></div>
      </div>
      <p class="mut" style="font-size:10px;margin:8px 0 0">${Math.abs(balc.diferenca) < 0.01
        ? `Conferência: <b>Ativo = Passivo + PL = ${brlR(balc.totAtivo)}</b> (inclui o <b>${esc(balc.labelResultado.toLowerCase())}</b> de ${brlR(balc.resultado)}, vindo do Comparativo de Movimento).`
        : `<b style="color:#c0341d">Diferença de ${brlR(balc.diferenca)}</b> entre Ativo (${brlR(balc.totAtivo)}) e Passivo + PL (${brlR(balc.totPassivo)}) — o resultado do Comparativo (${brlR(balc.resultado)}) não fecha o patrimônio. Conferir conciliação/classificação.`} Saldos do fim do período. <i>(−) contas redutoras aparecem com o saldo na natureza invertida.</i></p>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
  }

  // ---- DFC (estilo CEMIG) ----
  if (B.has('dfc')) {
    const f = dfc
    paginas.push(`
  <div class="page">
    ${marca()}
    <div class="band"><div><div class="tt">Fluxo de Caixa</div><div class="ss">DFC · método indireto</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <table class="fin" style="max-width:600px">
        <tr class="h"><td>Fluxo de caixa — ${esc(periodoLabel)}</td><td class="r">R$</td></tr>
        <tr class="t"><td>Atividades operacionais</td><td class="r">${par(f.operacional)}</td></tr>
        <tr><td class="i1">Lucro/prejuízo do período</td><td class="r">${par(f.lucro)}</td></tr>
        <tr><td class="i1">(+) Depreciação/amortização</td><td class="r">${par(f.deprec)}</td></tr>
        <tr><td class="i1">(±) Variação do capital de giro</td><td class="r">${par(f.capitalGiro)}</td></tr>
        <tr class="t"><td>Atividades de investimento</td><td class="r">${par(f.investimento)}</td></tr>
        <tr><td class="i1">Imobilizado / investimentos</td><td class="r">${par(f.investimento)}</td></tr>
        <tr class="t"><td>Atividades de financiamento</td><td class="r">${par(f.financiamento)}</td></tr>
        <tr><td class="i1">Empréstimos, capital e distribuições</td><td class="r">${par(f.financiamento)}</td></tr>
        <tr class="tot"><td>VARIAÇÃO LÍQUIDA DE CAIXA</td><td class="r">${par(f.varCaixa)}</td></tr>
        <tr><td>(+) Saldo inicial de caixa</td><td class="r">${brl(f.saldoIni)}</td></tr>
        <tr class="t"><td>(=) Saldo final de caixa</td><td class="r">${brl(f.saldoFim)}</td></tr>
      </table>
      <p class="mut" style="font-size:10.5px;margin:8px 0 0">Método indireto — a variação de caixa (<b>${brlR(f.varCaixa)}</b>) bate com o saldo final das disponibilidades. Operacional e capital de giro são apurados por diferença (reconciliação automática).</p>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
  }

  // ---- Comparativo de Movimento (paisagem) ----
  if (B.has('comparativo')) {
    const thMeses = meses.map(m => `<th class="r">${MESES[m - 1]}</th>`).join('')
    // Cada valor sai com a natureza do saldo (padrão Domínio): devedor = D, credor = C.
    const dcv = v => { const a = Math.abs(v || 0); return a < 0.005 ? '—' : `${brl(a)} ${v > 0 ? 'D' : 'C'}` }
    // Resultado: lucro (≥0) verde, prejuízo (<0) vermelho — pra destacar pro cliente.
    const cor = v => v >= 0 ? '#0a7d33' : '#c0341d'
    const brlCor = v => `<span style="color:${cor(v)};font-weight:bold">${brl(v)}</span>`
    // Estrutura da classificação: sintéticas + analíticas ordenadas pela CLASSIFICAÇÃO (igual ao
    // Comparativo de Movimento dos Relatórios), indentado por nível, com D/C em cada valor.
    const contas = Object.values(contasRes)
      .sort((a, b) => String(a.classifRaw || '').localeCompare(String(b.classifRaw || ''), 'pt-BR', { numeric: true }))
    let corpo = contas.map(x => {
      const tt = meses.reduce((s, m) => s + (x.vals[m] || 0), 0)
      const ind = 4 + Math.max(0, (x.grau || 1) - 1) * 12
      const badge = x.sintetica ? `<span class="niv">N${x.grau || 1}</span> ` : ''
      return `<tr class="${x.sintetica ? 'g' : ''}"><td>${esc(x.cod || '')}</td><td>${esc(x.classif || '')}</td>` +
        `<td style="padding-left:${ind}px${x.sintetica ? ';font-weight:bold' : ''}">${badge}${esc(x.nome)}</td>` +
        `${meses.map(m => `<td class="r">${dcv(x.vals[m] || 0)}</td>`).join('')}<td class="r">${dcv(tt)}</td></tr>`
    }).join('')
    // Resultado do mês/exercício das ANALÍTICAS (receita credora neg, custo/despesa devedora pos).
    const resMes = {}; let acum = 0; const acumMes = {}
    const analitRes = Object.values(contasRes).filter(x => !x.sintetica)
    meses.forEach(m => {
      const r = -analitRes.filter(x => x.grupo === '3').reduce((s, x) => s + (x.vals[m] || 0), 0)
      const cu = analitRes.filter(x => x.grupo === '4').reduce((s, x) => s + (x.vals[m] || 0), 0)
      const de = analitRes.filter(x => x.grupo === '5').reduce((s, x) => s + (x.vals[m] || 0), 0)
      resMes[m] = r - cu - de; acum += resMes[m]; acumMes[m] = acum
    })
    const totRes = meses.reduce((s, m) => s + resMes[m], 0)
    corpo += `<tr class="s"><td></td><td></td><td>RESULTADO DO MÊS</td>${meses.map(m => `<td class="r">${brlCor(resMes[m])}</td>`).join('')}<td class="r">${brlCor(totRes)}</td></tr>`
    corpo += `<tr class="s"><td></td><td></td><td>RESULTADO DO EXERCÍCIO (acumulado)</td>${meses.map(m => `<td class="r">${brlCor(acumMes[m])}</td>`).join('')}<td class="r">${brlCor(totRes)}</td></tr>`
    paginas.push(`
  <div class="page land">
    ${marca().replace('</div>', ' · paisagem</div>')}
    <div class="band"><div><div class="tt">Comparativo de Movimento</div><div class="ss">Contas de resultado · todos os meses · paisagem</div></div>${bandCmp(periodoLabel)}</div>
    <div class="content">
      <div class="dominio">
        <div class="cab"><table>
          <tr><td class="lab">Empresa:</td><td>${esc(empresa)}</td><td style="text-align:right;white-space:nowrap">Folha:&nbsp;&nbsp;0001&nbsp;·&nbsp;Paisagem</td></tr>
          <tr><td class="lab">C.N.P.J.:</td><td>${esc(cnpj || '—')}</td><td></td></tr>
          <tr><td class="lab">Período:</td><td>${esc(periodoIni)} - ${esc(periodoFim)} · contas de resultado (grupos 3, 4 e 5)</td><td></td></tr>
        </table></div>
        <h3>COMPARATIVO DE MOVIMENTO — CONTAS DE RESULTADO</h3>
        <div style="overflow:auto"><table class="dtab">
          <tr><th>Conta</th><th>Classificação</th><th>Nome da conta</th>${thMeses}<th class="r">Total</th></tr>
          ${corpo}
        </table></div>
      </div>
      <p class="mut" style="font-size:10px;margin:8px 0 0">Comparativo <b>completo</b> das contas de resultado (grupos 3, 4 e 5), mês a mês, em paisagem.</p>
    </div>
    <div class="foot">Attentive Contabilidade · Demonstrações Contábeis · Valores em BRL</div>
  </div>`)
  }

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Demonstrações Contábeis — ${esc(empresa)}</title>
<style>${CSS}</style></head><body class="modelo-${modelo === 'dominio' ? 'dominio' : 'sistema'}">${paginas.join('\n')}
<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) { alert('Permita pop-ups para gerar o PDF.'); return false }
  w.document.write(html); w.document.close()
  return true
}

// Gráfico do Cockpit (combo) — IDÊNTICO ao GraficoDesempenho do PainelCliente (versão estática
// p/ o PDF): eixo R$ à esquerda, eixo % à direita, linhas de grade, barras Receita Líquida /
// EBITDA / Lucro Líquido e linhas de Margem EBITDA (tracejada) e Margem Líquida (pontilhada)
// com o rótulo do valor em cada ponto.
const ACC = '#4A7CFF', VERM = '#E5484D', VERD = '#30A46C', GRID = '#e6e9ef', SUB = '#98a2b3', INK = '#1c2430'
function svgDesempenho(s) {
  if (!s || s.length < 2) return ''
  const W = 1000, H = 360, mL = 78, mR = 54, mT = 16, mB = 38
  const x0 = mL, x1 = W - mR, y1 = H - mB
  const plotH = y1 - mT, plotW = x1 - x0
  const n = s.length, gw = plotW / n
  const maxR = Math.max(1, ...s.map(p => Math.max(p.receitaLiq, p.ebitda, p.lucroLiq))) * 1.12
  const maxPctR = Math.max(10, Math.ceil(Math.max(...s.flatMap(p => [p.margemEbitda, p.margemLiquida, 0])) / 10) * 10)
  const yR = v => y1 - (Math.max(0, v) / maxR) * plotH
  const yP = v => y1 - (v / maxPctR) * plotH
  const cx = i => x0 + gw * i + gw / 2
  const bars = [['receitaLiq', ACC], ['ebitda', VERM], ['lucroLiq', VERD]]
  const linhas = [['margemEbitda', VERM, '7 4'], ['margemLiquida', VERD, '2 4']]
  const bw = (gw * 0.62) / 3
  const money0 = v => `R$ ${Math.round(v).toLocaleString('pt-BR')}`
  let g = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`
  // grades + eixo R$ (esq) e % (dir)
  for (let i = 0; i < 6; i++) {
    const vR = maxR * i / 5, y = yR(vR), vP = maxPctR * i / 5
    g += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${GRID}"/>`
    g += `<text x="${x0 - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${SUB}">${money0(vR)}</text>`
    g += `<text x="${x1 + 8}" y="${(yP(vP) + 3.5).toFixed(1)}" text-anchor="start" font-size="10" fill="${SUB}">${vP.toFixed(0)}%</text>`
  }
  // barras
  s.forEach((p, i) => bars.forEach(([k, cor], bi) => {
    const v = p[k], y = yR(v), bx = cx(i) - (bw * 3) / 2 + bi * bw
    g += `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0, y1 - y).toFixed(1)}" fill="${cor}" rx="1"/>`
  }))
  // linhas de margem + rótulos
  linhas.forEach(([k, cor, dash]) => {
    g += `<polyline points="${s.map((p, i) => `${cx(i).toFixed(1)},${yP(p[k]).toFixed(1)}`).join(' ')}" fill="none" stroke="${cor}" stroke-width="2" stroke-dasharray="${dash}"/>`
    s.forEach((p, i) => {
      g += `<circle cx="${cx(i).toFixed(1)}" cy="${yP(p[k]).toFixed(1)}" r="2.6" fill="${cor}"/>`
      g += `<text x="${cx(i).toFixed(1)}" y="${(yP(p[k]) - 7).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${INK}">${p[k].toFixed(2)}%</text>`
    })
  })
  // meses + eixos
  s.forEach((p, i) => { g += `<text x="${cx(i).toFixed(1)}" y="${y1 + 16}" text-anchor="middle" font-size="10.5" fill="${SUB}">${p.rotulo}</text>` })
  g += `<line x1="${x0}" y1="${mT}" x2="${x0}" y2="${y1}" stroke="${GRID}"/><line x1="${x1}" y1="${mT}" x2="${x1}" y2="${y1}" stroke="${GRID}"/>`
  return g + '</svg>'
}

// CSS do documento (estilo CEMIG: Cambria/Calibri; Domínio em Arial, intocado).
const CSS = `
*{box-sizing:border-box}
:root{--paper:#fff;--ink:#1c2430;--sub:#5a6785;--line:#e6e9ef;--band:#101a2e;--bandsub:#8fa3c4;--accent:#4A7CFF;--green:#1f9d63;--amber:#8a5a12;--soft:#f6f8fb;--serif:"Cambria",Georgia,"Times New Roman",serif;--sans:"Calibri","Segoe UI",system-ui,-apple-system,sans-serif}
html,body{margin:0;background:#e9edf3;color:var(--ink);font-family:var(--sans)}
body{padding:20px 12px 60px}
.mut{color:var(--sub)}
.page{background:var(--paper);color:var(--ink);width:min(820px,100%);margin:0 auto 24px;border-radius:10px;box-shadow:0 10px 40px rgba(20,30,60,.18);overflow:hidden}
.page.land{width:min(1160px,100%)}
.pmark{font-size:9px;color:#9aa9c0;text-align:center;padding:6px 0 0}
.band{background:var(--band);color:#fff;padding:16px 30px 14px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.band .tt{font-family:var(--serif);font-size:18px;font-weight:700;letter-spacing:.4px;line-height:1.15}
.band .ss{font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:var(--bandsub);margin-top:5px}
.band .cmp{text-align:right}
.band .cmp .wm{font-family:var(--serif);font-size:18px;font-weight:700}
.band .cmp .per{font-size:8px;letter-spacing:1.6px;text-transform:uppercase;color:var(--bandsub);margin-top:6px}
.band .cmp .perv{font-size:13px;font-weight:600;margin-top:1px}
.meta{display:flex;gap:34px;padding:10px 30px;background:var(--soft);border-bottom:1px solid var(--line);flex-wrap:wrap}
.meta .l{font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#98a2b3}
.meta .v{font-size:11.5px;margin-top:2px;font-weight:500}
.content{padding:22px 30px 28px}
h2.sec{font-family:var(--serif);font-size:15px;letter-spacing:.2px;color:var(--band);font-weight:700;margin:22px 0 11px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
h2.sec:first-child{margin-top:0}
p.lead{font-size:13.5px;line-height:1.65;margin:0 0 10px}
p.lead .up{color:var(--green);font-weight:700}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:2px 0}
.kpi{border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--soft)}
.kpi .k{font-size:8.5px;text-transform:uppercase;letter-spacing:1px;color:#98a2b3;font-weight:700}
.kpi .v{font-size:19px;font-weight:800;margin-top:4px}
.kpi .v.g{color:var(--green)}
.gtab{width:100%;border-collapse:collapse;font-size:12.5px}
.gtab td{padding:8px;border-bottom:1px solid var(--line)}
.gtab td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.gtab td.mut{color:var(--sub)}
.chart{border:1px solid var(--line);border-radius:10px;padding:12px 14px 6px;background:var(--soft)}
.chart .leg{display:flex;gap:14px;flex-wrap:wrap;font-size:10.5px;color:var(--sub);padding:2px 2px 4px}
.chart .leg i{display:inline-block;width:14px;height:11px;border-radius:3px;margin-right:5px;vertical-align:middle}
.chart .leg i.ln{width:18px;height:0;border-radius:0;background:none!important}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--paper)}
.tile .k{font-size:8.5px;text-transform:uppercase;letter-spacing:1px;color:#98a2b3;font-weight:700}
.tile .v{font-size:17px;font-weight:800;margin-top:4px}
.tile .s{font-size:10px;color:var(--sub);margin-top:2px}
.v.g{color:var(--green)}.v.r{color:#c0392b}.v.a{color:var(--accent)}.v.y{color:#8a5a12}
.fin2{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,.9fr);gap:12px;align-items:start}
.ftab{width:100%;border-collapse:collapse;font-size:12px}
.ftab td{padding:7px 8px;border-bottom:1px solid var(--line)}
.ftab td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ftab thead td{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#98a2b3;font-weight:700;background:var(--soft)}
.ftab tfoot td{font-weight:700;background:var(--soft)}
.clibox{border:1px solid var(--line);border-radius:10px;padding:12px 15px;background:var(--soft)}
.cli{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:7px 0 3px}
.bar{height:6px;background:var(--line);border-radius:20px;overflow:hidden;margin-bottom:5px}
.bar>span{display:block;height:100%;background:var(--accent);border-radius:20px}
.fincols{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.fin{width:100%;border-collapse:collapse;font-size:12px}
.fin td{padding:5px 8px;border-bottom:1px solid var(--line)}
.fin td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.fin td.i1{padding-left:22px}
.fin tr.h td{font-family:var(--serif);font-weight:700;font-size:12.5px;color:var(--band);background:var(--soft);border-top:1.5px solid var(--band)}
.fin tr.t td{font-weight:700;border-top:1px solid #b9c2d4;border-bottom:1.5px solid var(--band);background:var(--soft)}
.fin tr.tot td{font-family:var(--serif);font-weight:700;font-size:13px;color:#fff;background:var(--band)}
.foot{padding:12px 30px;border-top:1px solid var(--line);font-size:8.5px;color:#98a2b3;text-align:center;background:var(--soft)}
/* Modelo Domínio (Arial, intocado) */
.dominio{border:1px solid #000;border-radius:4px;overflow:hidden;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}
.dominio .cab table{width:100%;border-collapse:collapse;font-size:11px}
.dominio .cab td{padding:4px 10px}
.dominio .cab tr+tr td{border-top:1px solid #000}
.dominio .cab{border-bottom:1px solid #000}
.dominio .cab td.lab{font-weight:bold;width:74px}
.dominio h3{text-align:center;font-size:12px;margin:9px 0;font-weight:bold;letter-spacing:.5px}
.dtab{width:100%;border-collapse:collapse;font-size:11px}
.dtab th{background:#ededed;border-top:1px solid #000;border-bottom:1px solid #000;padding:5px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.dtab th.r,.dtab td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dtab td{padding:5px 8px;border-bottom:1px solid #e3e3e3}
.dtab tr.s td{font-weight:bold;border-top:1px solid #9a9a9a;border-bottom:1px solid #9a9a9a;background:#f3f3f3}
.dtab tr.g td{font-weight:bold;background:#f0f0f0;text-transform:uppercase;font-size:10px}
.dtab tr.n td{font-weight:bold;background:#fafafa}
.dtab td.i1{padding-left:16px}.dtab td.i2{padding-left:26px}
.dtab td.sep,.dtab th.sep{width:14px;min-width:14px;border-left:1px solid #000;border-bottom:none;background:#fff;padding:0}
.baltab td,.baltab th{font-size:10.5px}
.dtab .niv{font-size:8px;background:#e6ecfb;color:#3355aa;border-radius:4px;padding:1px 4px;font-weight:bold;vertical-align:middle}
/* Modelo SISTEMA (padrão): reveste os quadros "Domínio" (DRE/Balancete/Balanço/Comparativo)
   no visual Attentive — mesma estrutura, tipografia Calibri/Cambria e cores da marca.
   Modelo DOMÍNIO: sem override → fica o fac-símile preto/branco em Arial. */
.modelo-sistema .dominio{border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font-family:var(--sans)}
.modelo-sistema .dominio .cab{border-bottom:1px solid var(--line);background:var(--soft)}
.modelo-sistema .dominio .cab tr+tr td{border-top:1px solid var(--line)}
.modelo-sistema .dominio h3{font-family:var(--serif);color:var(--band);letter-spacing:.2px}
.modelo-sistema .dtab th{background:var(--soft);border-top:none;border-bottom:1.5px solid var(--band);color:var(--sub);font-weight:700}
.modelo-sistema .dtab td{border-bottom:1px solid var(--line)}
.modelo-sistema .dtab tr.g td{background:rgba(74,124,255,.09);color:var(--band);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.modelo-sistema .dtab tr.n td{background:#f7f9fe}
.modelo-sistema .dtab tr.s td{background:var(--soft);border-top:1px solid var(--band);border-bottom:1.5px solid var(--band);color:var(--band)}
.modelo-sistema .dtab td.sep,.modelo-sistema .dtab th.sep{border-left:1px solid var(--line);background:transparent}
/* Impressão: cada folha vira uma página; comparativo em paisagem */
@page{size:A4 portrait;margin:14mm}
@page land{size:A4 landscape;margin:12mm}
@media print{
  html,body{background:#fff;padding:0}
  .page{width:auto;margin:0;border-radius:0;box-shadow:none;page-break-after:always}
  .page.land{page:land}
  .pmark{display:none}
}
`
