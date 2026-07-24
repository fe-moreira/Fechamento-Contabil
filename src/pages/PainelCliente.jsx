import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { lerTudo } from '../lib/lerTudo'
import { useAppData, useRelatorio } from '../lib/appData'
import { apurarVariacoes } from '../lib/variacoes'
import { apurarDistribuicao } from '../lib/distribuicao'
import { montarBalancete } from '../lib/balancete'
import { extrairEntidade } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { theme, money } from '../lib/theme'
import InfoTela from '../components/InfoTela'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const pct = (a, b) => (b ? (a / b) * 100 : null)
// "Principais clientes" sai do histórico das NFs de receita. Alguns lançamentos de receita
// (rendimento de aplicação) trazem o BANCO no histórico, e o texto às vezes deixa só uma
// palavra genérica ("VALOR"). Esses NÃO são clientes — filtra banco e ruído.
const BANCO_RE = /\bBANCO\b|SANTANDER|ITA[UÚ]|BRADESCO|\bCAIXA\b|SICOOB|SICREDI|\bINTER\b|NUBANK|\bBTG\b|SAFRA|DAYCOVAL|VOTORANTIM|PAGSEGURO|MERCADO ?PAGO|\bC6\b|BANRISUL|\bBB\b/i
const LIXO_ENT = new Set(['VALOR', 'VALORES', 'RENDIMENTO', 'RENDIMENTOS', 'APLICACAO', 'APLICACOES', 'JUROS', 'SALDO', 'RESGATE', 'CDB', 'POUPANCA', 'TARIFA', 'TARIFAS', 'IOF', 'RECEITA', 'RECEITAS', 'FINANCEIRA', 'FINANCEIRAS', 'DIVERSOS', 'DIVERSAS', 'CLIENTE', 'CLIENTES', 'DEPOSITO', 'TRANSFERENCIA', 'TED', 'PIX', 'DOC'])
const ehCliente = ent => { const n = String(ent || '').trim().toUpperCase(); return !!n && !BANCO_RE.test(n) && !LIXO_ENT.has(n) }
const fmtPct = p => p == null ? '—' : `${p.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
const LARANJA = '#E5894D'
// Lucro verde, prejuízo vermelho.
const corResultado = v => (Number(v) || 0) >= 0 ? theme.green : theme.red

// Formata CNPJ 00.000.000/0000-00 (aceita já formatado).
function fmtCnpj(c) {
  const s = String(c || '').replace(/\D/g, '')
  if (s.length !== 14) return c || '—'
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`
}

// Palavras de nome de conta que identificam cada grupo (heurística sobre o balancete).
const RE_IMPOSTO = /impost|tribut|\bicms\b|\bpis\b|cofins|\birpj\b|\bcsll\b|\biss\b|simples|\bdas\b|inss|fgts|contrib/i
const RE_RECEBER = /client|duplicat.*receb|\ba\s*receber|receb.*client|cart[aã]o/i
const RE_PAGAR = /fornec|\ba\s*pagar|duplicat.*pag|obrig.*pag/i
const RE_DISP = /\bcaixa\b|banc|aplica|dispon|financeir|conta\s*corrente/i

