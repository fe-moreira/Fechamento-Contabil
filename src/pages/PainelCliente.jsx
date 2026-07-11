import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { apurarVariacoes } from '../lib/variacoes'
import { apurarDistribuicao } from '../lib/distribuicao'
import { montarBalancete } from '../lib/balancete'
import { extrairEntidade } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { theme, money } from '../lib/theme'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const pct = (a, b) => (b ? (a / b) * 100 : null)
const fmtPct = p => p == null ? '—' : `${p.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
const AZUL_CLARO = '#5AA9FF' // resultado do mês/exercício — não é bom/ruim, só o valor

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
        const dist = await apurarDistribuicao(empresaId, comp.id)

        // --- Resultado: bate com o Comparativo de Movimento (última linha) ---
        // resMes(m) = soma do movimento de TODAS as contas de resultado no mês (= RESULTADO
        // DO MÊS do comparativo). Acumulado = soma até o mês (= RESULTADO DO EXERCÍCIO).
        const resMes = m => (comparativo.contas || []).reduce((s, c) => s + (comparativo.matriz[c.conta]?.[m] || 0), 0)
        const serie = (comparativo.meses || []).map(m => ({ mes: m, resultado: resMes(m) }))
        const resultado = resMes(mes)
        const acumulado = (comparativo.meses || []).filter(m => m <= mes).reduce((s, m) => s + resMes(m), 0)

        // Nível 1 resumido do mês: faturamento (grupo 3), custo (4) e despesa (5). Grupo de
        // cada conta vem da classificação (via balancete hierárquico).
        const grpDe = {}
        for (const l of analit) grpDe[String(l.reduzido)] = g(l)
        const somaGrupoMes = dig => (comparativo.contas || [])
          .filter(c => grpDe[String(c.conta)] === dig)
          .reduce((s, c) => s + (comparativo.matriz[c.conta]?.[mes] || 0), 0)
        const faturamento = Math.abs(somaGrupoMes('3')) // receita é credora — mostra positivo
        const custo = Math.abs(somaGrupoMes('4'))
        const despesa = Math.abs(somaGrupoMes('5'))
        const lucro = resultado // igual ao comparativo (última linha)

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

        // --- Disponibilidades e geração de caixa (saldo final − saldo inicial) ---
        const disponiveis = ativoLinhas.filter(l => RE_DISP.test(l.nome || ''))
          .map(l => ({ nome: l.nome || l.reduzido, ini: num(l.saldo_inicial), fim: num(l.saldo_final) }))
          .filter(l => Math.abs(l.ini) > 0.005 || Math.abs(l.fim) > 0.005)
          .sort((a, b) => b.fim - a.fim)
        const totDispIni = disponiveis.reduce((s, l) => s + l.ini, 0)
        const totDispFim = disponiveis.reduce((s, l) => s + l.fim, 0)
        const geracaoCaixa = totDispFim - totDispIni

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
          faturamento, custo, despesa, resultado, lucro, acumulado, serie,
          totAtivo, totPassivo, clientes, fornecedores,
          impostos, disponiveis, totDispIni, totDispFim, geracaoCaixa,
          indices, dist, distTotal,
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
        ['Distribuição de lucros', num(d.distTotal)],
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
  const max = Math.max(1, ...d.serie.map(x => Math.abs(x.resultado)))
  return (
    <Secao titulo="Resultado do período">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 14 }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Resultado da competência</span>
          <b style={{ fontSize: 34, fontWeight: 800, color: AZUL_CLARO, letterSpacing: -.5 }}>{money(d.resultado)}</b>
          <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
            <Mini label="Faturamento" v={money(d.faturamento)} />
            <Mini label="Acumulado do ano" v={money(d.acumulado)} />
            <Mini label="Margem líquida" v={fmtPct(d.indices.margem)} />
          </div>
          <span style={{ fontSize: 11, color: theme.sub, marginTop: 8 }}>Igual à última linha do Comparativo de Movimento (Resultado do mês / do exercício).</span>
        </div>
        <div style={card}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Resultado por mês</span>
          {d.serie.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, marginTop: 10 }}>Sem meses no comparativo ainda.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140, marginTop: 12 }}>
              {d.serie.map(x => (
                <div key={x.mes} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, justifyContent: 'flex-end', height: '100%' }}>
                  <small style={{ fontSize: 9.5, color: theme.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{money(x.resultado)}</small>
                  <div title={money(x.resultado)} style={{ width: '100%', height: `${Math.max(4, (Math.abs(x.resultado) / max) * 100)}%`, background: AZUL_CLARO, borderRadius: '5px 5px 2px 2px', minHeight: 4 }} />
                  <small style={{ fontSize: 10.5, color: theme.sub }}>{MESES[x.mes - 1]}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Secao>
  )
}

function BlocoComparativo({ d }) {
  const { variacoesConta } = d
  return (
    <Secao titulo="Comparativo de movimento — resumo (nível 1)"
      flag={variacoesConta ? `${variacoesConta} conta(s) a verificar` : null}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Total de faturamento" valor={money(d.faturamento)} cor={theme.green} />
        <Tile label="Total de custo" valor={money(d.custo)} />
        <Tile label="Despesa" valor={money(d.despesa)} />
        <Tile label="Lucro / resultado" valor={money(d.lucro)} cor={AZUL_CLARO} sub="igual à última linha do comparativo" />
      </div>
    </Secao>
  )
}

function BlocoBalanco({ d }) {
  const ativoBate = Math.abs(d.totAtivo - Math.abs(d.totPassivo)) < 0.05
  return (
    <Secao titulo="Balanço patrimonial">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Total do ativo" valor={money(d.totAtivo)} />
        <Tile label="Total do passivo + PL" valor={money(d.totPassivo)} />
        <Tile label="Conferência" valor={ativoBate ? 'Ativo = Passivo' : money(d.totAtivo - Math.abs(d.totPassivo))}
          cor={ativoBate ? theme.green : theme.yellow} sub={ativoBate ? 'balanço fechado' : 'diferença a revisar'} />
        <Tile label="Clientes (a receber)" valor={money(d.clientes)} cor={theme.green} />
        <Tile label="Fornecedores (a pagar)" valor={money(d.fornecedores)} cor={theme.red} />
        <Tile label="Distribuição de lucros" valor={money(d.distTotal)} sub="conforme ata / campo de distribuição" />
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
                  <th style={th}>Conta</th><th style={thNum}>Saldo inicial</th><th style={thNum}>Saldo final</th>
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
            <Kpi label="Liquidez corrente" v={ix.liquidez == null ? '—' : ix.liquidez.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} hint="Ativo circ. ÷ Passivo circ." />
            <Kpi label="Margem líquida" v={fmtPct(ix.margem)} hint="Resultado ÷ receita" />
            <Kpi label="Endividamento" v={fmtPct(ix.endividamento)} hint="Passivo exig. ÷ ativo" />
            <Kpi label="Carga tributária" v={fmtPct(ix.cargaTrib)} hint="Impostos ÷ receita" />
            <Kpi label="Prazo médio receb." v={ix.prazoReceb == null ? '—' : `${ix.prazoReceb} dias`} hint="A receber ÷ receita" />
            <Kpi label="Resultado / receita" v={fmtPct(ix.margem)} hint="Rentabilidade do mês" />
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
function Kpi({ label, v, hint }) {
  return (
    <div style={{ padding: '13px 15px', borderTop: `1px solid ${theme.border}`, borderRight: `1px solid ${theme.border}` }}>
      <span style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700 }}>{label}</span>
      <b style={{ display: 'block', fontSize: 18, fontWeight: 800, margin: '3px 0 0', fontVariantNumeric: 'tabular-nums' }}>{v}</b>
      <span style={{ fontSize: 11, color: theme.sub }}>{hint}</span>
    </div>
  )
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
