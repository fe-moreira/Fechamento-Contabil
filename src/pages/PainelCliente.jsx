import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { apurarVariacoes } from '../lib/variacoes'
import { apurarDistribuicao } from '../lib/distribuicao'
import { extrairEntidade } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { theme, money } from '../lib/theme'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const num = v => Number(v) || 0
const pct = (a, b) => (b ? (a / b) * 100 : null)
const fmtPct = p => p == null ? '—' : `${p.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

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

        const { data: bal } = await supabase.from('balancete')
          .select('conta, nome, saldo_final').eq('competencia_id', comp.id).order('conta', { ascending: true })
        const linhas = bal || []

        const comparativo = await apurarVariacoes(empresaId)
        const dist = await apurarDistribuicao(empresaId, comp.id)

        // Mapa código-da-conta → classificação (mascarada) do plano, p/ índices por grupo.
        const classifDe = {}
        for (const p of (plano || [])) if (p.cod && !(p.cod in classifDe)) classifDe[p.cod] = String(p.classif || '')

        // --- Resultado (mesma régua da tela Relatórios: prefixo do código da conta) ---
        const somaPref = pref => linhas.filter(l => String(l.conta || '').startsWith(pref))
          .reduce((s, l) => s + num(l.saldo_final), 0)
        const receita = somaPref('3')
        const despesa = somaPref('4')
        const custo = somaPref('5')
        const resultado = receita - despesa - custo

        // --- Série mensal do resultado (do comparativo: matriz conta × mês) ---
        const serie = (comparativo.meses || []).map(m => {
          let rec = 0, dsp = 0
          for (const { conta } of (comparativo.contas || [])) {
            const v = comparativo.matriz[conta]?.[m]
            if (v == null) continue
            if (String(conta).startsWith('3')) rec += num(v)
            else dsp += num(v) // 4 e 5 (despesa/custo)
          }
          return { mes: m, receita: rec, resultado: rec - dsp }
        })
        const acumulado = serie.reduce((s, x) => s + x.resultado, 0)

        // --- Balanço ---
        const ativo = linhas.filter(l => String(l.conta || '').startsWith('1'))
        const passivo = linhas.filter(l => String(l.conta || '').startsWith('2'))
        const totAtivo = ativo.reduce((s, l) => s + num(l.saldo_final), 0)
        const totPassivo = passivo.reduce((s, l) => s + num(l.saldo_final), 0)

        // --- Grupos por nome (impostos, receber, pagar, disponibilidades) ---
        const somaFiltro = (arr, re) => arr.filter(l => re.test(l.nome || ''))
          .reduce((s, l) => s + Math.abs(num(l.saldo_final)), 0)
        const impostos = somaFiltro(passivo, RE_IMPOSTO)
        const aReceber = somaFiltro(ativo, RE_RECEBER)
        const aPagar = somaFiltro(passivo, RE_PAGAR)
        const disponiveis = ativo.filter(l => RE_DISP.test(l.nome || ''))
          .map(l => ({ nome: l.nome || l.conta, valor: num(l.saldo_final) }))
          .filter(l => Math.abs(l.valor) > 0.005)
          .sort((a, b) => b.valor - a.valor)
        const totDisp = disponiveis.reduce((s, l) => s + l.valor, 0)

        // --- Índices por classificação (1.1 circulante, 2.1 PC, 2.2 PNC, 2.3 PL) ---
        const somaClassif = pref => linhas.filter(l => (classifDe[l.conta] || '').startsWith(pref))
          .reduce((s, l) => s + num(l.saldo_final), 0)
        const temClassif = Object.keys(classifDe).length > 0
        const ac = temClassif ? somaClassif('1.1') : null
        const pc = temClassif ? somaClassif('2.1') : null
        const pnc = temClassif ? somaClassif('2.2') : null
        const indices = {
          margem: pct(resultado, receita),
          cargaTrib: pct(impostos, receita),
          liquidez: (ac != null && pc) ? ac / Math.abs(pc) : null,
          endividamento: (temClassif && totAtivo) ? pct(Math.abs(pc || 0) + Math.abs(pnc || 0), Math.abs(totAtivo)) : null,
          prazoReceb: receita ? Math.round((aReceber / receita) * 30) : null,
        }

        // --- Distribuição de lucros ---
        const distTotal = (dist?.socios || []).reduce((s, x) => s + num(x.total), 0)

        // --- Principais clientes (nome extraído do histórico das NFs de receita) ---
        const receitaCods = [...new Set(linhas.filter(l => String(l.conta || '').startsWith('3')).map(l => l.conta))]
        let topClientes = [], totReceitaRazao = 0, semNome = 0
        if (receitaCods.length) {
          const { data: rz } = await supabase.from('razao').select('conta, historico, debito, credito')
            .eq('competencia_id', comp.id).in('conta', receitaCods)
          const mapa = {}
          for (const l of (rz || [])) {
            const v = num(l.credito) - num(l.debito) // receita = crédito (estorno debita)
            if (v <= 0) continue
            totReceitaRazao += v
            const ent = extrairEntidade(l.historico)
            if (!ent) { semNome += v; continue }
            mapa[ent] = (mapa[ent] || 0) + v
          }
          topClientes = Object.entries(mapa).map(([nome, valor]) => ({ nome, valor }))
            .sort((a, b) => b.valor - a.valor).slice(0, 6)
        }

        if (!vivo) return
        setD({
          receita, despesa, custo, resultado, acumulado, serie,
          ativo, passivo, totAtivo, totPassivo,
          impostos, aReceber, aPagar, disponiveis, totDisp,
          indices, dist, distTotal,
          comparativo,
          variacoesConta: new Set((comparativo.itens || []).map(i => String(i.conta))).size,
          topClientes, totReceitaRazao, semNome,
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
      titulo: 'Resultado do período',
      linhas: [
        ['Receita da competência', num(d.receita)],
        ['(-) Despesas', num(d.despesa)],
        ['(-) Custos', num(d.custo)],
        ['Margem líquida', fmtPct(d.indices.margem)],
      ],
      totais: ['Resultado da competência', num(d.resultado)],
    })
    if (d.serie.length) secoes.push({
      titulo: 'Resultado por mês (comparativo)',
      linhas: d.serie.map(x => [`${MESES[x.mes - 1]}/2026`, num(x.resultado)]),
      totais: ['Acumulado do ano', num(d.acumulado)],
    })
    secoes.push({
      titulo: 'Balanço patrimonial',
      linhas: [['Total do ativo', num(d.totAtivo)], ['Total do passivo + PL', num(d.totPassivo)]],
    })
    secoes.push({
      titulo: 'Financeiro — disponibilidades',
      linhas: d.disponiveis.length ? d.disponiveis.map(l => [l.nome, num(l.valor)]) : [['Sem contas de disponibilidade no balancete', '']],
      totais: ['Total disponível', num(d.totDisp)],
    })
    secoes.push({
      titulo: 'Impostos, recebíveis e distribuição',
      linhas: [
        ['Contas a receber', num(d.aReceber)],
        ['Contas a pagar', num(d.aPagar)],
        [`Impostos apurados (${fmtPct(d.indices.cargaTrib)} da receita)`, num(d.impostos)],
        ['Lucro distribuído aos sócios', num(d.distTotal)],
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
          <b style={{ fontSize: 34, fontWeight: 800, color: d.resultado >= 0 ? theme.green : theme.red, letterSpacing: -.5 }}>{money(d.resultado)}</b>
          <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
            <Mini label="Receita" v={money(d.receita)} />
            <Mini label="Acumulado do ano" v={money(d.acumulado)} />
            <Mini label="Margem líquida" v={fmtPct(d.indices.margem)} />
          </div>
        </div>
        <div style={card}>
          <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>Resultado por mês</span>
          {d.serie.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, marginTop: 10 }}>Sem meses no comparativo ainda.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, marginTop: 12 }}>
              {d.serie.map(x => (
                <div key={x.mes} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, justifyContent: 'flex-end', height: '100%' }}>
                  <div title={money(x.resultado)} style={{ width: '100%', height: `${Math.max(4, (Math.abs(x.resultado) / max) * 100)}%`, background: x.resultado >= 0 ? theme.green : theme.red, borderRadius: '5px 5px 2px 2px', minHeight: 4 }} />
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
  const { comparativo, variacoesConta } = d
  const contas = comparativo.contas || []
  return (
    <Secao titulo="Comparativo de movimento"
      flag={variacoesConta ? `${variacoesConta} conta(s) a verificar` : null}>
      {contas.length === 0 ? (
        <Aviso icon="ti-database-off" texto="Importe o razão em ao menos uma competência para comparar." />
      ) : (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxHeight: 360 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
            <thead>
              <tr style={{ background: theme.input }}>
                <th style={{ ...th, position: 'sticky', left: 0, background: theme.input }}>Conta</th>
                {comparativo.meses.map(m => <th key={m} style={thNum}>{MESES[m - 1]}</th>)}
              </tr>
            </thead>
            <tbody>
              {contas.map(({ conta, nome }) => (
                <tr key={conta} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...td, position: 'sticky', left: 0, background: theme.card }}><span style={{ color: theme.sub, fontSize: 11 }}>{conta}</span> {nome}</td>
                  {comparativo.meses.map(m => {
                    const v = comparativo.matriz[conta]?.[m]
                    return <td key={m} style={tdNum}>{v == null ? '—' : money(v)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  )
}

function BlocoBalanco({ d }) {
  const ativoBate = Math.abs(d.totAtivo - d.totPassivo) < 0.05
  return (
    <Secao titulo="Balanço patrimonial">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
        <Tile label="Total do ativo" valor={money(d.totAtivo)} />
        <Tile label="Total do passivo + PL" valor={money(d.totPassivo)} />
        <Tile label="Conferência" valor={ativoBate ? 'Ativo = Passivo' : money(d.totAtivo - d.totPassivo)}
          cor={ativoBate ? theme.green : theme.yellow} sub={ativoBate ? 'balanço fechado' : 'diferença a revisar'} />
      </div>
    </Secao>
  )
}

function BlocoFinanceiro({ d }) {
  return (
    <Secao titulo="Financeiro — disponibilidades">
      {d.disponiveis.length === 0 ? (
        <Aviso icon="ti-building-bank" texto="Nenhuma conta de caixa/banco identificada no balancete desta competência." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,.7fr)', gap: 12 }}>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {d.disponiveis.map((l, i) => (
                  <tr key={i} style={{ borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                    <td style={td}>{l.nome}</td>
                    <td style={tdNum}>{money(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Tile label="Total disponível" valor={money(d.totDisp)} cor={theme.accent} />
        </div>
      )}
    </Secao>
  )
}

function BlocoImpostos({ d }) {
  return (
    <Secao titulo="Impostos, recebíveis e distribuição">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <Tile label="Contas a receber" valor={money(d.aReceber)} cor={theme.green} />
        <Tile label="Contas a pagar" valor={money(d.aPagar)} cor={theme.red} />
        <Tile label="Impostos apurados" valor={money(d.impostos)} sub={`${fmtPct(d.indices.cargaTrib)} da receita`} />
        <Tile label="Lucro distribuído" valor={money(d.distTotal)} sub="aos sócios na competência" />
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