export default function PainelCliente() {
  const { empresaId, empresaNome, competencia, empresas, plano } = useAppData()
  const empresa = empresas.find(e => e.id === empresaId)
  const compSlug = competencia.replace('/', '-')

  // Cockpit COM CACHE: sai e volta da tela e aparece a última versão na hora; só reprocessa
  // se algum dado do fechamento mudou (o carimbo de versaoRelatorio detecta). Fonte VIVA
  // (razão + lançamentos confirmados) — mesma base da Conciliação e do Comparativo.
  const { carregando, dados: d, semComp } = useRelatorio({
    tela: 'cockpit', empresaId, competencia, extraDep: plano,
    computar: async (compId, { mes, ano }) => {
        // Balancete hierárquico VIVO (razão + lançamentos confirmados) — MESMA fonte da
        // Conciliação e do resultado abaixo, para o ativo bater com a Conciliação e a identidade
        // fechar: Ativo − (Passivo + PL) = Resultado acumulado. As correções (ex.: estorno de
        // rendimento lançado em dobro) entram nos dois lados, mantendo tudo consistente.
        const { linhas: hier } = await montarBalancete(empresaId, compId, 0, { comLancamentos: true })
        const analit = (hier || []).filter(l => !l.sintetica)
        const g = l => String(l.classifRaw || '')[0] // grupo pela CLASSIFICAÇÃO (não pelo reduzido)

        const comparativo = await apurarVariacoes(empresaId, { comLancamentos: true }) // só p/ o gate de variações
        const dist = await apurarDistribuicao(empresaId, compId, ano, mes)

        // --- Receita / Custo / Despesa / Resultado — VIVO (com as correções) ---
        // Soma por GRUPO (líquido) a partir do balancete VIVO (razão + lançamentos confirmados),
        // MESMA fonte do balanço acima e da Conciliação: receita = grupo 3 (credor), custo = grupo 4,
        // despesa = grupo 5 (LÍQUIDO — rendimentos financeiros do 5.5, credores, compensam as
        // despesas dentro do próprio grupo 5). Assim as correções que ainda não subiram ao Comparativo
        // (ex.: estorno de rendimento lançado em dobro) já entram aqui e a identidade fecha:
        // Ativo − (Passivo + PL) = Resultado acumulado.
        const { data: compsAno } = await supabase.from('competencias').select('id, mes')
          .eq('cliente_id', empresaId).eq('ano', ano).order('mes', { ascending: true })
        const porMes = {}, meses = []
        for (const c of (compsAno || [])) {
          const linhasC = c.id === compId ? hier : (await montarBalancete(empresaId, c.id, 0, { comLancamentos: true })).linhas // vivo (com correções)
          const res = (linhasC || []).filter(l => !l.sintetica && ['3', '4', '5'].includes(String(l.classifRaw || '')[0]))
          if (!res.length) continue
          let g3 = 0, g4 = 0, g5 = 0
          for (const l of res) {
            const sf = Number(l.saldo_final) || 0
            const grp = String(l.classifRaw || '')[0]
            if (grp === '3') g3 += sf; else if (grp === '4') g4 += sf; else g5 += sf
          }
          const receita = -g3, custo = g4, despesa = g5 // grupo 3 credor → receita positiva; 4/5 devedores
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

        // Gráfico de desempenho (combo): usa a MESMA base do painel (grupos por 1º dígito —
        // 3 = receita, 4 = custo, 5 = despesa), e não o montarDRE detalhado (que assume a
        // estrutura do Domínio 31/43/51… e, num plano simples, perde o custo/despesa e faz
        // EBITDA e Lucro darem iguais à Receita — margem 100%).
        //   Receita Líquida = receita (grupo 3)
        //   EBITDA (resultado operacional) = receita − custo (grupo 3 − grupo 4)
        //   Lucro Líquido = receita − custo − despesa (grupo 3 − 4 − 5)
        const serieCombo = meses.map(m => {
          const p = porMes[m] || { receita: 0, custo: 0, despesa: 0, resultado: 0 }
          const receitaLiq = p.receita, ebitda = p.receita - p.custo, lucroLiq = p.resultado
          return {
            mes: m, rotulo: MESES[m - 1], receitaLiq, ebitda, lucroLiq,
            margemEbitda: receitaLiq ? (ebitda / receitaLiq) * 100 : 0,
            margemLiquida: receitaLiq ? (lucroLiq / receitaLiq) * 100 : 0,
          }
        })

        // Nível 1 resumido do mês da competência.
        const faturamento = receitaMes(mes)
        const custo = custoMes(mes)
        const despesa = despesaMes(mes)
        const lucro = resultado

        // --- Balanço: saldo_final = última coluna da conciliação ---
        const ativoLinhas = analit.filter(l => g(l) === '1')
        const passivoLinhas = analit.filter(l => g(l) === '2')
        const totAtivo = ativoLinhas.reduce((s, l) => s + num(l.saldo_final), 0)
        const totPassivo = passivoLinhas.reduce((s, l) => s + num(l.saldo_final), 0)
        const somaFiltro = (arr, re) => arr.filter(l => re.test(l.nome || ''))
          .reduce((s, l) => s + Math.abs(num(l.saldo_final)), 0)
        const clientes = somaFiltro(ativoLinhas, RE_RECEBER)
        const fornecedores = somaFiltro(passivoLinhas, RE_PAGAR)
        const impostos = somaFiltro(passivoLinhas, RE_IMPOSTO)

        // --- Disponibilidades: TODAS as analíticas da sintética "Disponível" (o totalizador
        // de caixa/bancos/aplicações), como na conciliação — não por nome solto (que pegava
        // contas erradas, tipo IRRF/PROV. IR). Acha a sintética Disponível e soma as filhas
        // pela classificação; se não achar, cai no 1.1.1 padrão e, por fim, no filtro de nome.
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

        // Datas dos saldos: coluna 1 = fim do mês anterior (saldo inicial); coluna 2 = fim da
        // competência. Ex.: 30/04/2026 e 31/05/2026.
        const ultDia = (a, m) => new Date(a, m, 0).getDate()
        const fmtDia = (a, m) => `${String(ultDia(a, m)).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`
        const mAnt = mes === 1 ? 12 : mes - 1, aAnt = mes === 1 ? ano - 1 : ano
        const dataIni = fmtDia(aAnt, mAnt), dataFim = fmtDia(ano, mes)

        // --- Índices ---
        const somaClassif = pref => analit.filter(l => String(l.classif || '').startsWith(pref))
          .reduce((s, l) => s + num(l.saldo_final), 0)
        // Circulante robusto: acha a SINTÉTICA "circulante" pelo nome (como nas Disponibilidades)
        // e soma as filhas pela classificação; só cai no prefixo mascarado (1.1/2.1/2.2) se não achar.
        // Assim a Liquidez não zera quando o plano do cliente não segue o mascaramento padrão.
        const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        const somaPrefixoRaw = pref => analit.filter(l => String(l.classifRaw || '').startsWith(pref)).reduce((s, l) => s + num(l.saldo_final), 0)
        const prefSintetica = (grupo, re, exc) => {
          const s = (hier || []).filter(l => l.sintetica && g(l) === grupo && re.test(norm(l.nome || '')) && !(exc && exc.test(norm(l.nome || ''))))
            .sort((a, b) => String(a.classifRaw || '').length - String(b.classifRaw || '').length)[0]
          return s?.classifRaw || null
        }
        const NAOCIRC = /n[ao] circulante|nao-circulante|longo prazo/
        const preAC = prefSintetica('1', /circulante/, NAOCIRC)
        const prePC = prefSintetica('2', /circulante/, NAOCIRC)
        const prePNC = prefSintetica('2', NAOCIRC, null)
        const ac = preAC ? somaPrefixoRaw(preAC) : somaClassif('1.1')  // ativo circulante
        const pc = prePC ? somaPrefixoRaw(prePC) : somaClassif('2.1')  // passivo circulante
        const pnc = prePNC ? somaPrefixoRaw(prePNC) : somaClassif('2.2') // passivo não circulante
        const indices = {
          margem: faturamento ? ((faturamento - custo - despesa) / faturamento) * 100 : null,
          cargaTrib: faturamento ? (impostos / faturamento) * 100 : null,
          liquidez: pc ? ac / Math.abs(pc) : null,
          endividamento: totAtivo ? pct(Math.abs(pc) + Math.abs(pnc), Math.abs(totAtivo)) : null,
          prazoReceb: faturamento ? Math.round((clientes / faturamento) * 30) : null,
        }

        // --- Distribuição de lucros (campo de distribuição / ata) ---
        const distTotal = (dist?.socios || []).reduce((s, x) => s + num(x.total), 0)

        // --- Principais clientes (NOME extraído do histórico das NFs de receita) ---
        const receitaCods = [...new Set(analit.filter(l => g(l) === '3').map(l => String(l.reduzido)))]
        let topClientes = [], totReceitaRazao = 0
        if (receitaCods.length) {
          const rz = await lerTudo(() => supabase.from('razao').select('conta, historico, debito, credito')
            .eq('competencia_id', compId).in('conta', receitaCods))
          const mapa = {}
          for (const l of (rz || [])) {
            const v = num(l.credito) - num(l.debito) // receita = crédito (estorno debita)
            if (v <= 0) continue
            totReceitaRazao += v
            const ent = extrairEntidade(l.historico)
            if (!ent || /^[\d.,\s]+$/.test(ent) || ent.replace(/[^A-Za-zÀ-ú]/g, '').length < 3) continue // descarta "nome" que é só número
            if (!ehCliente(ent)) continue // não é cliente: banco (rendimento de aplicação) ou palavra genérica ("VALOR")
            mapa[ent] = (mapa[ent] || 0) + v
          }
          topClientes = Object.entries(mapa).map(([nome, valor]) => ({ nome, valor }))
            .sort((a, b) => b.valor - a.valor).slice(0, 6)
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
    },
  })

  function exportarExcel() {
    if (!d) return
    const sub = `${empresaNome} · CNPJ ${fmtCnpj(empresa?.cnpj)} · competência ${competencia}`
    const secoes = []

    secoes.push({
      titulo: 'Resultado do período (igual ao Comparativo de Movimento)',
      linhas: [
        ['Total de faturamento', num(d.faturamento)],
        ['(-) Custos', num(d.custo)],
        ['(-) Despesas', num(d.despesa)],
        ['Margem líquida', fmtPct(d.indices.margem)],
      ],
      totais: ['Resultado da competência', num(d.resultado)],
    })
    if (d.serie.length) secoes.push({
      titulo: 'Resultado por mês (comparativo)',
      linhas: d.serie.map(x => [`${MESES[x.mes - 1]}/2026`, num(x.resultado)]),
      totais: ['Resultado do exercício (acumulado)', num(d.acumulado)],
    })
    secoes.push({
      titulo: 'Balanço patrimonial (saldo final da conciliação)',
      linhas: [
        ['Total do ativo', num(d.totAtivo)],
        ['Total do passivo + PL', num(d.totPassivo)],
        ['Clientes (a receber)', num(d.clientes)],
        ['Fornecedores (a pagar)', num(d.fornecedores)],
        ['Distribuição de lucros (pago no mês)', num(d.ata.pagoMes || d.distTotal)],
        ['Ata — distribuído', num(d.ata.distribuido)],
        ['Ata — total pago', num(d.ata.pago)],
        ['Ata — saldo a pagar', num(d.ata.saldo)],
      ],
    })
    secoes.push({
      titulo: 'Financeiro — disponibilidades e geração de caixa',
      linhas: (d.disponiveis.length ? d.disponiveis.map(l => [l.nome, num(l.fim)]) : [['Sem contas de disponibilidade no balancete', '']]),
      totais: ['Geração de caixa (final − inicial)', num(d.geracaoCaixa)],
    })
    secoes.push({
      titulo: 'Impostos',
      linhas: [
        [`Impostos apurados (${fmtPct(d.indices.cargaTrib)} do faturamento)`, num(d.impostos)],
      ],
    })
    if (d.topClientes.length) secoes.push({
      titulo: 'Principais clientes do mês (nome no histórico das NFs de receita)',
      linhas: d.topClientes.map(c => [c.nome, num(c.valor)]),
    })
    secoes.push({
      titulo: 'Índices financeiros',
      linhas: [
        ['Liquidez corrente', d.indices.liquidez == null ? '—' : d.indices.liquidez.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
        ['Margem líquida', fmtPct(d.indices.margem)],
        ['Endividamento', fmtPct(d.indices.endividamento)],
        ['Carga tributária', fmtPct(d.indices.cargaTrib)],
        ['Prazo médio de recebimento', d.indices.prazoReceb == null ? '—' : `${d.indices.prazoReceb} dias`],
      ],
    })

    gerarExcelTimbrado({
      titulo: 'Cockpit Financeiro',
      sub,
      colunas: [{ nome: 'Indicador', largura: 46, wrap: true }, { nome: 'Valor', alinhar: 'right', moeda: true }],
      secoes,
      arquivo: `dashboard_${(empresaNome || 'cliente').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}_${compSlug}.xlsx`,
      aba: 'Dashboard',
    })
  }

  if (!empresaId) {
    return <Wrapper><Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." /></Wrapper>
  }

  return (
    <Wrapper>
      <div className="painel-topo" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{empresaNome}</p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '3px 0 0' }}>
            CNPJ {fmtCnpj(empresa?.cnpj)} · competência <b style={{ color: theme.text }}>{competencia}</b>
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportarExcel} disabled={!d}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: d ? 1 : .5, cursor: d ? 'pointer' : 'not-allowed' }}>
            <i className="ti ti-file-spreadsheet" /> Excel
          </button>
          <button className="btn-ghost" onClick={() => window.print()} disabled={!d}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: d ? 1 : .5 }}>
            <i className="ti ti-file-type-pdf" /> PDF
          </button>
        </div>
      </div>

      {carregando && <p style={{ color: theme.sub, fontSize: 13 }}>Carregando painel do cliente…</p>}
      {semComp && <Aviso icon="ti-file-import" texto="Sem competência importada. Importe o razão desta competência primeiro." />}
      {!carregando && d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <BlocoResultado d={d} />
          <BlocoComparativo d={d} />
          <BlocoBalanco d={d} />
          <BlocoFinanceiro d={d} />
          <BlocoImpostos d={d} />
          <BlocoClientesIndices d={d} />
        </div>
      )}
    </Wrapper>
  )
}

