import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { apurarDistribuicao } from '../lib/distribuicao'
import { apurarBancoResultado } from '../lib/bancoResultado'
import { apurarVariacoes } from '../lib/variacoes'
import { parsePlano, contasConciliacaoAbertas, montarBalancete } from '../lib/balancete'
import { gerarExcelTimbrado } from '../lib/excel'
import { abreBalanceteDominio, abreDreDominio } from '../lib/pdf'
import { montarDRE } from '../lib/dre'
import BookComposicoes from '../components/BookComposicoes'
import { theme, money, moneyDC } from '../lib/theme'

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
  { id: 'comparativo', nome: 'Comparativo de Movimento', icon: 'ti-arrows-diff', desc: 'Saldo de cada conta ao longo dos meses do ano.' },
  { id: 'pendencias', nome: 'Relatório de Pendências', icon: 'ti-alert-triangle', desc: 'Documentos da competência ainda não recebidos.' },
  { id: 'bancoresult', nome: 'Banco × Resultado', icon: 'ti-building-bank', desc: 'Lançamentos de banco direto em conta de resultado não liberada.' },
  { id: 'indedutiveis', nome: 'Despesas indedutíveis (LALUR)', icon: 'ti-receipt', desc: 'Despesas classificadas como indedutíveis nas justificativas.' },
  { id: 'distribuicao', nome: 'Distribuição de lucros · IRRF 2026', icon: 'ti-cash', desc: 'Apuração por sócio: total recebido, limite e IRRF estimado.' },
  { id: 'auditoria', nome: 'Justificativas e correções do fechamento', icon: 'ti-clipboard-check', desc: 'Consolida toda a auditoria registrada nesta competência.' },
]

