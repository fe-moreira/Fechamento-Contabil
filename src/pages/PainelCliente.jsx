import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { apurarVariacoes } from '../lib/variacoes'
import { apurarDistribuicao } from '../lib/distribuicao'
import { montarBalancete } from '../lib/balancete'
import { montarDRE } from '../lib/dre'
import { extrairEntidade } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { theme, money } from '../lib/theme'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const pct = (a, b) => (b ? (a / b) * 100 : null)
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
  const [carregando, setCarregando] = useState(false)
  const [temComp, setTemComp] = useState(null) // null=não checado, false=sem competência
  const [d, setD] = useState(null)

  const empresa = empresas.find(e => e.id === empresaId)
  const compSlug = competencia.replace('/', '-')

  useEffect(() => {
    setD(null); setTemComp(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setTemComp(false); return }
        setTemComp(true)

        // Balancete hierárquico — MESMA fonte da Conciliação/Relatórios: saldo inicial por
        // arrasto + carga inicial, e saldo_final = a "última coluna da conciliação".
        const { linhas: hier } = await montarBalancete(empresaId, comp.id)
        const analit = (hier || []).filter(l => !l.sintetica)
        const g = l => String(l.classifRaw || '')[0] // grupo pela CLASSIFICAÇÃO (não pelo reduzido)

        const comparativo = await apurarVariacoes(empresaId)
        const dist = await apurarDistribuicao(empresaId, comp.id, ano, mes)

        // --- Resultado por mês (receita, despesa e lucro) ---
        // Grupo de cada conta vem da classificação (via balancete hierárquico).
        const grpDe = {}
        for (const l of analit) grpDe[String(l.reduzido)] = g(l)
        const somaGrupoMesM = (dig, m) => (comparativo.contas || [])
          .filter(c => grpDe[String(c.conta)] === dig)
          .reduce((s, c) => s + (comparativo.matriz[c.conta]?.[m] || 0), 0)
        const receitaMes = m => Math.abs(somaGrupoMesM('3', m))              // receita (credora) positiva
        const despesaMes = m => Math.abs(somaGrupoMesM('4', m)) + Math.abs(somaGrupoMesM('5', m)) // custo + despesa
        // Lucro = mesma magnitude da última linha do Comparativo, com sinal de gestão
        // (lucro positivo, prejuízo negativo).
        const resMes = m => receitaMes(m) - despesaMes(m)
        const serie = (comparativo.meses || []).map(m => ({ mes: m, receita: receitaMes(m), despesa: despesaMes(m), resultado: resMes(m) }))
        const resultado = resMes(mes)
        const acumulado = (comparativo.meses || []).filter(m => m <= mes).reduce((s, m) => s + resMes(m), 0)

        // Série do gráfico de desempenho (combo): por mês, a DRE dá Receita Líquida,
        // EBITDA e Lucro Líquido; as margens saem sobre a receita líquida. Reaproveita
        // montarDRE alimentando linhas sintéticas com o movimento do mês.
        const classifRawDe = {}
        for (const l of analit) if (!classifRawDe[String(l.reduzido)]) classifRawDe[String(l.reduzido)] = l.classifRaw
        const dreMes = m => {
          const linhasMes = (comparativo.contas || []).map(c => ({ sintetica: false, classifRaw: classifRawDe[String(c.conta)] || '', saldo_final: comparativo.matriz[c.conta]?.[m] || 0 }))
          const rows = montarDRE(linhasMes)
          const val = lbl => (rows.find(r => r.label === lbl)?.valor) || 0
          return { receitaLiq: val('RECEITA LÍQUIDA'), ebitda: val('RESULTADO OPERACIONAL (EBITDA)'), lucroLiq: val('LUCRO LÍQUIDO DO EXERCÍCIO') }
        }
        const serieCombo = (comparativo.meses || []).map(m => {
          const r = dreMes(m)
          return { mes: m, rotulo: MESES[m - 1], ...r, margemEbitda: r.receitaLiq ? (r.ebitda / r.receitaLiq) * 100 : 0, margemLiquida: r.receitaLiq ? (r.lucroLiq / r.receitaLiq) * 100 : 0 }
        })

        // Nível 1 resumido do mês da competência.
        const faturamento = receitaMes(mes)
        const custo = Math.abs(somaGrupoMesM('4', mes))
        const despesa = Math.abs(somaGrupoMesM('5', mes))
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

        // --- Índices (última coluna da conciliação; classificação mascarada) ---
        const somaClassif = pref => analit.filter(l => String(l.classif || '').startsWith(pref))
          .reduce((s, l) => s + num(l.saldo_final), 0)
        const ac = somaClassif('1.1') // ativo circulante
        const pc = somaClassif('2.1') // passivo circulante
        const pnc = somaClassif('2.2') // passivo não circulante
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
          const { data: rz } = await supabase.from('razao').select('conta, historico, debito, credito')
            .eq('competencia_id', comp.id).in('conta', receitaCods)
          const mapa = {}
          for (const l of (rz || [])) {
            const v = num(l.credito) - num(l.debito) // receita = crédito (estorno debita)
            if (v <= 0) continue
            totReceitaRazao += v
            const ent = extrairEntidade(l.historico)
            if (!ent || /^[\d.,\s]+$/.test(ent) || ent.replace(/[^A-Za-zÀ-ú]/g, '').length < 3) continue // descarta "nome" que é só número
            mapa[ent] = (mapa[ent] || 0) + v
          }
          topClientes = Object.entries(mapa).map(([nome, valor]) => ({ nome, valor }))
            .sort((a, b) => b.valor - a.valor).slice(0, 6)
        }

        if (!vivo) return
        setD({
          faturamento, custo, despesa, resultado, lucro, acumulado, serie, serieCombo,
          totAtivo, totPassivo, clientes, fornecedores,
          impostos, disponiveis, totDispIni, totDispFim, geracaoCaixa, dataIni, dataFim,
          indices, dist, distTotal, ata: dist.ata || { distribuido: 0, pago: 0, pagoMes: 0, saldo: 0 },
          comparativo,
          variacoesConta: new Set((comparativo.itens || []).map(i => String(i.conta))).size,
          topClientes, totReceitaRazao,
        })
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia, plano])

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
      titulo: 'Dashboard do cliente',
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
      {temComp === false && <Aviso icon="ti-file-import" texto="Sem competência importada. Importe o razão desta competência primeiro." />}
      {!carregando && d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <BlocoResultado d={d} />
          <BlocoDesempenho d={d} />
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
  const max = Math.max(1, ...d.serie.flatMap(x => [x.receita, x.despesa, Math.abs(x.resultado)]))
  const [hov, setHov] = useState(null)
  const barras = [
    { key: 'receita', label: 'Receita', cor: theme.accent },
    { key: 'despesa', label: 'Despesa', cor: LARANJA },
    { key: 'resultado', label: 'Lucro', cor: theme.green },
  ]
  return (
    <Secao titulo="Resultado do período">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr)', gap: 14 }}>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Resultado por mês</span>
            <div style={{ display: 'flex', gap: 12 }}>
              {barras.map(b => (
                <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: theme.sub }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: b.cor }} /> {b.label}
                </span>
              ))}
            </div>
          </div>
          {d.serie.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, marginTop: 10 }}>Sem meses no comparativo ainda.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22, height: 180, marginTop: 14 }}>
              {d.serie.map(x => (
                <div key={x.mes} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, justifyContent: 'flex-end', height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 0, width: '100%', height: '100%' }}>
                    {barras.map(b => {
                      const v = x[b.key]
                      const cor = b.key === 'resultado' ? corResultado(v) : b.cor
                      const id = `${x.mes}-${b.key}`
                      return (
                        <div key={b.key} onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov(h => (h === id ? null : h))}
                          style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', position: 'relative', cursor: 'default' }}>
                          {hov === id && (
                            <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translate(-50%,-100%)', background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 7, padding: '5px 10px', fontSize: 11.5, whiteSpace: 'nowrap', zIndex: 6, boxShadow: '0 4px 14px rgba(0,0,0,.35)', pointerEvents: 'none' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: cor }} /> {MESES[x.mes - 1]} · {b.label}</span> <b style={{ color: cor, marginLeft: 4 }}>{money(v)}</b>
                            </div>
                          )}
                          <div style={{ height: `${Math.max(2, (Math.abs(v) / max) * 100)}%`, background: cor, minHeight: 2, borderRadius: '3px 3px 0 0' }} />
                        </div>
                      )
                    })}
                  </div>
                  <small style={{ fontSize: 11, color: theme.sub }}>{MESES[x.mes - 1]}</small>
                </div>
              ))}
            </div>
          )}
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