/* ---------------- Blocos ---------------- */

function BlocoResultado({ d }) {
  return (
    <Secao titulo="Resultado do período">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.9fr)', gap: 14 }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Resultado da competência</span>
          <b style={{ fontSize: 34, fontWeight: 800, color: corResultado(d.resultado), letterSpacing: -.5 }}>{money(d.resultado)}</b>
          <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
            <Mini label="Faturamento" v={money(d.faturamento)} />
            <Mini label="Acumulado do ano" v={money(d.acumulado)} />
            <Mini label="Margem líquida" v={fmtPct(d.indices.margem)} />
          </div>
          <span style={{ fontSize: 11, color: theme.sub, marginTop: 8 }}>Mesmo valor da última linha do Comparativo de Movimento (lucro positivo, prejuízo negativo).</span>
        </div>
        <div style={card}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Desempenho por mês</span>
          <GraficoDesempenho s={d.serieCombo} />
        </div>
      </div>
    </Secao>
  )
}

function Donut({ size = 150, segs, centro, sub, corCentro }) {
  const total = segs.reduce((a, s) => a + Math.max(0, s.v), 0) || 1
  let acc = 0
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke={theme.input} strokeWidth="5.5" />
        {segs.filter(s => s.v > 0).map((s, i) => {
          const p = (Math.max(0, s.v) / total) * 100, off = 25 - acc; acc += p
          return <circle key={i} cx="21" cy="21" r="15.9155" fill="none" stroke={s.c} strokeWidth="5.5" strokeDasharray={`${p} ${100 - p}`} strokeDashoffset={off} strokeLinecap="butt" />
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <b style={{ fontSize: 15, fontWeight: 800, color: corCentro || theme.text }}>{centro}</b>
        {sub && <small style={{ color: theme.sub, fontSize: 10 }}>{sub}</small>}
      </div>
    </div>
  )
}

function BlocoComparativo({ d }) {
  const { variacoesConta } = d
  const segs = [
    { label: 'Custo', v: d.custo, c: LARANJA },
    { label: 'Despesa', v: d.despesa, c: theme.yellow },
    { label: 'Lucro', v: Math.max(0, d.lucro), c: theme.green },
  ]
  return (
    <Secao titulo="Comparativo de movimento — resumo (nível 1)"
      flag={variacoesConta ? `${variacoesConta} conta(s) a verificar` : null}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,.8fr)', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <Tile label="Total de faturamento" valor={money(d.faturamento)} cor={theme.accent} />
          <Tile label="Total de custo" valor={money(d.custo)} cor={LARANJA} />
          <Tile label="Despesa" valor={money(d.despesa)} cor={theme.yellow} />
          <Tile label="Lucro / resultado" valor={money(d.lucro)} cor={corResultado(d.lucro)} sub="lucro positivo, prejuízo negativo" />
        </div>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Composição do faturamento</span>
          <Donut segs={segs} centro={fmtPct(d.indices.margem)} sub="margem" corCentro={corResultado(d.lucro)} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {segs.map(s => (
              <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: theme.sub }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.c }} /> {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Secao>
  )
}

// Gráfico combinado: barras de Receita Líquida, EBITDA e Lucro Líquido por mês +
// linhas de Margem EBITDA e Margem Líquida no eixo % — na paleta do app.
function GraficoDesempenho({ s }) {
  const [hov, setHov] = useState(null) // índice do mês em hover
  if (!s || s.length === 0) return <p style={{ color: theme.sub, fontSize: 13, marginTop: 10 }}>Sem meses no comparativo ainda.</p>
  const W = 1000, H = 360, mL = 78, mR = 54, mT = 16, mB = 38
  const x0 = mL, x1 = W - mR, y1 = H - mB
  const plotH = y1 - mT, plotW = x1 - x0
  const n = s.length, gw = plotW / n
  const maxR = Math.max(1, ...s.map(p => Math.max(p.receitaLiq, p.ebitda, p.lucroLiq))) * 1.12
  const maxPctR = Math.max(10, Math.ceil(Math.max(...s.flatMap(p => [p.margemEbitda, p.margemLiquida, 0])) / 10) * 10)
  const yR = v => y1 - (Math.max(0, v) / maxR) * plotH
  const yP = v => y1 - (v / maxPctR) * plotH
  const cx = i => x0 + gw * i + gw / 2
  const bars = [
    { key: 'receitaLiq', label: 'Receita Líquida', cor: theme.accent },
    { key: 'ebitda', label: 'EBITDA', cor: theme.red },
    { key: 'lucroLiq', label: 'Lucro Líquido', cor: theme.green },
  ]
  const linhas = [
    { key: 'margemEbitda', label: 'Margem EBITDA', cor: theme.red, dash: '7 4' },
    { key: 'margemLiquida', label: 'Margem Líquida', cor: theme.green, dash: '2 4' },
  ]
  const bw = (gw * 0.62) / 3
  const money0 = v => `R$ ${Math.round(v).toLocaleString('pt-BR')}`
  return (
    <>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 460, display: 'block' }}>
          {/* grades + eixo R$ (esq) e % (dir) */}
          {Array.from({ length: 6 }).map((_, i) => {
            const vR = maxR * i / 5, y = yR(vR), vP = maxPctR * i / 5
            return (
              <g key={i}>
                <line x1={x0} y1={y} x2={x1} y2={y} stroke={theme.border} strokeWidth="1" />
                <text x={x0 - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill={theme.sub}>{money0(vR)}</text>
                <text x={x1 + 8} y={yP(vP) + 3.5} textAnchor="start" fontSize="10" fill={theme.sub}>{vP.toFixed(0)}%</text>
              </g>
            )
          })}
          {/* barras */}
          {s.map((p, i) => bars.map((b, bi) => {
            const v = p[b.key], y = yR(v), bx = cx(i) - (bw * 3) / 2 + bi * bw
            return <rect key={i + b.key} x={bx} y={y} width={Math.max(1, bw - 1)} height={Math.max(0, y1 - y)} fill={b.cor} rx="1">
              <title>{`${p.rotulo} · ${b.label}: ${money(v)}`}</title>
            </rect>
          }))}
          {/* linhas de margem + rótulos */}
          {linhas.map(ln => (
            <g key={ln.key}>
              <polyline points={s.map((p, i) => `${cx(i)},${yP(p[ln.key])}`).join(' ')} fill="none" stroke={ln.cor} strokeWidth="2" strokeDasharray={ln.dash} />
              {s.map((p, i) => (
                <g key={i}>
                  <circle cx={cx(i)} cy={yP(p[ln.key])} r="2.6" fill={ln.cor} />
                  <text x={cx(i)} y={yP(p[ln.key]) - 7} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={theme.text}>{p[ln.key].toFixed(2)}%</text>
                </g>
              ))}
            </g>
          ))}
          {/* meses + eixos */}
          {s.map((p, i) => <text key={'m' + i} x={cx(i)} y={y1 + 16} textAnchor="middle" fontSize="10.5" fill={theme.sub}>{p.rotulo}</text>)}
          <line x1={x0} y1={mT} x2={x0} y2={y1} stroke={theme.border} />
          <line x1={x1} y1={mT} x2={x1} y2={y1} stroke={theme.border} />
          {/* alvos de hover (coluna inteira) */}
          {s.map((p, i) => (
            <rect key={'h' + i} x={x0 + gw * i} y={mT} width={gw} height={plotH} fill="transparent"
              onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(h => (h === i ? null : h))} style={{ cursor: 'default' }} />
          ))}
          {/* tooltip com os valores reais do mês */}
          {hov != null && s[hov] && (() => {
            const p = s[hov], bw2 = 186, bh = 98
            const tx = Math.min(x1 - bw2, Math.max(x0, cx(hov) - bw2 / 2)), ty = mT + 4
            const linhasT = [
              ['Receita Líquida', money(p.receitaLiq), theme.accent],
              ['EBITDA', money(p.ebitda), theme.red],
              ['Lucro Líquido', money(p.lucroLiq), theme.green],
              ['Margem EBITDA', `${p.margemEbitda.toFixed(2)}%`, theme.red],
              ['Margem Líquida', `${p.margemLiquida.toFixed(2)}%`, theme.green],
            ]
            return (
              <g pointerEvents="none">
                <rect x={tx} y={ty} width={bw2} height={bh} rx="7" fill={theme.card} stroke={theme.cb} />
                <text x={tx + 10} y={ty + 16} fontSize="11" fontWeight="700" fill={theme.text}>{p.rotulo}</text>
                {linhasT.map((l, li) => (
                  <g key={li}>
                    <rect x={tx + 10} y={ty + 25 + li * 14} width={8} height={8} rx="2" fill={l[2]} />
                    <text x={tx + 23} y={ty + 32 + li * 14} fontSize="9.5" fill={theme.sub}>{l[0]}</text>
                    <text x={tx + bw2 - 10} y={ty + 32 + li * 14} textAnchor="end" fontSize="9.5" fontWeight="600" fill={theme.text}>{l[1]}</text>
                  </g>
                ))}
              </g>
            )
          })()}
        </svg>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginTop: 12 }}>
        {bars.map(b => (
          <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.sub }}>
            <span style={{ width: 14, height: 11, borderRadius: 3, background: b.cor }} /> {b.label}
          </span>
        ))}
        {linhas.map(ln => (
          <span key={ln.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.sub }}>
            <span style={{ width: 18, height: 0, borderTop: `2px ${ln.dash.startsWith('2') ? 'dotted' : 'dashed'} ${ln.cor}` }} /> {ln.label}
          </span>
        ))}
      </div>
    </>
  )
}