export default function Relatorios() {
  const { empresaId, empresaNome, competencia, empresas } = useAppData()
  const cnpj = empresas?.find(e => e.id === empresaId)?.cnpj
  const [carregando, setCarregando] = useState(false)
  const [temComp, setTemComp] = useState(null) // null = não checado, false = sem competência
  const [linhas, setLinhas] = useState([])      // balancete (tabela crua)
  const [hier, setHier] = useState([])          // balancete hierárquico (montarBalancete: sint. + analít.)
  const [documentos, setDocumentos] = useState([]) // competencias.documentos
  const [concPend, setConcPend] = useState([])     // contas de conciliação marcadas como pendência do cliente
  const [auditoria, setAuditoria] = useState([])    // auditoria desta competência
  const [dist, setDist] = useState(null)            // apuração de distribuição de lucros
  const [br, setBr] = useState(null)                // apuração banco × resultado
  const [comparativo, setComparativo] = useState(null) // matriz conta × mês do ano
  const [concOk, setConcOk] = useState(null)        // conciliação finalizada? (null = checando)
  const [compId, setCompId] = useState(null)        // id da competência resolvida (p/ montarBalancete)
  const [gerandoDom, setGerandoDom] = useState(false)
  const [aba, setAba] = useState('balancete')

  // Resolve a competência (READ-ONLY) e lê balancete + documentos + auditoria.
  useEffect(() => {
    setLinhas([]); setHier([]); setDocumentos([]); setConcPend([]); setAuditoria([]); setDist(null); setBr(null); setComparativo(null); setConcOk(null); setCompId(null); setTemComp(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id, documentos')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setTemComp(false); return }
        setTemComp(true)
        setCompId(comp.id)
        setDocumentos(Array.isArray(comp.documentos) ? comp.documentos : [])

        // Balancete hierárquico (sintéticas + analíticas, com Saldo Anterior por arrasto).
        montarBalancete(empresaId, comp.id).then(r => { if (vivo) setHier(r.linhas || []) }).catch(() => { if (vivo) setHier([]) })

        // Tick verde do Book de Composições: acende só quando a conciliação está
        // finalizada (nenhuma conta de Ativo/Passivo em aberto — mesma régua do Status).
        contasConciliacaoAbertas(empresaId, comp.id).then(ab => { if (vivo) setConcOk(ab.length === 0) }).catch(() => { if (vivo) setConcOk(null) })

        const [{ data: bal }, { data: aud }] = await Promise.all([
          supabase.from('balancete')
            .select('conta, nome, saldo_inicial, debito, credito, saldo_final')
            .eq('competencia_id', comp.id)
            .order('conta', { ascending: true }),
          supabase.from('auditoria')
            .select('modulo, item, tipo, detalhe, dedutibilidade, usuario, created_at')
            .eq('competencia_id', comp.id)
            .order('created_at', { ascending: false }),
        ])
        if (!vivo) return
        setLinhas(bal || [])
        setAuditoria(aud || [])

        // Pendências de conciliação (contas de saldo marcadas como "pendência do cliente").
        const [{ data: cc }, { data: planoCarga }] = await Promise.all([
          supabase.from('conciliacao_conta').select('conta, justificativa').eq('competencia_id', comp.id).eq('pendencia_cliente', true),
          supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ])
        if (!vivo) return
        const nomePorCod = Object.fromEntries(parsePlano(planoCarga?.dados).map(p => [p.reduzido, p.nome]))
        setConcPend((cc || []).map(r => ({ conta: r.conta, nome: nomePorCod[r.conta] || '', justificativa: r.justificativa || '' })))
        const d = await apurarDistribuicao(empresaId, comp.id)
        if (vivo) setDist(d)
        const b = await apurarBancoResultado(empresaId, comp.id)
        if (vivo) setBr(b)
        const cmp = await apurarVariacoes(empresaId)
        if (vivo) setComparativo(cmp)
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." />
      </Wrapper>
    )
  }

  const compSlug = competencia.replace('/', '-')

  // Totais do balancete.
  const totDeb = linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)

  // DRE estruturada (Receita Bruta → Líquida → Lucro Bruto → EBITDA → LAIR → Lucro Líquido),
  // montada da hierarquia do balancete (mesma estrutura do Domínio).
  const dreRows = hier.length ? montarDRE(hier) : []

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
      const linhasHier = hier.length ? hier : (await montarBalancete(empresaId, compId)).linhas
      const [mes, ano] = competencia.split('/').map(Number)
      const ult = new Date(ano, mes, 0).getDate()
      abreBalanceteDominio({
        empresa: empresaNome,
        cnpj: cnpj || '',
        periodoIni: `01/${String(mes).padStart(2, '0')}/${ano}`,
        periodoFim: `${String(ult).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`,
        linhas: linhasHier,
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

      {/* Cards de relatório (escolha) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12, marginBottom: 22 }}>
        {RELATORIOS.map(r => (
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
      {!carregando && temComp && aba === 'comparativo' && (
        <Secao titulo="Comparativo de Movimento" onExportar={comparativo?.contas?.length ? exportarComparativo : null}>
          {!comparativo?.contas?.length ? (
            <Aviso icon="ti-database-off" texto="Importe o razão em ao menos uma competência para comparar." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={{ ...th, position: 'sticky', left: 0, background: theme.input }}>Conta</th>
                    {comparativo.meses.map(m => <th key={m} style={thNum}>{MESES[m - 1]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {comparativo.contas.map(({ conta, nome }) => (
                    <tr key={conta} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, position: 'sticky', left: 0, background: theme.card }}><span style={{ color: theme.sub, fontSize: 11 }}>{conta}</span> {nome}</td>
                      {comparativo.meses.map(m => {
                        const v = comparativo.matriz[conta]?.[m]
                        return <td key={m} style={tdNum}>{v == null ? '' : money(v)}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
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
        <Secao titulo="Relatório de Pendências" onExportar={(pendencias.length || concPend.length || contratoPend.length || despesaPend.length) ? exportarPendencias : null}>
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

// Cabeçalho de seção com botões Excel (.xlsx timbrado) e PDF (window.print).
function Secao({ titulo, onExportar, children }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{titulo}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
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
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Relatórios</h1>
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
