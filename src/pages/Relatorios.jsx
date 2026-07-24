import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData, useRelatorio } from '../lib/appData'
import { apurarDistribuicao } from '../lib/distribuicao'
import { apurarBancoResultado } from '../lib/bancoResultado'
import { apurarVariacoes } from '../lib/variacoes'
import { parsePlano, contasConciliacaoAbertas, montarBalancete } from '../lib/balancete'
import { gerarExcelTimbrado } from '../lib/excel'
import { abreBalanceteDominio, abreDreDominio, abreCartaPendencias, abreRelatoriosContabeis } from '../lib/pdf'
import { apurarCockpit } from '../lib/cockpit'
import { montarDRE, montarResumoBalancete } from '../lib/dre'
import BookComposicoes from '../components/BookComposicoes'
import ComparativoCompleto from '../components/ComparativoCompleto'
import { theme, money, moneyDC } from '../lib/theme'
import InfoTela from '../components/InfoTela'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

// Data pt-BR a partir de um created_at (ISO).
function dataPtBR(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Catálogo de relatórios (ordem das abas/cards).
const RELATORIOS = [
  { id: 'balancete', nome: 'Balancete', icon: 'ti-table', desc: 'Saldos por conta (inicial, movimento e final).' },
  { id: 'dre', nome: 'DRE', icon: 'ti-report-money', desc: 'Demonstração do resultado: Receita Líquida, Lucro Bruto, EBITDA, LAIR e Lucro Líquido.' },
  { id: 'book', nome: 'Book de Composições', icon: 'ti-book', desc: 'Contas patrimoniais: composição, amarração e documento-suporte para auditoria.' },
  { id: 'balanco', nome: 'Balanço Patrimonial', icon: 'ti-scale', desc: 'Ativo e Passivo + Patrimônio Líquido por conta (saldo final).' },
  { id: 'comparativo', nome: 'Comparativo de Movimento', icon: 'ti-arrows-diff', desc: 'Saldo de cada conta ao longo dos meses (estrutura completa) · Excel e PDF padrão Domínio.' },
  { id: 'pendencias', nome: 'Relatório de Pendências', icon: 'ti-alert-triangle', desc: 'Documentos da competência ainda não recebidos.' },
  { id: 'bancoresult', nome: 'Banco × Resultado', icon: 'ti-building-bank', desc: 'Lançamentos de banco direto em conta de resultado não liberada.' },
  { id: 'indedutiveis', nome: 'Despesas indedutíveis (LALUR)', icon: 'ti-receipt', desc: 'Despesas classificadas como indedutíveis nas justificativas.' },
  { id: 'distribuicao', nome: 'Distribuição de lucros · IRRF 2026', icon: 'ti-cash', desc: 'Apuração por sócio: total recebido, limite e IRRF estimado.' },
  { id: 'auditoria', nome: 'Justificativas e correções do fechamento', icon: 'ti-clipboard-check', desc: 'Consolida toda a auditoria registrada nesta competência.' },
]

// Relatórios do card "Relatórios Contábeis", na ORDEM do "gerar todos".
// emBreve = ainda não gera (entra na próxima onda: Comparativo e DFC).
const CONTABEIS = [
  { id: 'financeiro', nome: 'Relatório do Financeiro', icon: 'ti-cash', desc: 'O painel do Cockpit (receita, resultado, caixa, indicadores) em PDF.', novo: true },
  { id: 'balancete', nome: 'Balancete', icon: 'ti-table', desc: 'Saldos por conta (padrão Domínio).' },
  { id: 'dre', nome: 'DRE', icon: 'ti-report-money', desc: 'Demonstração do resultado do exercício.' },
  { id: 'dfc', nome: 'DFC', icon: 'ti-arrows-exchange', desc: 'Fluxo de caixa (método indireto).', novo: true, emBreve: true },
  { id: 'balanco', nome: 'Balanço Patrimonial', icon: 'ti-scale', desc: 'Ativo, Passivo e Patrimônio Líquido por conta.' },
  { id: 'comparativo', nome: 'Comparativo de Movimento', icon: 'ti-arrows-diff', desc: 'Contas de resultado, mês a mês (Receitas, Custos e Despesas).' },
  { id: 'pendencias', nome: 'Relatório de Pendências', icon: 'ti-alert-triangle', desc: 'Documentos e itens ainda pendentes.' },
]
// ids que saem dos cards soltos (viraram o card único). Book e os especiais continuam.
const CONTAB_NA_LISTA = new Set(['balancete', 'dre', 'balanco', 'comparativo', 'pendencias'])

// --- Montadores do HTML de cada relatório (viram páginas do PDF único) ---
const escP = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmtN = v => Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dcN = v => { const n = Number(v) || 0; return Math.abs(n) < 0.005 ? '0,00' : fmtN(n) + (n >= 0 ? ' D' : ' C') }
const money2 = v => { const n = Number(v) || 0; return (n < -0.005 ? '-' : '') + 'R$ ' + fmtN(n) }
const paren = v => { const n = Number(v) || 0; return n < -0.005 ? `(${fmtN(n)})` : fmtN(n) }
const pctN = p => p == null ? '—' : `${p.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
const MES3 = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

function secBalancete({ hier, linhas }) {
  const arr = (hier && hier.length) ? hier : (linhas || []).map(l => ({ reduzido: l.conta, classif: '', nome: l.nome, saldo_inicial: l.saldo_inicial, debito: l.debito, credito: l.credito, saldo_final: l.saldo_final, sintetica: false }))
  const body = arr.map(l => `<tr class="${l.sintetica ? 'grp' : ''}"><td>${escP(l.reduzido || '')}</td><td>${escP(l.classif || '')}</td><td>${escP(l.nome || '')}</td><td class="r">${dcN(l.saldo_inicial)}</td><td class="r">${fmtN(l.debito)}</td><td class="r">${fmtN(l.credito)}</td><td class="r">${dcN(l.saldo_final)}</td></tr>`).join('')
  return { titulo: 'Balancete', sub: 'Saldos por conta · padrão Domínio', html: `<table class="rt"><thead><tr><th>Código</th><th>Classificação</th><th>Descrição da conta</th><th class="r">Saldo anterior</th><th class="r">Débito</th><th class="r">Crédito</th><th class="r">Saldo atual</th></tr></thead><tbody>${body || '<tr><td colspan="7">Sem dados.</td></tr>'}</tbody></table>` }
}
function secDRE({ dreRows }) {
  const body = (dreRows || []).map(r => r.sub
    ? `<tr class="sub"><td>${escP(r.label)}</td><td class="r"></td><td class="r">${paren(r.valor)}</td></tr>`
    : `<tr><td>${escP(r.label)}</td><td class="r">${paren(r.valor)}</td><td class="r">${paren(r.valor)}</td></tr>`).join('')
  return { titulo: 'DRE — Demonstração do Resultado', sub: 'Receita → Resultado do exercício', html: `<table class="rt"><thead><tr><th>Descrição</th><th class="r">Saldo</th><th class="r">Total</th></tr></thead><tbody>${body || '<tr><td colspan="3">Sem dados de resultado.</td></tr>'}</tbody></table>` }
}
function secBalanco({ hier }) {
  const g = l => String(l.classifRaw || '')[0]
  const rowsFor = grp => (hier || []).filter(l => g(l) === grp).map(l => `<tr class="${l.sintetica ? 'grp' : ''}"><td>${escP(l.reduzido || '')}</td><td>${escP(l.nome || '')}</td><td class="r">${dcN(l.saldo_final)}</td></tr>`).join('')
  const tot = grp => (hier || []).filter(l => !l.sintetica && g(l) === grp).reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const tbl = (t, rows, total) => `<h2 class="blk">${t}</h2><table class="rt"><thead><tr><th>Conta</th><th>Descrição</th><th class="r">Saldo</th></tr></thead><tbody>${rows || '<tr><td colspan="3">—</td></tr>'}</tbody><tfoot><tr><td colspan="2">Total</td><td class="r">${dcN(total)}</td></tr></tfoot></table>`
  return { titulo: 'Balanço Patrimonial', sub: 'Ativo × Passivo + Patrimônio Líquido', html: tbl('Ativo', rowsFor('1'), tot('1')) + tbl('Passivo + Patrimônio Líquido', rowsFor('2'), tot('2')) }
}
function secPendencias({ pendencias, concPend, contratoPend, despesaPend }) {
  const linhas = []
  for (const d of (pendencias || [])) linhas.push([d.tipo || d.nome || d.documento || 'Documento', 'Documento não recebido'])
  for (const c of (concPend || [])) linhas.push([`${c.conta} · ${c.nome || ''}`, `Conciliação — ${c.justificativa || 'pendência do cliente'}`])
  for (const a of (contratoPend || [])) linhas.push([`${a.item}${a.detalhe ? ' — ' + a.detalhe : ''}`, 'Contrato não enviado'])
  for (const a of (despesaPend || [])) linhas.push([`${a.item}${a.detalhe ? ' — ' + a.detalhe : ''}`, 'Pendência do cliente'])
  const body = linhas.map(([it, tp]) => `<tr><td>${escP(it)}</td><td>${escP(tp)}</td></tr>`).join('')
  return { titulo: 'Relatório de Pendências', sub: `${linhas.length} pendência(s)`, html: `<table class="rt"><thead><tr><th>Item</th><th>Situação</th></tr></thead><tbody>${body || '<tr><td colspan="2">Sem pendências nesta competência.</td></tr>'}</tbody></table>` }
}
function secFinanceiro(ck) {
  if (!ck) return { titulo: 'Relatório do Financeiro (Cockpit)', html: '<p class="vazio">Sem dados.</p>' }
  const kpi = (k, v, neg) => `<div class="kpi"><div class="k">${k}</div><div class="v ${neg ? 'neg' : ''}">${v}</div></div>`
  const resumo = `<div class="kpis">${kpi('Faturamento do mês', money2(ck.faturamento))}${kpi('Custo', money2(ck.custo))}${kpi('Despesa', money2(ck.despesa))}${kpi('Resultado do mês', money2(ck.resultado), ck.resultado < 0)}${kpi('Resultado acumulado', money2(ck.acumulado), ck.acumulado < 0)}${kpi('Geração de caixa', money2(ck.geracaoCaixa), ck.geracaoCaixa < 0)}</div>`
  const serie = `<h2 class="blk">Evolução no ano</h2>${svgBarrasSerie(ck.serie)}<table class="rt"><thead><tr><th>Mês</th><th class="r">Receita</th><th class="r">Custo + Despesa</th><th class="r">Resultado</th></tr></thead><tbody>${(ck.serie || []).map(s => `<tr><td>${MES3[s.mes - 1]}</td><td class="r">${money2(s.receita)}</td><td class="r">${money2(s.despesa)}</td><td class="r">${money2(s.resultado)}</td></tr>`).join('') || '<tr><td colspan="4">—</td></tr>'}</tbody></table>`
  const disp = `<h2 class="blk">Disponibilidades (${ck.dataIni} → ${ck.dataFim})</h2><table class="rt"><thead><tr><th>Conta</th><th class="r">Saldo inicial</th><th class="r">Saldo final</th></tr></thead><tbody>${(ck.disponiveis || []).map(l => `<tr><td>${escP(l.nome)}</td><td class="r">${money2(l.ini)}</td><td class="r">${money2(l.fim)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody><tfoot><tr><td>Total · geração de caixa ${money2(ck.geracaoCaixa)}</td><td class="r">${money2(ck.totDispIni)}</td><td class="r">${money2(ck.totDispFim)}</td></tr></tfoot></table>`
  const idx = ck.indices || {}
  const indices = `<h2 class="blk">Indicadores</h2><table class="rt"><tbody><tr><td>Margem líquida</td><td class="r">${pctN(idx.margem)}</td></tr><tr><td>Carga tributária</td><td class="r">${pctN(idx.cargaTrib)}</td></tr><tr><td>Liquidez corrente</td><td class="r">${idx.liquidez == null ? '—' : idx.liquidez.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr><tr><td>Endividamento</td><td class="r">${pctN(idx.endividamento)}</td></tr><tr><td>Prazo médio de recebimento</td><td class="r">${idx.prazoReceb == null ? '—' : idx.prazoReceb + ' dias'}</td></tr></tbody></table>`
  const top = (ck.topClientes && ck.topClientes.length) ? `<h2 class="blk">Principais clientes</h2><table class="rt"><thead><tr><th>Cliente</th><th class="r">Receita</th></tr></thead><tbody>${ck.topClientes.map(c => `<tr><td>${escP(c.nome)}</td><td class="r">${money2(c.valor)}</td></tr>`).join('')}</tbody></table>` : ''
  return { titulo: 'Relatório do Financeiro (Cockpit)', sub: 'Receita, resultado, caixa e indicadores', html: resumo + serie + disp + indices + top }
}

// Mini gráfico de barras (SVG) da evolução no ano — Receita (azul) × Resultado (verde/vermelho).
function svgBarrasSerie(serie) {
  if (!serie || !serie.length) return ''
  const W = 720, H = 190, pad = 30, n = serie.length
  const max = Math.max(1, ...serie.flatMap(s => [Math.abs(s.receita), Math.abs(s.resultado)]))
  const bw = (W - pad * 2) / n, y0 = H - 26
  const sc = v => (Math.abs(v) / max) * (H - 66)
  const bars = serie.map((s, i) => {
    const x = pad + i * bw, rh = sc(s.receita), lh = sc(s.resultado)
    return `<rect x="${(x + bw * 0.16).toFixed(1)}" y="${(y0 - rh).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${rh.toFixed(1)}" fill="#4A7CFF" rx="1.5"/><rect x="${(x + bw * 0.52).toFixed(1)}" y="${(y0 - lh).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${lh.toFixed(1)}" fill="${s.resultado >= 0 ? '#30A46C' : '#E5484D'}" rx="1.5"/><text x="${(x + bw * 0.5).toFixed(1)}" y="${H - 9}" font-size="8.5" text-anchor="middle" fill="#98a2b3">${MES3[s.mes - 1]}</text>`
  }).join('')
  return `<div style="border:1px solid #e6e9ef;border-radius:8px;padding:8px 10px 2px;background:#fafbfc;margin-bottom:6px"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><line x1="${pad}" y1="${y0}" x2="${W - pad}" y2="${y0}" stroke="#e6e9ef"/>${bars}</svg><div style="font-size:8px;color:#98a2b3;padding:0 0 6px"><span style="color:#4A7CFF">■</span> Receita &nbsp; <span style="color:#30A46C">■</span> Resultado (lucro) &nbsp; <span style="color:#E5484D">■</span> Resultado (prejuízo)</div></div>`
}

// Comparativo de Movimento — só as CONTAS DE RESULTADO (grupos 3/4/5), MÊS A MÊS.
// Lê o balancete vivo de cada competência do ano e monta a matriz conta × mês (movimento).
async function dadosCompResultado(empresaId, ano) {
  const { data: comps } = await supabase.from('competencias').select('id, mes')
    .eq('cliente_id', empresaId).eq('ano', ano).order('mes', { ascending: true })
  const meta = {}, mov = {}, meses = []
  for (const c of (comps || [])) {
    const { linhas } = await montarBalancete(empresaId, c.id, 0, { comLancamentos: true })
    const res = (linhas || []).filter(l => ['3', '4', '5'].includes(String(l.classifRaw || '')[0]))
    if (!res.length) continue
    meses.push(c.mes)
    for (const l of res) {
      const key = (!l.sintetica && l.reduzido) ? '#' + l.reduzido : (l.classifRaw || l.classif)
      if (!meta[key]) meta[key] = { key, cod: l.reduzido, nome: l.nome, classifRaw: l.classifRaw || l.classif, sintetica: l.sintetica }
      ;(mov[key] ||= {})[c.mes] = (Number(l.debito) || 0) - (Number(l.credito) || 0)
    }
  }
  meses.sort((a, b) => a - b)
  const contas = Object.values(meta).sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)
  return { meses, contas, mov }
}
function secComparativo({ meses, contas, mov }) {
  const dc = v => { if (v == null) return ''; const n = Number(v) || 0; return Math.abs(n) < 0.005 ? '0,00' : fmtN(n) + (n >= 0 ? ' D' : ' C') }
  const thM = meses.map(m => `<th class="r">${MES3[m - 1]}</th>`).join('')
  const body = contas.map(c => `<tr class="${c.sintetica ? 'grp' : ''}"><td>${escP(c.cod || '')}</td><td>${escP(c.nome || '')}</td>${meses.map(m => `<td class="r">${dc(mov[c.key]?.[m])}</td>`).join('')}</tr>`).join('')
  return { titulo: 'Comparativo de Movimento — contas de resultado', sub: 'Movimento mês a mês · Receitas, Custos e Despesas', html: `<table class="rt"><thead><tr><th>Código</th><th>Conta</th>${thM}</tr></thead><tbody>${body || `<tr><td colspan="${2 + meses.length}">Sem dados no comparativo.</td></tr>`}</tbody></table>` }
}

export default function Relatorios() {
  const { empresaId, empresaNome, competencia, empresas } = useAppData()
  const cnpj = empresas?.find(e => e.id === empresaId)?.cnpj
  const [gerandoDom, setGerandoDom] = useState(false)
  const [aba, setAba] = useState('') // '' = nenhum relatório aberto na tela (os contábeis só geram PDF)
  const [cardsAberto, setCardsAberto] = useState(true) // recolher a lista de cards p/ dar espaço ao relatório
  const [modalContab, setModalContab] = useState(false) // painel "Relatórios Contábeis" (gerar individual/todos)
  const [selContab, setSelContab] = useState(() => new Set(CONTABEIS.filter(c => !c.emBreve).map(c => c.id)))
  const [gerandoContab, setGerandoContab] = useState('') // '' | 'todos' | id em geração

  // Relatórios COM CACHE: monta TODO o pacote (balancete, hierarquia, DRE, comparativo,
  // banco×resultado, distribuição, auditoria, pendências) uma vez e guarda por
  // (cliente·competência). Sai e volta e aparece na hora; só reprocessa se algum dado do
  // fechamento mudou (mesmo carimbo do Cockpit/Book). Todas as abas leem desse pacote.
  const { carregando, dados, semComp } = useRelatorio({
    tela: 'relatorios', empresaId, competencia,
    computar: async (cId) => {
      const [compRow, hier, concOk, balAud, ccPlano] = await Promise.all([
        supabase.from('competencias').select('documentos').eq('id', cId).maybeSingle(),
        // Balancete hierárquico (sintéticas + analíticas, com Saldo Anterior por arrasto).
        montarBalancete(empresaId, cId, 0, { comLancamentos: true }).then(r => r.linhas || []).catch(() => []),
        // Tick verde do Book: conciliação finalizada (nenhuma conta de Ativo/Passivo em aberto).
        contasConciliacaoAbertas(empresaId, cId).then(ab => ab.length === 0).catch(() => null),
        Promise.all([
          supabase.from('balancete').select('conta, nome, saldo_inicial, debito, credito, saldo_final').eq('competencia_id', cId).order('conta', { ascending: true }),
          supabase.from('auditoria').select('modulo, item, tipo, detalhe, dedutibilidade, usuario, created_at').eq('competencia_id', cId).order('created_at', { ascending: false }),
        ]),
        Promise.all([
          supabase.from('conciliacao_conta').select('conta, justificativa').eq('competencia_id', cId).eq('pendencia_cliente', true),
          supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]),
      ])
      const documentos = Array.isArray(compRow?.data?.documentos) ? compRow.data.documentos : []
      const [{ data: bal }, { data: aud }] = balAud
      const [{ data: cc }, { data: planoCarga }] = ccPlano
      const nomePorCod = Object.fromEntries(parsePlano(planoCarga?.dados).map(p => [p.reduzido, p.nome]))
      const concPend = (cc || []).map(r => ({ conta: r.conta, nome: nomePorCod[r.conta] || '', justificativa: r.justificativa || '' }))
      const dist = await apurarDistribuicao(empresaId, cId)
      const br = await apurarBancoResultado(empresaId, cId)
      const comparativo = await apurarVariacoes(empresaId, { comLancamentos: true })
      return { compId: cId, documentos, hier, concOk, linhas: bal || [], auditoria: aud || [], concPend, dist, br, comparativo }
    },
  })
  const temComp = semComp ? false : (dados ? true : null)
  const {
    compId = null, documentos = [], hier = [], concOk = null, linhas = [],
    auditoria = [], concPend = [], dist = null, br = null, comparativo = null,
  } = dados || {}


  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." />
      </Wrapper>
    )
  }

  const compSlug = competencia.replace('/', '-')

  // Totais do balancete: soma das ANALÍTICAS do balancete VIVO (hier, com lançamentos), para
  // bater SEMPRE com o corpo — as sintéticas são agregados e não entram na soma. Sem hier
  // (fallback), soma o balancete cru, que é o que o corpo mostra nesse caso.
  const totDeb = hier.length ? hier.reduce((s, l) => s + (l.folha ? (Number(l.debito) || 0) : 0), 0) : linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = hier.length ? hier.reduce((s, l) => s + (l.folha ? (Number(l.credito) || 0) : 0), 0) : linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)

  // DRE estruturada (Receita Bruta → Líquida → Lucro Bruto → EBITDA → LAIR → Lucro Líquido),
  // montada da hierarquia do balancete (mesma estrutura do Domínio).
  const dreRows = hier.length ? montarDRE(hier) : []
  const resumoBal = hier.length ? montarResumoBalancete(hier) : null

  // Balanço: Ativo (prefixo 1) × Passivo + PL (prefixo 2).
  const ativo = linhas.filter(l => String(l.conta || '').startsWith('1'))
  const passivo = linhas.filter(l => String(l.conta || '').startsWith('2'))
  const totAtivo = ativo.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const totPassivo = passivo.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)

  // Despesas indedutíveis (LALUR): justificativas com dedutibilidade indedutível.
  const indedutiveis = auditoria.filter(a => String(a.dedutibilidade || '').toLowerCase().startsWith('indedut'))
  // Contratos sem documento marcados como "cliente não enviou" (vão às pendências).
  const contratoPend = auditoria.filter(a => a.modulo === 'Contratos' && a.tipo === 'Pendência')
  // Pendências do cliente marcadas ao justificar (ex.: banco × resultado / conciliação).
  const despesaPend = auditoria.filter(a => a.modulo === 'Status' && a.tipo === 'Pendência')

  // Pendências: documentos não recebidos (rec === false).
  const pendencias = documentos.filter(d => d && d.rec === false)

  // Subtítulo padrão e atalho para gerar a planilha timbrada da Attentive.
  const subRel = `${empresaNome} · competência ${competencia}`
  const num = v => Number(v) || 0
  const xls = (titulo, colunas, args) => gerarExcelTimbrado({ titulo, sub: subRel, colunas, ...args })

  // Gera os relatórios contábeis selecionados como UM PDF único, na ordem do catálogo.
  // Pula os "em breve". `ids` = lista de ids a gerar (um, vários ou todos).
  async function gerarContabeis(ids) {
    const ordem = CONTABEIS.filter(c => !c.emBreve && ids.includes(c.id)).map(c => c.id)
    if (!ordem.length) return
    setGerandoContab(ordem.length > 1 ? 'todos' : ordem[0])
    try {
      const [mes, ano] = competencia.split('/').map(Number)
      const secoes = []
      for (const id of ordem) {
        if (id === 'financeiro') { const ck = compId ? await apurarCockpit(empresaId, compId, mes, ano) : null; secoes.push(secFinanceiro(ck)) }
        else if (id === 'balancete') secoes.push(secBalancete({ hier, linhas }))
        else if (id === 'dre') secoes.push(secDRE({ dreRows }))
        else if (id === 'balanco') secoes.push(secBalanco({ hier }))
        else if (id === 'comparativo') secoes.push(secComparativo(await dadosCompResultado(empresaId, ano)))
        else if (id === 'pendencias') secoes.push(secPendencias({ pendencias, concPend, contratoPend, despesaPend }))
      }
      abreRelatoriosContabeis({ empresa: empresaNome, cnpj, competencia, secoes })
    } finally {
      setGerandoContab('')
    }
  }
  const geraveisContab = CONTABEIS.filter(c => !c.emBreve).map(c => c.id)

  function exportarBalancete() {
    const base = hier.length ? hier : linhas.map(l => ({ reduzido: l.conta, classif: l.conta, nome: l.nome, saldo_inicial: l.saldo_inicial, debito: l.debito, credito: l.credito, saldo_final: l.saldo_final, sintetica: false }))
    xls('Balancete', [
      { nome: 'Conta', largura: 12 },
      { nome: 'Classificação', largura: 16 },
      { nome: 'Descrição da conta', largura: 42 },
      { nome: 'Saldo Anterior', alinhar: 'right', moeda: true },
      { nome: 'Débito', alinhar: 'right', moeda: true },
      { nome: 'Crédito', alinhar: 'right', moeda: true },
      { nome: 'Saldo Atual', alinhar: 'right', moeda: true },
    ], {
      linhas: base.map(l => [l.reduzido || '', l.classif || '', l.nome || '', num(l.saldo_inicial), num(l.debito), num(l.credito), num(l.saldo_final)]),
      totais: ['', '', 'TOTAIS', '', num(totDeb), num(totCred), ''],
      arquivo: `balancete_${compSlug}.xlsx`,
      aba: 'Balancete',
    })
  }

  // Gera o balancete no padrão Domínio (hierarquia via montarBalancete: sintéticas +
  // analíticas, com Saldo Anterior por arrasto). Abre o PDF com a cara do Domínio.
  async function gerarBalanceteDominioPDF() {
    if (!compId || gerandoDom) return
    setGerandoDom(true)
    try {
      const linhasHier = hier.length ? hier : (await montarBalancete(empresaId, compId, 0, { comLancamentos: true })).linhas
      const [mes, ano] = competencia.split('/').map(Number)
      const ult = new Date(ano, mes, 0).getDate()
      abreBalanceteDominio({
        empresa: empresaNome,
        cnpj: cnpj || '',
        periodoIni: `01/${String(mes).padStart(2, '0')}/${ano}`,
        periodoFim: `${String(ult).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`,
        linhas: linhasHier,
        resumo: (hier.length ? resumoBal : montarResumoBalancete(linhasHier)),
      })
    } finally {
      setGerandoDom(false)
    }
  }

  function exportarDRE() {
    xls('DRE — Demonstração do Resultado', [
      { nome: 'Descrição', largura: 44 },
      { nome: 'Valor', alinhar: 'right', moeda: true },
    ], {
      linhas: dreRows.map(r => [(r.sub ? '' : '   ') + r.label, num(r.valor)]),
      arquivo: `dre_${compSlug}.xlsx`,
      aba: 'DRE',
    })
  }

  // Gera a DRE no padrão Domínio (estrutura Receita Líquida/Lucro Bruto/EBITDA/LAIR/Lucro Líquido).
  function gerarDreDominioPDF() {
    if (!dreRows.length) return
    const [mes, ano] = competencia.split('/').map(Number)
    const ult = new Date(ano, mes, 0).getDate()
    const dd = `${String(ult).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`
    abreDreDominio({
      empresa: empresaNome,
      cnpj: cnpj || '',
      periodoIni: `01/${String(mes).padStart(2, '0')}/${ano}`,
      periodoFim: dd,
      dataFim: dd,
      rows: dreRows,
    })
  }

  function exportarPendencias() {
    xls('Relatório de Pendências', [
      { nome: 'Pendência', largura: 60, wrap: true },
      { nome: 'Origem / Categoria', largura: 34 },
    ], {
      linhas: [
        ...pendencias.map(d => [d.name, d.cat || 'Documento']),
        ...concPend.map(c => [`Conciliação · ${c.conta}${c.nome ? ' · ' + c.nome : ''}${c.justificativa ? ' — ' + c.justificativa : ''}`, 'Conciliação (saldo sem extrato)']),
        ...contratoPend.map(a => [`${a.item}${a.detalhe ? ' — ' + a.detalhe : ''}`, 'Contrato (cliente não enviou)']),
        ...despesaPend.map(a => [`${a.item}${a.detalhe ? ' — ' + a.detalhe : ''}`, 'Pendência do cliente (justificativa)']),
      ],
      arquivo: `pendencias_${compSlug}.xlsx`,
      aba: 'Pendências',
    })
  }

  // Carta de pendências apresentável para enviar ao cliente (PDF timbrado): texto de
  // abertura, relação dos itens pendentes agrupados por origem e o reforço da importância
  // de enviar a documentação para o fechamento ficar completo.
  function gerarCartaPendencias() {
    // A carta traz as pendências EXATAMENTE como estão escritas no relatório interno
    // (inclusive as justificativas), para o time revisar/ajustar a redação depois.
    const grupos = [
      { titulo: 'Documentos não recebidos', itens: pendencias.map(d => `${d.name}${d.cat ? ` (${d.cat})` : ''}`) },
      { titulo: 'Conciliação — saldos sem documento', itens: concPend.map(c => `Conciliação · ${c.conta}${c.nome ? ` · ${c.nome}` : ''}${c.justificativa ? ` — ${c.justificativa}` : ''}`) },
      { titulo: 'Contratos pendentes de envio', itens: contratoPend.map(a => `${a.item}${a.detalhe ? ` — ${a.detalhe}` : ''}`) },
      { titulo: 'Outras pendências do cliente', itens: despesaPend.map(a => `${a.item}${a.detalhe ? ` — ${a.detalhe}` : ''}`) },
    ]
    const [mes, ano] = competencia.split('/').map(Number)
    const nomesMes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    abreCartaPendencias({
      empresa: empresaNome,
      cnpj: cnpj || '',
      competencia,
      competenciaExtenso: `${nomesMes[mes - 1] || competencia} de ${ano}`,
      dataHoje: hoje,
      grupos,
    })
  }

  function exportarAuditoria() {
    xls('Justificativas e correções do fechamento', [
      { nome: 'Módulo', largura: 16 },
      { nome: 'Item', largura: 26 },
      { nome: 'Tipo', largura: 16 },
      { nome: 'Detalhe', largura: 50, wrap: true },
      { nome: 'Dedutibilidade', largura: 18 },
      { nome: 'Usuário', largura: 22 },
      { nome: 'Data', largura: 18 },
    ], {
      linhas: auditoria.map(a => [a.modulo, a.item, a.tipo, a.detalhe, a.dedutibilidade, a.usuario, dataPtBR(a.created_at)]),
      arquivo: `auditoria_${compSlug}.xlsx`,
      aba: 'Auditoria',
    })
  }

  function exportarBancoResult() {
    xls('Banco × Resultado', [
      { nome: 'Data', largura: 14 },
      { nome: 'Banco', largura: 24 },
      { nome: 'Conta resultado', largura: 28 },
      { nome: 'Valor', alinhar: 'right', moeda: true },
      { nome: 'Despesa (LALUR)', largura: 16 },
      { nome: 'Histórico', largura: 50, wrap: true },
    ], {
      linhas: (br?.lancamentos || []).map(l => [
        l.data ? l.data.split('-').reverse().join('/') : '', l.banco, l.resultado, num(l.valor), l.despesa ? 'Sim' : 'Não', l.historico,
      ]),
      arquivo: `banco_x_resultado_${compSlug}.xlsx`,
      aba: 'Banco x Resultado',
    })
  }

  function exportarDistribuicao() {
    xls('Distribuição de lucros · IRRF 2026', [
      { nome: 'Sócio', largura: 30 },
      { nome: 'Identificação', largura: 22 },
      { nome: 'Total recebido', alinhar: 'right', moeda: true },
      { nome: 'Limite', alinhar: 'right', moeda: true },
      { nome: 'Acima do limite', largura: 16 },
      { nome: 'IRRF estimado', alinhar: 'right', moeda: true },
    ], {
      linhas: (dist?.socios || []).map(s => [s.nome, s.ident, num(s.total), num(dist.limite), s.excede ? 'Sim' : 'Não', num(s.irrf)]),
      arquivo: `distribuicao_lucros_${compSlug}.xlsx`,
      aba: 'Distribuição',
    })
  }

  function exportarBalanco() {
    const colMoeda = { alinhar: 'right', moeda: true }
    xls('Balanço Patrimonial', [
      { nome: 'Conta', largura: 14 },
      { nome: 'Nome', largura: 46 },
      { nome: 'Saldo final', ...colMoeda },
    ], {
      secoes: [
        { titulo: 'Ativo', linhas: ativo.map(l => [l.conta, l.nome, num(l.saldo_final)]), totais: ['', 'TOTAL ATIVO', num(totAtivo)] },
        { titulo: 'Passivo + Patrimônio Líquido', linhas: passivo.map(l => [l.conta, l.nome, num(l.saldo_final)]), totais: ['', 'TOTAL PASSIVO + PL', num(totPassivo)] },
      ],
      arquivo: `balanco_${compSlug}.xlsx`,
      aba: 'Balanço',
    })
  }

  function exportarComparativo() {
    const meses = comparativo?.meses || []
    xls('Comparativo de Movimento · 2026', [
      { nome: 'Conta', largura: 12 },
      { nome: 'Nome', largura: 38 },
      ...meses.map(m => ({ nome: MESES[m - 1], alinhar: 'right', moeda: true })),
    ], {
      linhas: (comparativo?.contas || []).map(c => [c.conta, c.nome, ...meses.map(m => {
        const v = comparativo.matriz[c.conta]?.[m]; return v == null ? '' : num(v)
      })]),
      arquivo: 'comparativo_2026.xlsx',
      aba: 'Comparativo',
    })
  }

  function exportarIndedutiveis() {
    xls('Despesas indedutíveis (LALUR)', [
      { nome: 'Item', largura: 30 },
      { nome: 'Detalhe', largura: 56, wrap: true },
      { nome: 'Usuário', largura: 22 },
      { nome: 'Data', largura: 18 },
    ], {
      linhas: indedutiveis.map(a => [a.item, a.detalhe, a.usuario, dataPtBR(a.created_at)]),
      arquivo: `indedutiveis_lalur_${compSlug}.xlsx`,
      aba: 'Indedutíveis',
    })
  }

  const semBalancete = !carregando && temComp && linhas.length === 0
  // Relatórios que dependem só do balancete.
  const dependeBalancete = aba === 'balancete' || aba === 'dre' || aba === 'balanco'

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Barra: seletor compacto (quando recolhido) + botão recolher/expandir */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: cardsAberto ? 12 : 18 }}>
        {!cardsAberto && (
          <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-report" /> Relatório:
            <select className="input" style={{ width: 'auto', fontSize: 13, padding: '6px 10px' }} value={aba} onChange={e => setAba(e.target.value)}>
              {RELATORIOS.filter(r => !CONTAB_NA_LISTA.has(r.id)).map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}
            </select>
          </label>
        )}
        <button className="btn-ghost" onClick={() => setCardsAberto(v => !v)}
          title={cardsAberto ? 'Recolher a lista para ver o relatório maior' : 'Mostrar a lista de relatórios'}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '6px 12px' }}>
          <i className={`ti ${cardsAberto ? 'ti-chevrons-up' : 'ti-chevrons-down'}`} /> {cardsAberto ? 'Recolher lista' : 'Expandir lista'}
        </button>
      </div>

      {/* Cards de relatório (escolha) */}
      {cardsAberto && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12, marginBottom: 22 }}>
        {/* Card ÚNICO — Relatórios Contábeis (abre o painel de geração) */}
        <button onClick={() => setModalContab(true)}
          style={{ gridColumn: '1 / -1', textAlign: 'left', background: `linear-gradient(180deg, rgba(74,124,255,0.10), transparent), ${theme.card}`, border: `1px solid ${theme.accent}`, borderRadius: 14, padding: '18px 20px', cursor: 'pointer', display: 'flex', gap: 15, alignItems: 'center' }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(74,124,255,0.14)', color: theme.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <i className="ti ti-file-stack" style={{ fontSize: 24 }} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Relatórios Contábeis</div>
            <div style={{ fontSize: 12.5, color: theme.sub, marginTop: 3 }}>Financeiro, Balancete, DRE, DFC, Balanço, Comparativo e Pendências — gere cada um ou <b style={{ color: theme.text }}>todos num PDF único</b>.</div>
          </div>
          <span className="btn" style={{ background: theme.accent, borderColor: theme.accent, color: '#fff', fontSize: 13, padding: '9px 15px', display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }}>
            <i className="ti ti-arrow-right" /> Abrir
          </span>
        </button>

        {/* Demais relatórios (Book e especiais) seguem como cards próprios */}
        {RELATORIOS.filter(r => !CONTAB_NA_LISTA.has(r.id)).map(r => (
          <button
            key={r.id}
            onClick={() => setAba(r.id)}
            style={{
              textAlign: 'left',
              background: aba === r.id ? theme.input : theme.card,
              border: `1px solid ${aba === r.id ? theme.accent : theme.cb}`,
              borderRadius: 12,
              padding: 16,
              cursor: 'pointer',
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <i className={`ti ${r.icon}`} style={{ fontSize: 20, color: theme.accent, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.text, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                {r.nome}
                {r.id === 'book' && concOk !== null && (
                  <i className={`ti ${concOk ? 'ti-circle-check-filled' : 'ti-circle-dashed'}`}
                    title={concOk ? 'Conciliação finalizada — book pronto' : 'Conclua a conciliação para liberar o book'}
                    style={{ fontSize: 16, color: concOk ? theme.green : theme.sub }} />
                )}
              </div>
              <div style={{ fontSize: 12, color: theme.sub, lineHeight: 1.4 }}>{r.desc}</div>
            </div>
          </button>
        ))}
      </div>
      )}

      {modalContab && (
        <ModalRelatoriosContabeis
          sel={selContab} setSel={setSelContab} geraveis={geraveisContab}
          gerando={gerandoContab} onGerar={gerarContabeis} onClose={() => setModalContab(false)}
        />
      )}

      {carregando && <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>}

      {temComp === false && (
        <Aviso icon="ti-file-import" texto="Importe o razão primeiro." />
      )}

      {/* Aviso de balancete vazio só afeta os relatórios que dependem dele. */}
      {semBalancete && dependeBalancete && (
        <Aviso icon="ti-database-off" texto="Sem dados no balancete desta competência. Importe o razão primeiro." />
      )}

      {/* Balancete */}
      {!carregando && temComp && linhas.length > 0 && aba === 'balancete' && (
        <Secao titulo="Balancete" onExportar={exportarBalancete}>
          <div style={{ marginBottom: 12 }}>
            <button className="btn" onClick={gerarBalanceteDominioPDF} disabled={!compId || gerandoDom}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: gerandoDom ? .6 : 1 }}>
              <i className={`ti ${gerandoDom ? 'ti-loader-2' : 'ti-file-type-pdf'}`} /> {gerandoDom ? 'Gerando…' : 'Gerar balancete (padrão Domínio)'}
            </button>
            <span style={{ marginLeft: 10, fontSize: 12, color: theme.sub }}>PDF com a mesma cara do relatório do Domínio (hierarquia, D/C, Saldo Anterior por arrasto).</span>
          </div>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
            {hier.length === 0 ? (
              <p style={{ color: theme.sub, fontSize: 13, padding: 16 }}>Montando a estrutura do balancete…</p>
            ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Conta</th>
                  <th style={th}>Classificação</th>
                  <th style={th}>Descrição da conta</th>
                  <th style={thNum}>Saldo Anterior</th>
                  <th style={thNum}>Débito</th>
                  <th style={thNum}>Crédito</th>
                  <th style={thNum}>Saldo Atual</th>
                </tr>
              </thead>
              <tbody>
                {hier.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: l.sintetica ? theme.input : 'transparent', fontWeight: l.sintetica ? 700 : 400 }}>
                    <td style={{ ...td, color: theme.sub }}>{l.reduzido || ''}</td>
                    <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{l.classif}</td>
                    <td style={{ ...td, fontWeight: l.sintetica ? 700 : 400, paddingLeft: 14 + Math.max(0, (l.grau || 1) - 1) * 14 }}>{l.nome || '—'}</td>
                    <td style={tdNum}>{moneyDC(l.saldo_inicial)}</td>
                    <td style={tdNum}>{money(l.debito)}</td>
                    <td style={tdNum}>{money(l.credito)}</td>
                    <td style={tdNum}>{moneyDC(l.saldo_final)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={4}>Totais</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(totDeb)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(totCred)}</td>
                  <td style={tdNum}></td>
                </tr>
              </tfoot>
            </table>
            )}
          </div>
          {resumoBal && <ResumoBalancete r={resumoBal} />}
        </Secao>
      )}

      {/* DRE estruturada (modelo do sistema / Domínio) */}
      {!carregando && temComp && linhas.length > 0 && aba === 'dre' && (
        <Secao titulo="DRE — Demonstração do Resultado" onExportar={dreRows.length ? exportarDRE : null}>
          <div style={{ marginBottom: 12 }}>
            <button className="btn" onClick={gerarDreDominioPDF} disabled={!dreRows.length}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-file-type-pdf" /> Gerar DRE (padrão Domínio)
            </button>
            <span style={{ marginLeft: 10, fontSize: 12, color: theme.sub }}>PDF no modelo do Domínio (Receita Líquida, Lucro Bruto, EBITDA, LAIR, Lucro Líquido).</span>
          </div>
          {hier.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13 }}>Montando a DRE…</p>
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '8px 0', maxWidth: 640 }}>
              {dreRows.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
                  padding: r.sub ? '11px 22px' : '7px 22px',
                  borderTop: r.sub ? `1px solid ${theme.border}` : 'none',
                  background: r.sub ? theme.input : 'transparent',
                }}>
                  <span style={{ fontSize: r.sub ? 13.5 : 13, fontWeight: r.sub ? 700 : 400, color: r.sub ? theme.text : theme.sub, paddingLeft: r.sub ? 0 : 12 }}>{r.label}</span>
                  <span style={{ fontSize: r.sub ? 14.5 : 13, fontWeight: r.sub ? 800 : 500, fontVariantNumeric: 'tabular-nums', color: r.valor < 0 ? theme.red : (r.sub ? theme.text : theme.text) }}>
                    {r.valor < 0 ? `(${money(Math.abs(r.valor)).replace('R$', 'R$ ').trim()})` : money(r.valor)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Secao>
      )}

      {/* Book de Composições (auditoria) — componente próprio, carrega sob demanda */}
      {aba === 'book' && (
        <>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>Book de Composições</h2>
          <BookComposicoes empresaId={empresaId} empresaNome={empresaNome} competencia={competencia} cnpj={cnpj} />
        </>
      )}

      {/* Balanço Patrimonial */}
      {!carregando && temComp && linhas.length > 0 && aba === 'balanco' && (
        <Secao titulo="Balanço Patrimonial" onExportar={exportarBalanco}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            <GrupoBalanco titulo="Ativo" contas={ativo} total={totAtivo} />
            <GrupoBalanco titulo="Passivo + Patrimônio Líquido" contas={passivo} total={totPassivo} />
          </div>
        </Secao>
      )}

      {/* Comparativo de Movimento */}
      {aba === 'comparativo' && (
        <>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>Comparativo de Movimento</h2>
          <ComparativoCompleto empresaId={empresaId} empresaNome={empresaNome} competencia={competencia} cnpj={cnpj} />
        </>
      )}

      {/* Despesas indedutíveis (LALUR) */}
      {!carregando && temComp && aba === 'indedutiveis' && (
        <Secao titulo="Despesas indedutíveis (LALUR)" onExportar={indedutiveis.length ? exportarIndedutiveis : null}>
          {indedutiveis.length === 0 ? (
            <Aviso icon="ti-receipt" texto="Nenhuma despesa classificada como indedutível. Classifique no Status → Banco × resultado (justificar despesa)." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Item</th><th style={th}>Detalhe</th><th style={th}>Usuário</th><th style={th}>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {indedutiveis.map((a, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{a.item || '—'}</td>
                      <td style={{ ...td, maxWidth: 320, whiteSpace: 'normal' }}>{a.detalhe || '—'}</td>
                      <td style={td}>{a.usuario || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dataPtBR(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Relatório de Pendências */}
      {!carregando && temComp && aba === 'pendencias' && (
        <Secao titulo="Relatório de Pendências" onExportar={(pendencias.length || concPend.length || contratoPend.length || despesaPend.length) ? exportarPendencias : null}
          acoes={<button className="btn-ghost" onClick={gerarCartaPendencias}
            title="Gera uma carta timbrada, pronta para enviar ao cliente, com a relação das pendências"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-mail" /> Carta ao cliente
          </button>}>
          {pendencias.length === 0 && concPend.length === 0 && contratoPend.length === 0 && despesaPend.length === 0 ? (
            <Aviso icon="ti-circle-check" texto="Nenhuma pendência nesta competência." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Pendência</th>
                    <th style={th}>Origem / Categoria</th>
                  </tr>
                </thead>
                <tbody>
                  {pendencias.map((d, i) => (
                    <tr key={`doc${i}`} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{d.name || '—'}</td>
                      <td style={td}>{d.cat || 'Documento'}</td>
                    </tr>
                  ))}
                  {concPend.map((c, i) => (
                    <tr key={`conc${i}`} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>Conciliação · {c.conta}{c.nome ? ` · ${c.nome}` : ''}{c.justificativa ? ` — ${c.justificativa}` : ''}</td>
                      <td style={td}>Conciliação (saldo sem extrato)</td>
                    </tr>
                  ))}
                  {contratoPend.map((a, i) => (
                    <tr key={`contr${i}`} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{a.item}{a.detalhe ? ` — ${a.detalhe}` : ''}</td>
                      <td style={td}>Contrato (cliente não enviou)</td>
                    </tr>
                  ))}
                  {despesaPend.map((a, i) => (
                    <tr key={`desp${i}`} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{a.item}{a.detalhe ? ` — ${a.detalhe}` : ''}</td>
                      <td style={td}>Pendência do cliente (justificativa)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Banco × Resultado */}
      {!carregando && temComp && aba === 'bancoresult' && (
        <Secao titulo="Banco × Resultado" onExportar={br?.lancamentos?.length ? exportarBancoResult : null}>
          {!br?.temCarga ? (
            <Aviso icon="ti-settings" texto="Importe a amarração banco × resultado em Base de Informações." />
          ) : br.lancamentos.length === 0 ? (
            <Aviso icon="ti-circle-check" texto="Nenhum lançamento de banco direto em resultado não liberado." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 700, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Data</th><th style={th}>Banco</th><th style={th}>Conta resultado</th>
                    <th style={thNum}>Valor</th><th style={th}>LALUR</th><th style={th}>Histórico</th>
                  </tr>
                </thead>
                <tbody>
                  {br.lancamentos.map((l, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : ''}</td>
                      <td style={td}>{l.banco}</td>
                      <td style={td}>{l.resultado}</td>
                      <td style={tdNum}>{money(l.valor)}</td>
                      <td style={td}>{l.despesa ? <span style={{ color: theme.yellow }}>despesa</span> : '—'}</td>
                      <td style={{ ...td, maxWidth: 280, whiteSpace: 'normal' }}>{l.historico}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Distribuição de lucros */}
      {!carregando && temComp && aba === 'distribuicao' && (
        <Secao titulo="Distribuição de lucros · IRRF 2026" onExportar={dist?.socios?.length ? exportarDistribuicao : null}>
          {!dist?.temConfig ? (
            <Aviso icon="ti-settings" texto="Configure limite, alíquota e sócios em Base de Informações → Distribuição de lucros." />
          ) : !dist.socios.length ? (
            <Aviso icon="ti-users" texto="Nenhum sócio configurado. Adicione os sócios na Base de Informações." />
          ) : (
            <>
              <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>
                Limite mensal: <b style={{ color: theme.text }}>{money(dist.limite)}</b> · Alíquota IRRF: <b style={{ color: theme.text }}>{dist.aliquota}%</b>. Estimativa para revisão humana.
              </p>
              <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: theme.input }}>
                      <th style={th}>Sócio</th>
                      <th style={thNum}>Total recebido</th>
                      <th style={th}>Situação</th>
                      <th style={thNum}>IRRF estimado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dist.socios.map((s, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                        <td style={td}>{s.nome}</td>
                        <td style={tdNum}>{money(s.total)}</td>
                        <td style={{ ...td, color: s.excede ? theme.red : theme.green }}>{s.excede ? 'Acima do limite' : 'Dentro do limite'}</td>
                        <td style={{ ...tdNum, color: s.excede ? theme.red : theme.sub, fontWeight: s.excede ? 700 : 400 }}>{money(s.irrf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Secao>
      )}

      {/* Justificativas e correções (auditoria) */}
      {!carregando && temComp && aba === 'auditoria' && (
        <Secao titulo="Justificativas e correções do fechamento" onExportar={auditoria.length ? exportarAuditoria : null}>
          {auditoria.length === 0 ? (
            <Aviso icon="ti-clipboard-off" texto="Nenhuma justificativa ou correção registrada nesta competência." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Módulo</th>
                    <th style={th}>Item</th>
                    <th style={th}>Tipo</th>
                    <th style={th}>Detalhe</th>
                    <th style={th}>Usuário</th>
                    <th style={th}>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {auditoria.map((a, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{a.modulo || '—'}</td>
                      <td style={td}>{a.item || '—'}</td>
                      <td style={td}>{a.tipo || '—'}</td>
                      <td style={{ ...td, maxWidth: 360, whiteSpace: 'normal' }}>{a.detalhe || '—'}</td>
                      <td style={td}>{a.usuario || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dataPtBR(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

// Painel "Relatórios Contábeis": lista os relatórios, gera cada um (PDF) ou todos os
// selecionados num PDF único. Os "em breve" (DFC, Comparativo) ficam desabilitados.
function ModalRelatoriosContabeis({ sel, setSel, geraveis, gerando, onGerar, onClose }) {
  const toggle = id => setSel(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const nSel = geraveis.filter(id => sel.has(id)).length
  const todosMarcados = nSel === geraveis.length
  const setTodos = () => setSel(todosMarcados ? new Set() : new Set(geraveis))
  const busy = !!gerando
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 95 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(600px,96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: `1px solid ${theme.border}` }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 3px', display: 'flex', alignItems: 'center', gap: 9 }}><i className="ti ti-file-stack" style={{ color: theme.accent }} /> Relatórios Contábeis</h3>
          <div style={{ fontSize: 12, color: theme.sub }}>Gere cada relatório ou marque vários e gere <b style={{ color: theme.text }}>um PDF único</b> (na ordem da lista).</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 20px', borderBottom: `1px solid ${theme.border}`, background: theme.input, fontSize: 12.5, color: theme.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={todosMarcados} ref={el => { if (el) el.indeterminate = nSel > 0 && !todosMarcados }} onChange={setTodos} style={{ width: 16, height: 16, cursor: 'pointer' }} /> Selecionar todos
        </label>
        <div style={{ overflow: 'auto', padding: '4px 10px' }}>
          {CONTABEIS.map((c, i) => {
            const disabled = !!c.emBreve
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderTop: i ? `1px solid ${theme.border}` : 'none', opacity: disabled ? 0.55 : 1 }}>
                <input type="checkbox" disabled={disabled} checked={!disabled && sel.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16, cursor: disabled ? 'not-allowed' : 'pointer', flex: 'none' }} />
                <span style={{ width: 20, textAlign: 'center', fontSize: 11, fontWeight: 700, color: theme.sub, flex: 'none' }}>{i + 1}</span>
                <i className={`ti ${c.icon}`} style={{ fontSize: 18, color: theme.accent, flex: 'none' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, display: 'flex', alignItems: 'center', gap: 7 }}>
                    {c.nome}
                    {c.novo && <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .4, color: theme.green, background: 'rgba(48,164,108,.16)', borderRadius: 20, padding: '2px 7px' }}>novo</span>}
                    {c.emBreve && <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .4, color: theme.yellow, background: 'rgba(245,166,35,.16)', borderRadius: 20, padding: '2px 7px' }}>em breve</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: theme.sub, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.desc}</div>
                </div>
                <button className="btn-ghost" disabled={disabled || busy} onClick={() => onGerar([c.id])}
                  style={{ fontSize: 12, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', opacity: (disabled || busy) ? 0.5 : 1, cursor: (disabled || busy) ? 'not-allowed' : 'pointer' }}>
                  <i className={`ti ${gerando === c.id ? 'ti-loader-2' : 'ti-download'}`} /> Gerar
                </button>
              </div>
            )
          })}
        </div>
        <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11.5, color: theme.sub, maxWidth: 300 }}>Ordem: <b style={{ color: theme.text }}>Financeiro → Balancete → DRE → DFC → Balanço → Comparativo → Pendências</b>.</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-ghost" onClick={onClose} style={{ fontSize: 12.5, padding: '9px 14px' }}>Fechar</button>
            <button className="btn" disabled={nSel === 0 || busy} onClick={() => onGerar([...sel])}
              style={{ fontSize: 13.5, fontWeight: 700, padding: '10px 18px', display: 'inline-flex', alignItems: 'center', gap: 9, opacity: (nSel === 0 || busy) ? 0.5 : 1, cursor: (nSel === 0 || busy) ? 'not-allowed' : 'pointer' }}>
              <i className={`ti ${gerando === 'todos' ? 'ti-loader-2' : 'ti-file-download'}`} /> {gerando === 'todos' ? 'Gerando…' : `Gerar ${todosMarcados ? 'todos' : `selecionados (${nSel})`} · PDF único`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Cabeçalho de seção com botões Excel (.xlsx timbrado) e PDF (window.print).
// `acoes` = botões extras (ex.: "Carta ao cliente") mostrados antes do Excel.
function Secao({ titulo, onExportar, acoes, children }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{titulo}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {acoes}
          <button
            className="btn-ghost"
            onClick={() => onExportar && onExportar()}
            disabled={!onExportar}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: onExportar ? 1 : .5, cursor: onExportar ? 'pointer' : 'not-allowed' }}
          >
            <i className="ti ti-file-spreadsheet" /> Excel
          </button>
          <button
            className="btn-ghost"
            onClick={() => window.print()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <i className="ti ti-file-type-pdf" /> PDF
          </button>
        </div>
      </div>
      {children}
    </>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Relatórios</h1>
        <InfoTela titulo="Relatórios">A saída do fechamento: Book de Composições, DRE, Comparativo, Balanço, DFC, Balancete e Justificativas/Correções. Todos leem o <b>razão vivo</b>.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Relatórios da competência (a partir do balancete e da auditoria).</p>
      {children}
    </div>
  )
}

function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}

function LinhaDRE({ label, valor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, color: theme.sub }}>{label}</span>
      <span style={{ fontSize: 14, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>{valor}</span>
    </div>
  )
}

// Resumo do balancete (nosso modelo): grupos + contas devedoras/credoras + resultado.
function ResumoBalancete({ r }) {
  const linha = (x, forte, key) => (
    <tr key={key} style={{ borderTop: `1px solid ${theme.border}`, background: forte ? theme.input : 'transparent', fontWeight: forte ? 700 : 400 }}>
      <td style={{ ...td, fontWeight: forte ? 700 : 500 }}>{x.label}</td>
      <td style={tdNum}>{moneyDC(x.ini)}</td>
      <td style={tdNum}>{money(x.deb)}</td>
      <td style={tdNum}>{money(x.cred)}</td>
      <td style={tdNum}>{moneyDC(x.fim)}</td>
    </tr>
  )
  const gap = k => <tr key={k}><td colSpan={5} style={{ height: 10 }}></td></tr>
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: theme.sub, margin: '0 0 8px' }}>Resumo do Balancete</h3>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Grupo</th><th style={thNum}>Saldo Anterior</th><th style={thNum}>Débito</th><th style={thNum}>Crédito</th><th style={thNum}>Saldo Atual</th>
            </tr>
          </thead>
          <tbody>
            {r.grupos.map((g, i) => linha(g, false, 'g' + i))}
            {gap('gap1')}
            {linha(r.devedoras, true, 'dev')}
            {linha(r.credoras, true, 'cred')}
            {gap('gap2')}
            {linha(r.resultadoMes, true, 'rmes')}
            {linha(r.resultadoExerc, true, 'rex')}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GrupoBalanco({ titulo, contas, total }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
      <p style={{ fontSize: 14, fontWeight: 600, padding: '14px 16px', margin: 0, borderBottom: `1px solid ${theme.border}` }}>{titulo}</p>
      {contas.length === 0 ? (
        <p style={{ color: theme.sub, fontSize: 12.5, padding: 16 }}>Sem contas neste grupo.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {contas.map((l, i) => (
              <tr key={i} style={{ borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                <td style={td}><span style={{ color: theme.sub, fontSize: 11 }}>{l.conta}</span> {l.nome || ''}</td>
                <td style={tdNum}>{money(l.saldo_final)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
              <td style={{ ...td, fontWeight: 700 }}>Total</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{money(total)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}