function BlocoBalanco({ d }) {
  return (
    <Secao titulo="Balanço patrimonial">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Total do ativo" valor={money(d.totAtivo)} />
        <Tile label="Total do passivo + PL" valor={money(d.totPassivo)} />
        <Tile label="Resultado acumulado" valor={money(d.acumulado)}
          cor={corResultado(d.acumulado)} sub="acumulado do Comparativo de Movimento" />
        <Tile label="Clientes (a receber)" valor={money(d.clientes)} cor={theme.green} />
        <Tile label="Fornecedores (a pagar)" valor={money(d.fornecedores)} cor={theme.red} />
        <Tile label="Distribuição de lucros (mês)" valor={money(d.ata.pagoMes || d.distTotal)} sub="pago aos sócios no mês" />
        <Tile label="Ata — saldo a pagar" valor={money(d.ata.saldo)} cor={d.ata.saldo > 0.005 ? theme.yellow : theme.green}
          sub={`distribuído ${money(d.ata.distribuido)} · pago ${money(d.ata.pago)}`} />
      </div>
      <p style={{ fontSize: 11, color: theme.sub, margin: '8px 2px 0' }}>Saldos da última coluna da conciliação (saldo final da competência).</p>
    </Secao>
  )
}

function BlocoFinanceiro({ d }) {
  return (
    <Secao titulo="Financeiro — disponibilidades e geração de caixa">
      {d.disponiveis.length === 0 ? (
        <Aviso icon="ti-building-bank" texto="Nenhuma conta de caixa/banco identificada no balancete desta competência." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,.8fr)', gap: 12 }}>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Conta</th><th style={thNum}>{d.dataIni}</th><th style={thNum}>{d.dataFim}</th>
                </tr>
              </thead>
              <tbody>
                {d.disponiveis.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={td}>{l.nome}</td>
                    <td style={tdNum}>{money(l.ini)}</td>
                    <td style={tdNum}>{money(l.fim)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }}>Total disponível</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(d.totDispIni)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(d.totDispFim)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <Tile label="Total disponível (saldo final)" valor={money(d.totDispFim)} cor={theme.accent} />
            <Tile label="Geração de caixa no mês" valor={money(d.geracaoCaixa)} cor={d.geracaoCaixa >= 0 ? theme.green : theme.red}
              sub="saldo final − saldo inicial das disponibilidades" />
          </div>
        </div>
      )}
    </Secao>
  )
}