// Gráfico combinado (estilo "Desempenho Financeiro"): barras de Receita Líquida,
// EBITDA e Lucro Líquido por mês + linhas de Margem EBITDA e Margem Líquida no eixo %.
function BlocoDesempenho({ d }) {
  const s = d.serieCombo || []
  if (s.length === 0) return null
  const W = 1000, H = 380, mL = 78, mR = 54, mT = 18, mB = 40
  const x0 = mL, x1 = W - mR, y1 = H - mB
  const plotH = y1 - mT, plotW = x1 - x0
  const n = s.length, gw = plotW / n
  const maxR = Math.max(1, ...s.map(p => Math.max(p.receitaLiq, p.ebitda, p.lucroLiq))) * 1.12
  const maxPctR = Math.max(10, Math.ceil(Math.max(...s.flatMap(p => [p.margemEbitda, p.margemLiquida, 0])) / 10) * 10)
  const yR = v => y1 - (Math.max(0, v) / maxR) * plotH
  const yP = v => y1 - (v / maxPctR) * plotH
  const cx = i => x0 + gw * i + gw / 2
  const bars = [
    { key: 'receitaLiq', label: 'Receita Líquida', cor: '#E6A9A4' },
    { key: 'ebitda', label: 'EBITDA', cor: '#A23232' },
    { key: 'lucroLiq', label: 'Lucro Líquido', cor: '#CD5C5C' },
  ]
  const linhas = [
    { key: 'margemEbitda', label: 'Margem EBITDA', cor: '#8a2b2b', dash: '7 4' },
    { key: 'margemLiquida', label: 'Margem Líquida', cor: '#4f1414', dash: '2 4' },
  ]
  const bw = (gw * 0.62) / 3
  const money0 = v => `R$ ${Math.round(v).toLocaleString('pt-BR')}`
  return (
    <Secao titulo="Desempenho financeiro">
      <div style={{ ...card, overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 680, display: 'block' }}>
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
        </svg>
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
      </div>
    </Secao>
  )
}

function BlocoBalanco({ d }) {
  return (
    <Secao titulo="Balanço patrimonial">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Total do ativo" valor={money(d.totAtivo)} />
        <Tile label="Total do passivo + PL" valor={money(d.totPassivo)} />
        <Tile label="Resultado acumulado" valor={money(d.totAtivo - Math.abs(d.totPassivo))}
          cor={corResultado(d.totAtivo - Math.abs(d.totPassivo))} sub="ativo − (passivo + PL)" />
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
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Dashboard do Cliente</h1>
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