function BlocoImpostos({ d }) {
  return (
    <Secao titulo="Impostos">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Impostos apurados" valor={money(d.impostos)} sub={`${fmtPct(d.indices.cargaTrib)} do faturamento`} />
        <Tile label="Carga tributária" valor={fmtPct(d.indices.cargaTrib)} sub="impostos ÷ faturamento" />
      </div>
    </Secao>
  )
}

function BlocoClientesIndices({ d }) {
  const totalTop = d.topClientes.reduce((s, c) => s + c.valor, 0)
  const max = Math.max(1, ...d.topClientes.map(c => c.valor))
  const base = d.totReceitaRazao || totalTop
  const demais = Math.max(0, base - totalTop)
  const ix = d.indices
  return (
    <Secao titulo="Principais clientes e índices">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
        {/* Principais clientes */}
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, padding: '13px 15px', margin: 0, borderBottom: `1px solid ${theme.border}` }}>Principais clientes do mês</p>
          {d.topClientes.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 12.5, padding: 15 }}>
              Não identifiquei nomes de clientes no histórico das NFs de receita. Importe o razão da conta de receita com o nome do cliente no histórico (ou o razão de duplicatas a receber).
            </p>
          ) : (
            <>
              <div style={{ padding: '6px 15px 12px' }}>
                {d.topClientes.map((c, i) => (
                  <div key={i} style={{ padding: '9px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{c.nome}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(c.valor)} <small style={{ color: theme.sub }}>· {fmtPct(pct(c.valor, base))}</small></span>
                    </div>
                    <div style={{ height: 6, background: theme.input, borderRadius: 20, marginTop: 6, overflow: 'hidden' }}>
                      <div style={{ width: `${(c.valor / max) * 100}%`, height: '100%', background: theme.accent, borderRadius: 20, minWidth: 4 }} />
                    </div>
                  </div>
                ))}
                {demais > 0.005 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 2px', borderTop: `1px solid ${theme.border}`, fontSize: 12.5, color: theme.sub }}>
                    <span>Demais clientes</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(demais)}</span>
                  </div>
                )}
              </div>
              <p style={{ fontSize: 11, color: theme.sub, padding: '0 15px 12px', margin: 0 }}>Nome extraído do histórico das NFs de receita.</p>
            </>
          )}
        </div>

        {/* Índices financeiros */}
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, padding: '13px 15px', margin: 0, borderBottom: `1px solid ${theme.border}` }}>Índices financeiros</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)' }}>
            <Kpi label="Liquidez corrente" v={ix.liquidez == null ? '—' : ix.liquidez.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} hint="Ativo circ. ÷ Passivo circ." cor={corFaixa(ix.liquidez, 1, 0.7, true)} />
            <Kpi label="Margem líquida" v={fmtPct(ix.margem)} hint="Resultado ÷ receita" cor={corResultado(ix.margem)} />
            <Kpi label="Endividamento" v={fmtPct(ix.endividamento)} hint="Passivo exig. ÷ ativo" cor={corFaixa(ix.endividamento, 50, 70, false)} />
            <Kpi label="Carga tributária" v={fmtPct(ix.cargaTrib)} hint="Impostos ÷ receita" cor={corFaixa(ix.cargaTrib, 15, 25, false)} />
            <Kpi label="Prazo médio receb." v={ix.prazoReceb == null ? '—' : `${ix.prazoReceb} dias`} hint="A receber ÷ receita" />
            <Kpi label="Resultado / receita" v={fmtPct(ix.margem)} hint="Rentabilidade do mês" cor={corResultado(ix.margem)} />
          </div>
        </div>
      </div>
    </Secao>
  )
}

/* ---------------- Peças ---------------- */
function Secao({ titulo, flag, children }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{titulo}</h2>
        {flag && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999, background: 'rgba(245,166,35,.16)', color: theme.yellow }}>{flag}</span>}
        <span style={{ flex: 1, height: 1, background: theme.border }} />
      </div>
      {children}
    </section>
  )
}
function Tile({ label, valor, sub, cor }) {
  return (
    <div style={{ ...card, padding: 16 }}>
      <span style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 700 }}>{label}</span>
      <b style={{ display: 'block', fontSize: 20, fontWeight: 700, margin: '5px 0 0', color: cor || theme.text, letterSpacing: -.3 }}>{valor}</b>
      {sub && <span style={{ fontSize: 11.5, color: theme.sub }}>{sub}</span>}
    </div>
  )
}
function Mini({ label, v }) {
  return (
    <div>
      <span style={{ display: 'block', color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4 }}>{label}</span>
      <b style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
    </div>
  )
}
function Kpi({ label, v, hint, cor }) {
  return (
    <div style={{ padding: '13px 15px', borderTop: `1px solid ${theme.border}`, borderRight: `1px solid ${theme.border}` }}>
      <span style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700 }}>{label}</span>
      <b style={{ display: 'block', fontSize: 18, fontWeight: 800, margin: '3px 0 0', fontVariantNumeric: 'tabular-nums', color: cor || theme.text }}>{v}</b>
      <span style={{ fontSize: 11, color: theme.sub }}>{hint}</span>
    </div>
  )
}
// Cor por faixa: bom (verde), atenção (amarelo), ruim (vermelho). alto=true → maior é melhor.
function corFaixa(v, bom, atencao, alto = true) {
  if (v == null) return theme.sub
  if (alto) return v >= bom ? theme.green : v >= atencao ? theme.yellow : theme.red
  return v <= bom ? theme.green : v <= atencao ? theme.yellow : theme.red
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const card = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 18 }

function Wrapper({ children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Cockpit Financeiro</h1>
        <InfoTela titulo="Cockpit Financeiro">A visão gerencial para conversar com o cliente: receita, custo, despesa e resultado do mês e acumulado, DRE e evolução no ano. Lê o <b>razão vivo</b> — mesma fonte da Conciliação e do Comparativo.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Visão para levar ao cliente — resultado, balanço, financeiro, impostos e principais clientes da competência.</p>
      {children}
    </div>
  )
}
function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 620 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
