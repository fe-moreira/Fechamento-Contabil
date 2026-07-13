import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme, money } from '../lib/theme'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { apurarVariacoes } from '../lib/variacoes'
import { listar, inserir, remover, atualizar, gerarLancamento, enviarSaldoInicialContrato, anexarArquivoContrato, urlArquivoContrato, removerArquivoContrato, competenciaInicioCliente, apropriacoesDoMes } from '../lib/outras'
import { gerarExcelTimbrado } from '../lib/excel'
import { abrePdfTimbrado } from '../lib/pdf'
import { erroContaSintetica } from '../lib/balancete'
import ObservacoesConciliacao from '../components/ObservacoesConciliacao'
import LeitorIA from '../components/LeitorIA'
import CampoConta from '../components/CampoConta'

// Campo de conta contábil que guarda SEMPRE o código reduzido (não a
// classificação) — é a chave usada pela conciliação e pelo saldo inicial.
function CampoContaForm({ valor, set }) {
  return <CampoConta value={valor} onChange={set} onPick={p => set(p.cod)} placeholder="Código (F4)" />
}

const ACC = { seguro: '#4A7CFF', despesa: '#33B4C6', importacao: '#2FB6A8', emprestimo: '#9A7CF0', parcelamento: '#E8923B', equivalencia: '#E06C9F', perdcomp: '#3FA66A', jcp: '#C9A227', lalur: '#D46A6A', outros: '#7C89A6' }
const BLOCO_LALUR = { key: 'lalur', label: 'LALUR', icon: 'ti-report-money', sub: 'IRPJ e CSLL (Lucro Real)' }
const BLOCOS = [
  { key: 'seguro', label: 'Seguro', icon: 'ti-shield-half', sub: 'Apólices & apropriação' },
  { key: 'despesa', label: 'Despesa a Apropriar', icon: 'ti-calendar-repeat', sub: 'IPVA, IPTU, etc.' },
  { key: 'importacao', label: 'Importação', icon: 'ti-ship', sub: 'Processos de mercadoria' },
  { key: 'emprestimo', label: 'Empréstimo', icon: 'ti-building-bank', sub: 'Contratos & conferência' },
  { key: 'parcelamento', label: 'Parc. Impostos', icon: 'ti-receipt', sub: 'Só juros & multa' },
  { key: 'equivalencia', label: 'Equiv. Patrimonial', icon: 'ti-scale', sub: 'Participações (MEP)' },
  { key: 'perdcomp', label: 'PER/DCOMP', icon: 'ti-arrows-exchange', sub: 'Crédito & compensação' },
  { key: 'jcp', label: 'JSCP', icon: 'ti-coins', sub: 'Juros s/ capital próprio' },
  { key: 'outros', label: 'Outros Lançamentos', icon: 'ti-pencil-plus', sub: 'Manual' },
]

const th = { textAlign: 'left', padding: '9px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap', borderBottom: `1px solid ${theme.border}` }
const td = { padding: '10px 12px', fontSize: 13, color: theme.text, borderBottom: `1px solid ${theme.border}`, verticalAlign: 'top' }
function Card({ children, style }) { return <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 18, ...style }}>{children}</div> }
function SecTitle({ children }) { return <p style={{ fontSize: 15, fontWeight: 700, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</p> }
// Card de cadastro colapsável: começa RECOLHIDO para a tela ficar limpa (só os cards
// de cima e a lista de registros aparecem). O cabeçalho inteiro é clicável; ao expandir,
// o formulário aparece. Assim evita-se poluir a tela quando o objetivo é só consultar.
function FormCard({ titulo, children }) {
  const [aberto, setAberto] = useState(false)
  return (
    <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 18 }}>
      <div onClick={() => setAberto(a => !a)} title={aberto ? 'Recolher o cadastro' : 'Expandir para cadastrar'}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: 'pointer', userSelect: 'none' }}>
        <SecTitle>{titulo}</SecTitle>
        <span className="btn-ghost" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '5px 11px' }}>
          <i className={`ti ${aberto ? 'ti-chevrons-up' : 'ti-chevrons-down'}`} /> {aberto ? 'Recolher' : 'Expandir'}
        </span>
      </div>
      {aberto && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  )
}
function SecSub({ children }) { return <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 14px' }}>{children}</p> }
function Field({ label, children, col }) { return <div style={{ gridColumn: col ? `span ${col}` : 'auto' }}><label>{label}</label>{children}</div> }
// Aceita BR ("1.234,56") e US/simples ("3467.12", vindo de String(numero)):
// só trata "." como milhar quando há vírgula decimal ou quando é grupo de 3 dígitos.
function num(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '')
  if (!s) return 0
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')       // BR com decimal: 1.234,56
  else if (/\.\d{3}(\.\d{3})*$/.test(s)) s = s.replace(/\./g, '')       // milhares sem decimal: 1.500 / 1.234.567
  // senão: "." é decimal (3467.12, 288.92) — mantém
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

function parseISO(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null }
const r2 = v => Math.round((v || 0) * 100) / 100

// Cronograma de apropriação de um contrato: lista [{comp:'MM/AAAA', valor, dias?}].
// metodo 'dia' = proporcional aos dias de cada mês dentro da vigência (oscila mês a
// mês); metodo 'igual' = parcelas iguais (a última absorve o arredondamento).
function cronogramaContrato(c, metodo) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  const vi = parseISO(c.vigencia_inicio)
  if (metodo === 'dia') {
    const vf = parseISO(c.vigencia_fim)
    if (!vi || !vf || vf < vi || !total) return []
    const totalDias = Math.round((vf - vi) / 86400000) + 1
    const linhas = []
    let cursor = new Date(vi.getFullYear(), vi.getMonth(), vi.getDate()), acum = 0
    while (cursor <= vf) {
      const ano = cursor.getFullYear(), mes = cursor.getMonth()
      const fimMes = new Date(ano, mes + 1, 0)
      const ate = fimMes < vf ? fimMes : vf
      const dias = Math.round((ate - cursor) / 86400000) + 1
      const prox = new Date(ano, mes + 1, 1)
      const valor = prox > vf ? r2(total - acum) : r2(total * dias / totalDias)
      acum = r2(acum + valor)
      linhas.push({ comp: `${String(mes + 1).padStart(2, '0')}/${ano}`, valor, dias })
      cursor = prox
    }
    return linhas
  }
  // parcelas iguais
  const nParc = Number(c.num_parcelas) || 0
  const mensal = Number(c.valor_parcela) || (nParc ? total / nParc : 0)
  const linhas = []
  if (vi && mensal > 0 && nParc > 0) {
    let ym = vi.getFullYear() * 12 + vi.getMonth(), acum = 0
    for (let i = 0; i < nParc; i++) {
      const ano = Math.floor(ym / 12), mes = (ym % 12) + 1
      const valor = i === nParc - 1 ? r2(total - mensal * (nParc - 1)) : r2(mensal)
      acum = r2(acum + valor)
      linhas.push({ comp: `${String(mes).padStart(2, '0')}/${ano}`, valor })
      ym++
    }
  }
  return linhas
}
// Valor da apropriação do contrato na competência informada (MM/AAAA).
function valorApropriacaoMes(c, competencia) {
  const l = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual').find(x => x.comp === competencia)
  return l ? l.valor : (Number(c.valor_parcela) || 0)
}
// Número da parcela / total do contrato na competência (ex.: maio de um seguro anual = 5/12).
function parcelaDoMes(c, competencia) {
  const sched = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual')
  const idx = sched.findIndex(x => x.comp === competencia)
  const total = sched.length || Number(c.num_parcelas) || 0
  return { num: idx >= 0 ? idx + 1 : 0, total }
}
// Sufixo " - parcela N/total" para o histórico da apropriação (vazio se fora do cronograma).
function sufixoParcela(c, competencia) {
  const { num, total } = parcelaDoMes(c, competencia)
  return (num && total) ? ` - parcela ${num}/${total}` : ''
}

// ISO YYYY-MM-DD → DD/MM/AAAA (usado no relatório).
function brDataRel(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }

// Apropriação ACUMULADA de um contrato até a competência (inclusive) e a do mês.
// Saldo a apropriar = total − acumulado (é o saldo do ativo "a apropriar" no fim do mês).
function apropriacaoAcumulada(c, competencia) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  const sched = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual')
  const [cm, ca] = String(competencia || '').split('/').map(Number)
  const alvo = (ca * 12 + cm) || 0
  let acum = 0, mes = 0
  for (const s of sched) {
    const [m, a] = s.comp.split('/').map(Number)
    const abs = a * 12 + m
    if (alvo && abs <= alvo) acum = r2(acum + s.valor)
    if (alvo && abs === alvo) mes = s.valor
  }
  return { total, acum: r2(acum), mes, saldo: r2(total - acum) }
}

// Monta o relatório de apropriação (seguro/despesa) agrupado pela conta "a apropriar".
// O SUBTOTAL de cada conta = saldo a apropriar que deve bater na conciliação daquela conta.
function dadosRelatorioApropriacao(rows, origem, competencia, planoMap = {}) {
  const grupos = {}
  for (const r of rows) {
    const { total, acum, mes, saldo } = apropriacaoAcumulada(r, competencia)
    const conta = String(r.conta_apropriar || '').trim() || '—'
    const nome = origem === 'seguro'
      ? `${r.seguradora || ''}${r.apolice ? ' · ' + r.apolice : ''}`.trim()
      : `${r.tipo || ''}${r.descricao ? ' · ' + r.descricao : ''}`.trim()
    const vig = `${brDataRel(r.vigencia_inicio)}${r.vigencia_fim ? ' a ' + brDataRel(r.vigencia_fim) : ''}`.trim()
    const g = (grupos[conta] ||= { conta, nome: planoMap[conta]?.nome || '', itens: [], total: 0, mes: 0, acum: 0, saldo: 0 })
    g.itens.push({ nome: nome || '—', vig, total, mes, acum, saldo })
    g.total = r2(g.total + total); g.mes = r2(g.mes + mes); g.acum = r2(g.acum + acum); g.saldo = r2(g.saldo + saldo)
  }
  const arr = Object.values(grupos).sort((a, b) => String(a.conta).localeCompare(String(b.conta)))
  const geral = arr.reduce((s, g) => ({ total: r2(s.total + g.total), mes: r2(s.mes + g.mes), acum: r2(s.acum + g.acum), saldo: r2(s.saldo + g.saldo) }), { total: 0, mes: 0, acum: 0, saldo: 0 })
  return { grupos: arr, geral }
}

// Colunas do relatório de apropriação (seguro/despesa).
const colunasRelApropriacao = origem => [
  { nome: origem === 'seguro' ? 'Seguradora / Apólice' : 'Tipo / Descrição', largura: 38, wrap: true },
  { nome: 'Vigência', largura: 22, alinhar: 'left' },
  { nome: 'Valor total', alinhar: 'right', moeda: true },
  { nome: 'Apropriado no mês', alinhar: 'right', moeda: true },
  { nome: 'Apropriado acum.', alinhar: 'right', moeda: true },
  { nome: 'Saldo final (ativo)', alinhar: 'right', moeda: true },
]

// Gera o relatório de apropriação em PDF (timbrado, dá pra arrastar na conciliação) ou Excel.
function gerarRelatorioApropriacao({ formato, origem, rows, competencia, empresaNome, planoMap }) {
  const { grupos, geral } = dadosRelatorioApropriacao(rows, origem, competencia, planoMap)
  const titulo = origem === 'seguro' ? 'Seguros a Apropriar — Saldo por Apólice' : 'Despesas a Apropriar — Saldo por Contrato'
  const posicao = brDataRel(dataComp(competencia)) || competencia
  const sub = `${empresaNome || ''} · Posição em ${posicao} · o "Saldo final (ativo)" de cada conta bate com a conciliação`
  const colunas = colunasRelApropriacao(origem)
  const label = g => `Conta ${g.conta}${g.nome ? ' · ' + g.nome : ''}`
  const arquivo = `${origem === 'seguro' ? 'seguros' : 'despesas'}_a_apropriar_${String(competencia).replace('/', '-')}.${formato === 'excel' ? 'xlsx' : 'pdf'}`
  if (formato === 'excel') {
    const secoes = grupos.map(g => ({ titulo: label(g), linhas: g.itens.map(it => [it.nome, it.vig, it.total, it.mes, it.acum, it.saldo]), totais: ['Subtotal', '', g.total, g.mes, g.acum, g.saldo] }))
    return gerarExcelTimbrado({ titulo, sub, colunas, secoes, totais: ['TOTAL GERAL', '', geral.total, geral.mes, geral.acum, geral.saldo], arquivo, aba: origem === 'seguro' ? 'Seguros' : 'Despesas' })
  }
  const secoes = grupos.map(g => ({ titulo: label(g), linhas: g.itens.map(it => [it.nome, it.vig, money(it.total), money(it.mes), money(it.acum), money(it.saldo)]), totais: ['Subtotal', '', money(g.total), money(g.mes), money(g.acum), money(g.saldo)] }))
  abrePdfTimbrado({ titulo, sub, colunas, secoes, totais: ['TOTAL GERAL', '', money(geral.total), money(geral.mes), money(geral.acum), money(geral.saldo)] })
}

// Botões de relatório (PDF/Excel) do saldo a apropriar — reaproveitados por seguro e despesa.
function BotoesRelatorio({ origem, rows, competencia, empresaNome, planoMap }) {
  const dis = !rows.length
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: theme.sub }}><i className="ti ti-report" /> Emitir relatório do saldo:</span>
      <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }} disabled={dis} onClick={() => gerarRelatorioApropriacao({ formato: 'pdf', origem, rows, competencia, empresaNome, planoMap })} title="Relatório do saldo a apropriar (PDF) — arraste na conciliação para bater o saldo"><i className="ti ti-file-type-pdf" /> PDF</button>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px', borderColor: theme.accent, color: theme.accent }} disabled={dis} onClick={() => gerarRelatorioApropriacao({ formato: 'excel', origem, rows, competencia, empresaNome, planoMap })} title="Relatório do saldo a apropriar (Excel)"><i className="ti ti-file-spreadsheet" /> Excel</button>
    </div>
  )
}

// Um contrato já foi apropriado nesta competência? Casa pelo documento (apólice/doc)
// e, sem documento, pelo identificador no histórico do lançamento de apropriação.
function contratoApropriado(contrato, apropriacoes, origem) {
  if (!apropriacoes?.length) return false
  const doc = String((origem === 'seguro' ? contrato.apolice : contrato.documento) || '').trim()
  const chave = String((origem === 'seguro' ? contrato.seguradora : contrato.tipo) || '').trim().toLowerCase()
  const aux = String((origem === 'seguro' ? contrato.apolice : contrato.descricao) || '').trim().toLowerCase()
  return apropriacoes.some(l => {
    if (doc && String(l.documento || '').trim() === doc) return true
    const h = String(l.historico || '').toLowerCase()
    if (!chave) return false
    return h.includes(chave) && (!aux || h.includes(aux))
  })
}

// Carrega as apropriações já lançadas no mês (recarrega quando `versao` muda, ou seja,
// logo após confirmar um lançamento) — para marcar cada contrato como "Apropriado".
function useApropriacoes(clienteId, competencia, origem, versao) {
  const [aprops, setAprops] = useState([])
  useEffect(() => {
    let ativo = true
    if (!clienteId) { setAprops([]); return }
    apropriacoesDoMes(clienteId, competencia, origem).then(a => { if (ativo) setAprops(a || []) })
    return () => { ativo = false }
  }, [clienteId, competencia, origem, versao])
  return aprops
}

// Selo verde "Apropriado" (mês) exibido no contrato assim que o lançamento é confirmado.
function SeloApropriado({ competencia }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: theme.green, background: 'rgba(48,164,108,0.12)', border: `1px solid ${theme.green}`, borderRadius: 20, padding: '2px 9px', whiteSpace: 'nowrap' }}><i className="ti ti-circle-check" /> Apropriado {competencia}</span>
}

// Data do último dia da competência (MM/AAAA) em ISO.
function dataComp(competencia) {
  const [m, a] = (competencia || '').split('/').map(Number)
  if (!m || !a) return ''
  const d = new Date(a, m, 0).getDate()
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// A data (ISO YYYY-MM-DD) é do mês/ano do fechamento em andamento (MM/AAAA)?
// Só se pode lançar com data dentro da competência que está sendo fechada.
function dataNaCompetencia(dataISO, competencia) {
  const m = /^(\d{4})-(\d{2})/.exec(String(dataISO || ''))
  const c = /^(\d{2})\/(\d{4})$/.exec(String(competencia || ''))
  if (!m || !c) return true // sem dados suficientes, não bloqueia
  return m[1] === c[2] && m[2] === c[1]
}
// ISO YYYY-MM-DD → DD/MM/AAAA (para mensagens).
function brData(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '')
}

// Número BR sem símbolo (para placeholders de cálculo sugerido).
const fmtNum = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

// ---- form genérico (controlado) ----
function useForm(init) {
  const [f, setF] = useState(init)
  return [f, k => e => setF(x => ({ ...x, [k]: e.target.value })), () => setF(init), setF]
}

// Mescla no formulário só os campos que a IA de fato extraiu (não vazios/zerados)
// e que existem no formulário — preserva o que já estava preenchido.
function aplicarIA(setF, dados) {
  setF(x => {
    const merge = { ...x }
    for (const [k, v] of Object.entries(dados || {})) {
      if (!(k in x)) continue
      if (v === '' || v === null || v === undefined || v === 0) continue
      merge[k] = String(v)
    }
    return merge
  })
}

export default function OutrasContabilizacoes() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, plano } = useAppData()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))
  const { user } = useAuth()
  const [tab, setTab] = useState('seguro')
  const [gerar, setGerar] = useState(null) // {campos, titulo}
  const [versao, setVersao] = useState(0)  // incrementa após gerar lançamento → recarrega status "Apropriado"
  const [msg, setMsg] = useState('')
  const [compInicio, setCompInicio] = useState('') // competência de início do cliente (abertura)
  const [regime, setRegime] = useState('')         // regime tributário (habilita a aba LALUR)
  useEffect(() => { if (empresaId) competenciaInicioCliente(empresaId).then(setCompInicio); else setCompInicio('') }, [empresaId])
  useEffect(() => {
    if (!empresaId) { setRegime(''); return }
    supabase.from('clientes').select('regime_tributario').eq('id', empresaId).maybeSingle().then(({ data }) => setRegime(data?.regime_tributario || ''))
  }, [empresaId])
  const ehLucroReal = /LUCRO REAL/i.test(regime)

  function abrirGerar(prefill, titulo) { setGerar({ ...prefill, _titulo: titulo }) }

  async function confirmarGerar(g) {
    try {
      if (!dataNaCompetencia(g.data, competencia)) {
        setMsg(`A data ${brData(g.data)} não é do fechamento em andamento (${competencia}). Só é possível lançar com data dentro de ${competencia}.`)
        return
      }
      const eSint = erroContaSintetica(plano, g.conta_debito, g.conta_credito)
      if (eSint) { setMsg(eSint); return }
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setMsg('Selecione uma empresa e abra um fechamento.'); return }
      await gerarLancamento({ competencia_id, ...g, usuario: user?.email })
      setGerar(null); setVersao(v => v + 1); setMsg('Lançamento gerado e enviado ao Status → Domínio.')
      setTimeout(() => setMsg(''), 4000)
    } catch (e) { setMsg('Erro: ' + e.message) }
  }

  // Envia o saldo de abertura de um contrato (seguro/despesa a apropriar) para a
  // carga inicial — o que falta apropriar na abertura vira composição da conta.
  async function enviarSaldoInicial(origem, contrato) {
    try {
      const restante = await enviarSaldoInicialContrato({ clienteId: empresaId, origem, contrato, usuario: user?.email })
      setMsg(restante > 0.005
        ? `Saldo de abertura enviado à carga inicial: ${money(restante)} a apropriar (Base de Informações → carga inicial).`
        : 'Sem saldo a apropriar na abertura — o contrato já estaria encerrado nessa data.')
      setTimeout(() => setMsg(''), 6000)
    } catch (e) { setMsg('Erro: ' + e.message) }
  }

  if (!empresaId) return <Aviso texto="Selecione uma empresa no menu lateral." />

  const props = { clienteId: empresaId, user, competencia, abrirGerar, enviarSaldoInicial, compInicio, empresaNome, planoMap, versao, regime }
  const blocos = ehLucroReal ? [...BLOCOS, BLOCO_LALUR] : BLOCOS
  const paneMap = { seguro: PaneSeguro, despesa: PaneDespesaApropriar, importacao: PaneImportacao, emprestimo: PaneEmprestimo, parcelamento: PaneParcelamento, equivalencia: PaneEquivalencia, perdcomp: PanePerdcomp, jcp: PaneJcp, lalur: PaneLalur, outros: PaneOutros }
  const Pane = paneMap[tab] || PaneSeguro

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Outras Contabilizações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16, maxWidth: 820 }}>
        Cadastre os contratos/processos e gere os lançamentos do mês — tudo que você <b style={{ color: theme.text }}>gera</b> entra em <b style={{ color: theme.text }}>Lançamentos</b> e alimenta o Status → Domínio.
        {empresaNome && <> · <b style={{ color: theme.text }}>{empresaNome}</b> · {competencia}</>}
      </p>

      {msg && <div style={{ background: theme.card, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14, color: theme.text }}><i className="ti ti-info-circle" style={{ color: theme.accent }} /> {msg}</div>}

      <ObservacoesConciliacao clienteId={empresaId} competencia={competencia} user={user} irPara={setTab} />

      {/* Só a barra de abas (nome + cor) — tela mais limpa. Clicar abre o cadastro. */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border}`, margin: '4px 0 20px', flexWrap: 'wrap' }}>
        {blocos.map(b => (
          <button key={b.key} onClick={() => setTab(b.key)} style={{ background: 'none', border: 'none', padding: '10px 14px', fontSize: 13.5, fontWeight: 600, color: tab === b.key ? theme.text : theme.sub, borderBottom: `2px solid ${tab === b.key ? theme.accent : 'transparent'}`, marginBottom: -1, cursor: 'pointer' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 7, background: ACC[b.key] }} />{b.label}
          </button>
        ))}
      </div>

      <Pane {...props} />
      {gerar && <GerarModal cfg={gerar} competencia={competencia} onClose={() => setGerar(null)} onConfirm={confirmarGerar} />}
    </div>
  )
}

// ---- Modal: confirmar/editar a partida antes de gerar o lançamento ----
function GerarModal({ cfg, competencia, onClose, onConfirm }) {
  const [f, on] = useForm({ data: cfg.data || '', conta_debito: cfg.conta_debito || '', conta_credito: cfg.conta_credito || '', valor: cfg.valor || '', historico: cfg.historico || '', origem: cfg.origem, documento: cfg.documento })
  const dataOk = dataNaCompetencia(f.data, competencia)
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,18,0.64)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, maxWidth: 560, width: '100%', padding: '22px 24px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Gerar lançamento</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>{cfg._titulo} — confira a partida e confirme.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Data"><input className="input" type="date" value={f.data} onChange={on('data')} style={!dataOk ? { borderColor: theme.red } : undefined} /></Field>
          <Field label="Valor"><input className="input" type="number" step="0.01" value={f.valor} onChange={on('valor')} /></Field>
          <Field label="Conta débito"><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></Field>
          <Field label="Conta crédito"><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></Field>
          <Field label="Histórico" col={2}><input className="input" value={f.historico} onChange={on('historico')} /></Field>
        </div>
        {!dataOk && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 12, fontWeight: 600 }}>
          <i className="ti ti-alert-triangle" /> A data {brData(f.data)} não é do fechamento em andamento ({competencia}). Só é possível lançar com data dentro de {competencia}.
        </p>}
        <p style={{ color: theme.sub, fontSize: 12, marginTop: 12 }}><i className="ti ti-sparkles" style={{ color: theme.accent }} /> Só gera no Domínio com débito e crédito. Atualiza a conciliação.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!dataOk} onClick={() => onConfirm(f)}>Confirmar e gerar</button>
        </div>
      </div>
    </div>
  )
}

// ---- helper: lista + exclusão comum ----
function useLista(tabela, clienteId) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  async function recarregar() {
    setLoading(true); setErro('')
    try { setRows(await listar(tabela, clienteId)) } catch (e) { setErro(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { recarregar() }, [tabela, clienteId]) // eslint-disable-line
  async function excluir(id) { if (!confirm('Excluir este registro?')) return; try { await remover(tabela, id); recarregar() } catch (e) { setErro(e.message) } }
  return { rows, loading, erro, recarregar, excluir }
}

function GerarBtn({ onClick, children = 'Gerar lançamento' }) { return <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick}><i className="ti ti-file-plus" /> {children}</button> }
function SaldoIniBtn({ onClick }) { return <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick} title="Calcula o que falta apropriar na abertura e envia à carga inicial"><i className="ti ti-arrow-bar-to-up" /> Saldo inicial</button> }
function DelBtn({ onClick }) { return <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick}>excluir</button> }
// Anexar/ver/excluir o documento do contrato (apólice, carnê…), salvo no Storage.
function AnexoContrato({ tabela, row, onChange }) {
  const [busy, setBusy] = useState(false)
  async function anexar(file) { if (!file) return; setBusy(true); try { await anexarArquivoContrato(tabela, row.id, file); onChange() } catch (e) { alert(e.message) } finally { setBusy(false) } }
  async function ver() { try { window.open(await urlArquivoContrato(row.arquivo), '_blank', 'noopener') } catch (e) { alert(e.message) } }
  async function remover() { if (!confirm('Excluir o arquivo anexado?')) return; setBusy(true); try { await removerArquivoContrato(tabela, row.id, row.arquivo); onChange() } catch (e) { alert(e.message) } finally { setBusy(false) } }
  if (row.arquivo) return (
    <>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.green, borderColor: theme.green }} onClick={ver} title="Ver / baixar o documento anexado"><i className="ti ti-eye" /> Ver arquivo</button>{' '}
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 8px', color: theme.sub }} disabled={busy} onClick={remover} title="Excluir arquivo">×</button>
    </>
  )
  return (
    <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer', color: theme.yellow, borderColor: theme.yellow }} title="Anexar o documento (apólice, carnê…)">
      <i className="ti ti-paperclip" /> {busy ? 'Enviando…' : 'Anexar'}
      <input type="file" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={e => anexar(e.target.files?.[0])} />
    </label>
  )
}
function Vazio({ colSpan, texto }) { return <tr><td colSpan={colSpan} style={{ padding: 18, color: theme.sub, fontSize: 13 }}>{texto}</td></tr> }

// Cronograma de apropriações do contrato: total, cada parcela (mês e valor) e o
// saldo a apropriar após cada uma. Marca quais compõem o SALDO INICIAL (meses
// antes da abertura do cliente) e quais geram lançamento no mês.
function ModalCronograma({ contrato, origem, compInicio, onClose }) {
  const total = Number(contrato.premio_total ?? contrato.valor_total) || 0
  const porDia = !!contrato.por_dia
  const ci = String(compInicio || '').match(/^(\d{2})\/(\d{4})$/)
  const corteAbs = ci ? Number(ci[2]) * 12 + Number(ci[1]) : null
  const nome = origem === 'seguro' ? `${contrato.seguradora || ''}${contrato.apolice ? ' · ' + contrato.apolice : ''}`.trim() : `${contrato.tipo || ''}${contrato.descricao ? ' · ' + contrato.descricao : ''}`.trim()
  const sched = cronogramaContrato(contrato, porDia ? 'dia' : 'igual')
  const linhas = []
  let acum = 0, saldoAbertura = total
  sched.forEach((s, i) => {
    acum = r2(acum + s.valor)
    const [mes, ano] = s.comp.split('/').map(Number)
    const saldoIni = corteAbs != null && (ano * 12 + mes) < corteAbs
    if (saldoIni) saldoAbertura = r2(total - acum)
    linhas.push({ i: i + 1, comp: s.comp, val: s.valor, dias: s.dias, restante: r2(total - acum), saldoIni })
  })
  const temCorte = corteAbs != null && linhas.some(l => l.saldoIni)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(680px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-list-check" style={{ color: theme.accent }} /> Apropriações — {nome}</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '0 0 12px', fontSize: 12.5 }}>
          <span style={{ color: theme.sub }}>Total: <b style={{ color: theme.text }}>{money(total)}</b></span>
          <span style={{ color: theme.sub }}>Método: <b style={{ color: theme.text }}>{porDia ? 'por dia (proporcional)' : 'parcelas iguais'}</b></span>
          {temCorte && <span style={{ color: theme.sub }}>Saldo inicial (abertura {compInicio}): <b style={{ color: theme.accent }}>{money(saldoAbertura)}</b></span>}
        </div>
        {!linhas.length ? (
          <p style={{ color: theme.sub, fontSize: 13 }}>{porDia ? 'Preencha vigência início e fim (o valor sai proporcional aos dias).' : 'Preencha vigência início, nº de parcelas e valor da parcela.'}</p>
        ) : (
          <div style={{ border: `0.5px solid ${theme.border}`, borderRadius: 10, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
              <thead><tr style={{ background: theme.input }}>
                <th style={th}>#</th><th style={th}>Competência</th>{porDia && <th style={{ ...th, textAlign: 'right' }}>Dias</th>}<th style={{ ...th, textAlign: 'right' }}>Valor</th><th style={{ ...th, textAlign: 'right' }}>A apropriar após</th><th style={th}>Situação</th>
              </tr></thead>
              <tbody>
                {linhas.map(l => (
                  <tr key={l.i} style={{ borderTop: `1px solid ${theme.border}`, background: l.saldoIni ? 'rgba(74,124,255,0.08)' : 'transparent' }}>
                    <td style={{ ...td, color: theme.sub }}>{l.i}</td>
                    <td style={td}>{l.comp}</td>
                    {porDia && <td style={{ ...td, textAlign: 'right', color: theme.sub }}>{l.dias}</td>}
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.val)}</td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', color: theme.sub }}>{money(l.restante)}</td>
                    <td style={{ ...td, fontSize: 12 }}>{l.saldoIni ? <span style={{ color: theme.accent }}>Saldo inicial</span> : <span style={{ color: theme.green }}>Apropria no mês</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>{porDia ? 'Por dia: o valor de cada mês é proporcional aos dias da vigência naquele mês (oscila um pouco). ' : ''}As parcelas de meses anteriores à abertura ({compInicio || 'defina a competência de início'}) formam o <b style={{ color: theme.text }}>saldo inicial</b> do ativo "a apropriar". As demais viram apropriação mês a mês.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={onClose}>Fechar</button></div>
      </div>
    </div>
  )
}

// ================= SEGURO =================
function PaneSeguro({ clienteId, user, competencia, abrirGerar, enviarSaldoInicial, compInicio, empresaNome, planoMap, versao }) {
  const { rows, loading, erro, recarregar, excluir } = useLista('seguros', clienteId)
  const aprops = useApropriacoes(clienteId, competencia, 'seguro', versao)
  const [cron, setCron] = useState(null)
  const [f, on, reset, setF] = useForm({ seguradora: '', apolice: '', ramo: '', vigencia_inicio: '', vigencia_fim: '', premio_total: '', num_parcelas: '12', valor_parcela: '', conta_despesa: '', conta_apropriar: '', conta_pagar: '', saldo_inicial: false, por_dia: false })
  const [sav, setSav] = useState(false)
  const [editId, setEditId] = useState(null)
  // Ao mexer no total ou no nº de parcelas, já traz a parcela calculada (editável).
  const setCampo = (k, v) => setF(x => { const n = { ...x, [k]: v }; if (k === 'premio_total' || k === 'num_parcelas') { const t = num(n.premio_total), np = Number(n.num_parcelas) || 0; if (t && np) n.valor_parcela = String(Math.round(t / np * 100) / 100) } return n })
  function cancelarEdicao() { reset(); setEditId(null) }
  function editar(r) {
    setF({ seguradora: r.seguradora || '', apolice: r.apolice || '', ramo: r.ramo || '', vigencia_inicio: r.vigencia_inicio || '', vigencia_fim: r.vigencia_fim || '', premio_total: r.premio_total != null ? String(r.premio_total) : '', num_parcelas: r.num_parcelas != null ? String(r.num_parcelas) : '', valor_parcela: r.valor_parcela != null ? String(r.valor_parcela) : '', conta_despesa: r.conta_despesa || '', conta_apropriar: r.conta_apropriar || '', conta_pagar: r.conta_pagar || '', saldo_inicial: !!r.saldo_inicial, por_dia: !!r.por_dia })
    setEditId(r.id); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function salvar(e) {
    e.preventDefault(); setSav(true)
    const row = { seguradora: f.seguradora, apolice: f.apolice, ramo: f.ramo, vigencia_inicio: f.vigencia_inicio || null, vigencia_fim: f.vigencia_fim || null, premio_total: num(f.premio_total), num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), conta_despesa: f.conta_despesa, conta_apropriar: f.conta_apropriar, conta_pagar: f.conta_pagar, saldo_inicial: !!f.saldo_inicial, por_dia: !!f.por_dia }
    try {
      if (editId) await atualizar('seguros', editId, row)
      else await inserir('seguros', { cliente_id: clienteId, ...row, usuario: user?.email })
      reset(); setEditId(null); recarregar()
    } catch (er) { alert(er.message) } finally { setSav(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-shield-half" style={{ color: ACC.seguro }} /> {editId ? 'Editar contrato de seguro' : 'Novo contrato de seguro'}</>}>
        <SecSub>Cadastre a apólice — depois gere a apropriação do mês, que vira lançamento.{editId && <b style={{ color: ACC.seguro }}> Editando um contrato.</b>}</SecSub>
        {!editId && <LeitorIA tipo="seguro" acento={ACC.seguro} onExtraido={d => aplicarIA(setF, d)} />}
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Seguradora"><input className="input" value={f.seguradora} onChange={on('seguradora')} required /></Field>
          <Field label="Apólice"><input className="input" value={f.apolice} onChange={on('apolice')} /></Field>
          <Field label="Ramo"><input className="input" value={f.ramo} onChange={on('ramo')} /></Field>
          <Field label="Prêmio total"><input className="input" value={f.premio_total} onChange={e => setCampo('premio_total', e.target.value)} placeholder="0,00" /></Field>
          <Field label="Vigência início"><input className="input" type="date" value={f.vigencia_inicio} onChange={on('vigencia_inicio')} /></Field>
          <Field label="Vigência fim"><input className="input" type="date" value={f.vigencia_fim} onChange={on('vigencia_fim')} /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={e => setCampo('num_parcelas', e.target.value)} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Conta despesa (D)"><CampoContaForm valor={f.conta_despesa} set={v => setF(x => ({ ...x, conta_despesa: v }))} /></Field>
          <Field label="Conta a apropriar / ativo"><CampoContaForm valor={f.conta_apropriar} set={v => setF(x => ({ ...x, conta_apropriar: v }))} /></Field>
          <Field label="Conta a pagar / passivo"><CampoContaForm valor={f.conta_pagar} set={v => setF(x => ({ ...x, conta_pagar: v }))} /></Field>
          <Field label="É saldo inicial?"><label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', height: 38, color: theme.text }} title="Marque se o contrato começou ANTES do início do cliente — alimenta só o ativo (a apropriar) na abertura"><input type="checkbox" checked={!!f.saldo_inicial} onChange={e => setF(x => ({ ...x, saldo_inicial: e.target.checked }))} /> contrato anterior à abertura</label></Field>
          <Field label="Apropriar por dia?"><label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', height: 38, color: theme.text }} title="Proporcional aos dias de cada mês (oscila mês a mês). Requer vigência início e fim."><input type="checkbox" checked={!!f.por_dia} onChange={e => setF(x => ({ ...x, por_dia: e.target.checked }))} /> proporcional aos dias</label></Field>
          <div style={{ gridColumn: 'span 4', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button className="btn" disabled={sav}>{sav ? 'Salvando…' : editId ? 'Salvar alterações' : '＋ Salvar contrato'}</button>
            {editId && <button type="button" className="btn btn-ghost" onClick={cancelarEdicao}>Cancelar edição</button>}
          </div>
        </form>
      </FormCard>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <SecTitle>Contratos de seguro ({rows.length})</SecTitle>
          <BotoesRelatorio origem="seguro" rows={rows} competencia={competencia} empresaNome={empresaNome} planoMap={planoMap} />
        </div>
        {erro && <p style={{ color: theme.red, fontSize: 13 }}>{erro}</p>}
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}><thead><tr>{['Seguradora', 'Apólice', 'Ramo', 'Prêmio', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {loading ? <Vazio colSpan={6} texto="Carregando…" /> : rows.length === 0 ? <Vazio colSpan={6} texto="Nenhum contrato cadastrado ainda." /> : rows.map(r => {
            const apropriado = contratoApropriado(r, aprops, 'seguro')
            return (
            <tr key={r.id}>
              <td style={td}><b>{r.seguradora}</b>{apropriado && <div style={{ marginTop: 4 }}><SeloApropriado competencia={competencia} /></div>}</td><td style={td}>{r.apolice}</td><td style={td}>{r.ramo}</td>
              <td style={{ ...td, textAlign: 'right' }}>{money(r.premio_total)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => editar(r)} title="Editar contrato"><i className="ti ti-pencil" /> Editar</button>{' '}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCron(r)} title="Ver o cronograma de apropriações"><i className="ti ti-list-check" /> Apropriações</button>{' '}
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_apropriar, valor: valorApropriacaoMes(r, competencia), historico: `${`Apropriação seguro ${r.seguradora} ${r.apolice || ''}`.trim()}${sufixoParcela(r, competencia)}`, origem: 'seguro', documento: r.apolice }, `Apropriação — ${r.seguradora}`)}>{apropriado ? 'Apropriar de novo' : 'Apropriação do mês'}</GerarBtn>{' '}
                {r.saldo_inicial
                  ? <SaldoIniBtn onClick={() => enviarSaldoInicial('seguro', r)} />
                  : <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_apropriar, conta_credito: r.conta_pagar, valor: r.premio_total, historico: `Contrato seguro ${r.seguradora} ${r.apolice || ''}`.trim(), origem: 'seguro', documento: r.apolice }, `Contrato — ${r.seguradora}`)}>Contabilizar contrato</GerarBtn>}{' '}
                <AnexoContrato tabela="seguros" row={r} onChange={recarregar} />{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td>
            </tr>
          )})}
        </tbody></table></div>
      </Card>
      {cron && <ModalCronograma contrato={cron} origem="seguro" compInicio={compInicio} onClose={() => setCron(null)} />}
    </div>
  )
}

// ================= DESPESA A APROPRIAR =================
// Funciona como o seguro, mas genérico: IPVA, IPTU, aluguel antecipado, etc.
function PaneDespesaApropriar({ clienteId, user, competencia, abrirGerar, enviarSaldoInicial, compInicio, empresaNome, planoMap, versao }) {
  const { rows, loading, erro, recarregar, excluir } = useLista('despesas_apropriar', clienteId)
  const aprops = useApropriacoes(clienteId, competencia, 'despesa', versao)
  const [cron, setCron] = useState(null)
  const [f, on, reset, setF] = useForm({ tipo: '', descricao: '', documento: '', valor_total: '', vigencia_inicio: '', vigencia_fim: '', num_parcelas: '12', valor_parcela: '', conta_despesa: '', conta_apropriar: '', conta_pagar: '', saldo_inicial: false, por_dia: false })
  const [sav, setSav] = useState(false)
  const [editId, setEditId] = useState(null)
  const setCampo = (k, v) => setF(x => { const n = { ...x, [k]: v }; if (k === 'valor_total' || k === 'num_parcelas') { const t = num(n.valor_total), np = Number(n.num_parcelas) || 0; if (t && np) n.valor_parcela = String(Math.round(t / np * 100) / 100) } return n })
  function cancelarEdicao() { reset(); setEditId(null) }
  function editar(r) {
    setF({ tipo: r.tipo || '', descricao: r.descricao || '', documento: r.documento || '', valor_total: r.valor_total != null ? String(r.valor_total) : '', vigencia_inicio: r.vigencia_inicio || '', vigencia_fim: r.vigencia_fim || '', num_parcelas: r.num_parcelas != null ? String(r.num_parcelas) : '', valor_parcela: r.valor_parcela != null ? String(r.valor_parcela) : '', conta_despesa: r.conta_despesa || '', conta_apropriar: r.conta_apropriar || '', conta_pagar: r.conta_pagar || '', saldo_inicial: !!r.saldo_inicial, por_dia: !!r.por_dia })
    setEditId(r.id); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function salvar(e) {
    e.preventDefault(); setSav(true)
    const row = { tipo: f.tipo, descricao: f.descricao, documento: f.documento, valor_total: num(f.valor_total), vigencia_inicio: f.vigencia_inicio || null, vigencia_fim: f.vigencia_fim || null, num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), conta_despesa: f.conta_despesa, conta_apropriar: f.conta_apropriar, conta_pagar: f.conta_pagar, saldo_inicial: !!f.saldo_inicial, por_dia: !!f.por_dia }
    try {
      if (editId) await atualizar('despesas_apropriar', editId, row)
      else await inserir('despesas_apropriar', { cliente_id: clienteId, ...row, usuario: user?.email })
      reset(); setEditId(null); recarregar()
    } catch (er) { alert(er.message) } finally { setSav(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-calendar-repeat" style={{ color: ACC.despesa }} /> {editId ? 'Editar despesa a apropriar' : 'Nova despesa a apropriar'}</>}>
        <SecSub>IPVA, IPTU, aluguel antecipado, licenças… Cadastre uma vez e gere a apropriação do mês. O saldo que falta apropriar pode ir direto ao saldo inicial.{editId && <b style={{ color: ACC.despesa }}> Editando.</b>}</SecSub>
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Tipo (IPVA, IPTU…)"><input className="input" value={f.tipo} onChange={on('tipo')} placeholder="IPVA" required /></Field>
          <Field label="Descrição"><input className="input" value={f.descricao} onChange={on('descricao')} placeholder="Placa ABC1D23 / imóvel matriz" /></Field>
          <Field label="Documento"><input className="input" value={f.documento} onChange={on('documento')} /></Field>
          <Field label="Valor total"><input className="input" value={f.valor_total} onChange={e => setCampo('valor_total', e.target.value)} placeholder="0,00" /></Field>
          <Field label="Vigência início"><input className="input" type="date" value={f.vigencia_inicio} onChange={on('vigencia_inicio')} /></Field>
          <Field label="Vigência fim"><input className="input" type="date" value={f.vigencia_fim} onChange={on('vigencia_fim')} /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={e => setCampo('num_parcelas', e.target.value)} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Conta despesa (D)"><CampoContaForm valor={f.conta_despesa} set={v => setF(x => ({ ...x, conta_despesa: v }))} /></Field>
          <Field label="Conta a apropriar / ativo"><CampoContaForm valor={f.conta_apropriar} set={v => setF(x => ({ ...x, conta_apropriar: v }))} /></Field>
          <Field label="Conta a pagar / passivo"><CampoContaForm valor={f.conta_pagar} set={v => setF(x => ({ ...x, conta_pagar: v }))} /></Field>
          <Field label="É saldo inicial?"><label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', height: 38, color: theme.text }} title="Marque se começou ANTES do início do cliente — alimenta só o ativo (a apropriar) na abertura"><input type="checkbox" checked={!!f.saldo_inicial} onChange={e => setF(x => ({ ...x, saldo_inicial: e.target.checked }))} /> contrato anterior à abertura</label></Field>
          <Field label="Apropriar por dia?"><label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', height: 38, color: theme.text }} title="Proporcional aos dias de cada mês (oscila mês a mês). Requer vigência início e fim."><input type="checkbox" checked={!!f.por_dia} onChange={e => setF(x => ({ ...x, por_dia: e.target.checked }))} /> proporcional aos dias</label></Field>
          <div style={{ gridColumn: 'span 4', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button className="btn" disabled={sav}>{sav ? 'Salvando…' : editId ? 'Salvar alterações' : '＋ Salvar despesa'}</button>
            {editId && <button type="button" className="btn btn-ghost" onClick={cancelarEdicao}>Cancelar edição</button>}
          </div>
        </form>
      </FormCard>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <SecTitle>Despesas a apropriar ({rows.length})</SecTitle>
          <BotoesRelatorio origem="despesa" rows={rows} competencia={competencia} empresaNome={empresaNome} planoMap={planoMap} />
        </div>
        {erro && <p style={{ color: theme.red, fontSize: 13 }}>{erro}</p>}
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}><thead><tr>{['Tipo', 'Descrição', 'Total', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {loading ? <Vazio colSpan={5} texto="Carregando…" /> : rows.length === 0 ? <Vazio colSpan={5} texto="Nenhuma despesa cadastrada ainda." /> : rows.map(r => {
            const apropriado = contratoApropriado(r, aprops, 'despesa')
            return (
            <tr key={r.id}>
              <td style={td}><b>{r.tipo}</b>{apropriado && <div style={{ marginTop: 4 }}><SeloApropriado competencia={competencia} /></div>}</td><td style={td}>{r.descricao}</td>
              <td style={{ ...td, textAlign: 'right' }}>{money(r.valor_total)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => editar(r)} title="Editar despesa"><i className="ti ti-pencil" /> Editar</button>{' '}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCron(r)} title="Ver o cronograma de apropriações"><i className="ti ti-list-check" /> Apropriações</button>{' '}
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_apropriar, valor: valorApropriacaoMes(r, competencia), historico: `${`Apropriação ${r.tipo} ${r.descricao || ''}`.trim()}${sufixoParcela(r, competencia)}`, origem: 'despesa', documento: r.documento }, `Apropriação — ${r.tipo}`)}>{apropriado ? 'Apropriar de novo' : 'Apropriação do mês'}</GerarBtn>{' '}
                {r.saldo_inicial
                  ? <SaldoIniBtn onClick={() => enviarSaldoInicial('despesa', r)} />
                  : <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_apropriar, conta_credito: r.conta_pagar, valor: r.valor_total, historico: `Contrato ${r.tipo} ${r.descricao || ''}`.trim(), origem: 'despesa', documento: r.documento }, `Contrato — ${r.tipo}`)}>Contabilizar contrato</GerarBtn>}{' '}
                <AnexoContrato tabela="despesas_apropriar" row={r} onChange={recarregar} />{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td>
            </tr>
          )})}
        </tbody></table></div>
      </Card>
      {cron && <ModalCronograma contrato={cron} origem="despesa" compInicio={compInicio} onClose={() => setCron(null)} />}
    </div>
  )
}

// ================= IMPORTAÇÃO =================
function PaneImportacao({ clienteId, user, competencia, abrirGerar }) {
  const proc = useLista('importacoes', clienteId)
  const adiant = useLista('adiantamentos_importacao', clienteId)
  const [f, on, reset, setF] = useForm({ numero: '', di: '', fornecedor: '', mercadoria: '', invoice_moeda: 'USD', invoice_valor: '', cambio: '', custo_total: '' })
  const [fa, ona, resetA] = useForm({ fornecedor: '', data: '', valor: '' })
  async function salvarProc(e) { e.preventDefault(); try { await inserir('importacoes', { cliente_id: clienteId, numero: f.numero, di: f.di, fornecedor: f.fornecedor, mercadoria: f.mercadoria, invoice_moeda: f.invoice_moeda, invoice_valor: num(f.invoice_valor), cambio: num(f.cambio), custo_total: num(f.custo_total), usuario: user?.email }); reset(); proc.recarregar() } catch (er) { alert(er.message) } }
  async function salvarAdiant(e) { e.preventDefault(); try { await inserir('adiantamentos_importacao', { cliente_id: clienteId, fornecedor: fa.fornecedor, data: fa.data || null, valor: num(fa.valor), usuario: user?.email }); resetA(); adiant.recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-cash" style={{ color: ACC.importacao }} /> Adiantamento de importação</>}>
        <SecSub>Registre o adiantamento ao fornecedor do exterior. Fica em controle até o processo chegar.</SecSub>
        <form onSubmit={salvarAdiant} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
          <Field label="Fornecedor (exterior)"><input className="input" value={fa.fornecedor} onChange={ona('fornecedor')} required /></Field>
          <Field label="Data"><input className="input" type="date" value={fa.data} onChange={ona('data')} /></Field>
          <Field label="Valor"><input className="input" value={fa.valor} onChange={ona('valor')} placeholder="0,00" /></Field>
          <button className="btn">＋ Adiantamento</button>
        </form>
        <div style={{ overflowX: 'auto', marginTop: 12 }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Fornecedor', 'Data', 'Valor', 'Situação', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {adiant.rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum adiantamento." /> : adiant.rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.fornecedor}</b></td><td style={td}>{r.data || ''}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor)}</td><td style={td}>{r.processo_id ? 'vinculado' : 'aguardando processo'}</td><td style={{ ...td, textAlign: 'right' }}><DelBtn onClick={() => adiant.excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </FormCard>
      <FormCard titulo={<><i className="ti ti-ship" style={{ color: ACC.importacao }} /> Novo processo de importação</>}>
        <LeitorIA tipo="importacao" acento={ACC.importacao} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvarProc} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Nº processo"><input className="input" value={f.numero} onChange={on('numero')} required /></Field>
          <Field label="DI / DUIMP"><input className="input" value={f.di} onChange={on('di')} /></Field>
          <Field label="Fornecedor"><input className="input" value={f.fornecedor} onChange={on('fornecedor')} /></Field>
          <Field label="Mercadoria"><input className="input" value={f.mercadoria} onChange={on('mercadoria')} /></Field>
          <Field label="Moeda"><input className="input" value={f.invoice_moeda} onChange={on('invoice_moeda')} /></Field>
          <Field label="Invoice"><input className="input" value={f.invoice_valor} onChange={on('invoice_valor')} placeholder="0,00" /></Field>
          <Field label="Câmbio"><input className="input" value={f.cambio} onChange={on('cambio')} placeholder="0,0000" /></Field>
          <Field label="Custo total (R$)"><input className="input" value={f.custo_total} onChange={on('custo_total')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar processo</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>Processos armazenados ({proc.rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}><thead><tr>{['Processo', 'Fornecedor', 'Custo', 'Status', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {proc.rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum processo." /> : proc.rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.numero}</b></td><td style={td}>{r.fornecedor}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.custo_total)}</td><td style={td}>{r.status}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: '1.1.4.09', conta_credito: '2.1.1.11', valor: r.custo_total, historico: `Importação ${r.numero} — ${r.fornecedor || ''}`.trim(), origem: 'importacao', documento: r.numero }, `Custo — ${r.numero}`)}>Lançar custo</GerarBtn>{' '}
                <DelBtn onClick={() => proc.excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= EMPRÉSTIMO =================
function PaneEmprestimo({ clienteId, user }) {
  const { rows, recarregar, excluir } = useLista('emprestimos', clienteId)
  const [f, on, reset, setF] = useForm({ banco: '', contrato: '', modalidade: '', valor: '', prazo: '', taxa_mensal: '', valor_parcela: '', saldo_devedor: '' })
  async function salvar(e) { e.preventDefault(); try { await inserir('emprestimos', { cliente_id: clienteId, banco: f.banco, contrato: f.contrato, modalidade: f.modalidade, valor: num(f.valor), prazo: Number(f.prazo) || null, taxa_mensal: num(f.taxa_mensal), valor_parcela: num(f.valor_parcela), saldo_devedor: num(f.saldo_devedor), usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-building-bank" style={{ color: ACC.emprestimo }} /> Novo contrato de empréstimo</>}>
        <SecSub>O empréstimo <b>não gera lançamento</b> — serve de referência para conferir com a Conciliação.</SecSub>
        <LeitorIA tipo="emprestimo" acento={ACC.emprestimo} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Banco"><input className="input" value={f.banco} onChange={on('banco')} required /></Field>
          <Field label="Contrato"><input className="input" value={f.contrato} onChange={on('contrato')} /></Field>
          <Field label="Modalidade"><input className="input" value={f.modalidade} onChange={on('modalidade')} /></Field>
          <Field label="Valor"><input className="input" value={f.valor} onChange={on('valor')} placeholder="0,00" /></Field>
          <Field label="Prazo (x)"><input className="input" value={f.prazo} onChange={on('prazo')} /></Field>
          <Field label="Taxa % a.m."><input className="input" value={f.taxa_mensal} onChange={on('taxa_mensal')} /></Field>
          <Field label="Parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Saldo devedor"><input className="input" value={f.saldo_devedor} onChange={on('saldo_devedor')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar contrato</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>Contratos armazenados ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}><thead><tr>{['Banco', 'Contrato', 'Saldo devedor', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum contrato." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.banco}</b></td><td style={td}>{r.contrato}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.saldo_devedor)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td><td style={{ ...td, textAlign: 'right' }}><DelBtn onClick={() => excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= PARCELAMENTO =================
function PaneParcelamento({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('parcelamentos', clienteId)
  const [f, on, reset, setF] = useForm({ orgao: '', numero: '', tributo: '', consolidado: '', num_parcelas: '', valor_parcela: '', saldo_devedor: '', juros_multa_mes: '', conta_despesa: '4.3.1.05', conta_passivo: '2.1.2.20' })
  async function salvar(e) { e.preventDefault(); try { await inserir('parcelamentos', { cliente_id: clienteId, orgao: f.orgao, numero: f.numero, tributo: f.tributo, consolidado: num(f.consolidado), num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), saldo_devedor: num(f.saldo_devedor), juros_multa_mes: num(f.juros_multa_mes), conta_despesa: f.conta_despesa, conta_passivo: f.conta_passivo, usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-receipt" style={{ color: ACC.parcelamento }} /> Novo parcelamento de impostos</>}>
        <SecSub>A única contabilização é a <b>atualização de juros e multa</b>. A parcela (principal) vem do banco, na conciliação.</SecSub>
        <LeitorIA tipo="parcelamento" acento={ACC.parcelamento} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Órgão"><input className="input" value={f.orgao} onChange={on('orgao')} placeholder="PGFN / Sefaz…" required /></Field>
          <Field label="Nº parcelamento"><input className="input" value={f.numero} onChange={on('numero')} /></Field>
          <Field label="Tributo"><input className="input" value={f.tributo} onChange={on('tributo')} /></Field>
          <Field label="Consolidado"><input className="input" value={f.consolidado} onChange={on('consolidado')} placeholder="0,00" /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={on('num_parcelas')} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Saldo devedor"><input className="input" value={f.saldo_devedor} onChange={on('saldo_devedor')} placeholder="0,00" /></Field>
          <Field label="Juros/multa do mês"><input className="input" value={f.juros_multa_mes} onChange={on('juros_multa_mes')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar parcelamento</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>Parcelamentos armazenados ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}><thead><tr>{['Órgão', 'Nº', 'Saldo', 'Juros/multa mês', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum parcelamento." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.orgao}</b></td><td style={td}>{r.numero}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.saldo_devedor)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.juros_multa_mes)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_passivo, valor: r.juros_multa_mes, historico: `Juros e multa parcelamento ${r.orgao} ${r.numero || ''}`.trim(), origem: 'parcelamento', documento: r.numero }, `Juros/multa — ${r.orgao}`)}>Juros/multa do mês</GerarBtn>{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= EQUIVALÊNCIA =================
function PaneEquivalencia({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('participacoes', clienteId)
  const [f, on, reset, setF] = useForm({ investida: '', vinculo: 'Coligada', participacao_pct: '', valor_investimento: '', conta_investimento: '1.2.1.03', conta_resultado: '4.3.2.01' })
  const [res, setRes] = useState({}) // id -> resultado do mês digitado
  async function salvar(e) { e.preventDefault(); try { await inserir('participacoes', { cliente_id: clienteId, investida: f.investida, vinculo: f.vinculo, participacao_pct: num(f.participacao_pct), valor_investimento: num(f.valor_investimento), conta_investimento: f.conta_investimento, conta_resultado: f.conta_resultado, usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  function gerarMEP(r) {
    const resultado = num(res[r.id] || 0)
    const mep = Math.round(resultado * (Number(r.participacao_pct) / 100) * 100) / 100
    if (!mep) { alert('Informe o resultado da investida no mês.'); return }
    const lucro = mep > 0
    abrirGerar({
      data: dataComp(competencia), valor: Math.abs(mep),
      conta_debito: lucro ? r.conta_investimento : r.conta_resultado,
      conta_credito: lucro ? r.conta_resultado : r.conta_investimento,
      historico: `Equivalência patrimonial ${r.investida} (${r.participacao_pct}%)`, origem: 'equivalencia', documento: r.investida,
    }, `MEP — ${r.investida}`)
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-scale" style={{ color: ACC.equivalencia }} /> Nova participação societária</>}>
        <SecSub>Cadastre a investida. Para gerar a MEP, informe o <b>resultado da investida no mês</b> na tabela abaixo.</SecSub>
        <LeitorIA tipo="participacao" acento={ACC.equivalencia} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Investida"><input className="input" value={f.investida} onChange={on('investida')} required /></Field>
          <Field label="Vínculo"><select className="input" value={f.vinculo} onChange={on('vinculo')}><option>Coligada</option><option>Controlada</option></select></Field>
          <Field label="Participação %"><input className="input" value={f.participacao_pct} onChange={on('participacao_pct')} placeholder="30" /></Field>
          <Field label="Valor investimento"><input className="input" value={f.valor_investimento} onChange={on('valor_investimento')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar participação</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>Participações ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}><thead><tr>{['Investida', 'Vínculo', '%', 'Resultado da investida (mês)', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhuma participação." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.investida}</b></td><td style={td}>{r.vinculo}</td><td style={{ ...td, textAlign: 'right' }}>{r.participacao_pct}%</td>
              <td style={td}><input className="input" style={{ maxWidth: 160 }} value={res[r.id] || ''} onChange={e => setRes(s => ({ ...s, [r.id]: e.target.value }))} placeholder="lucro + / prejuízo -" /></td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}><GerarBtn onClick={() => gerarMEP(r)}>Gerar MEP</GerarBtn>{' '}<DelBtn onClick={() => excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= PER/DCOMP =================
function PanePerdcomp({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('perdcomp', clienteId)
  const [f, on, reset, setF] = useForm({ numero_declaracao: '', data: '', credito_atualizado: '', valor_utilizado: '', tributo_compensado: '', conta_credito: '', conta_compensada: '', observacao: '' })
  async function salvar(e) {
    e.preventDefault()
    try {
      await inserir('perdcomp', { cliente_id: clienteId, numero_declaracao: f.numero_declaracao, data: f.data || null, credito_atualizado: num(f.credito_atualizado), valor_utilizado: num(f.valor_utilizado), tributo_compensado: f.tributo_compensado, conta_credito: f.conta_credito, conta_compensada: f.conta_compensada, observacao: f.observacao, usuario: user?.email })
      reset(); recarregar()
    } catch (er) { alert(er.message) }
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-arrows-exchange" style={{ color: ACC.perdcomp }} /> Novo PER/DCOMP</>}>
        <SecSub>Cadastre a <b>declaração de compensação</b>: o crédito (saldo atualizado) e o valor utilizado para compensar o débito do tributo. Em <b>Compensar</b>, a baixa gerada é <b>D tributo compensado / C crédito a recuperar</b> — reduzindo o saldo do crédito.</SecSub>
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Nº da declaração" col={2}><input className="input" value={f.numero_declaracao} onChange={on('numero_declaracao')} placeholder="02425.11562.170925.1.3.57-5287" required /></Field>
          <Field label="Data de transmissão"><input className="input" type="date" value={f.data} onChange={on('data')} /></Field>
          <Field label="Tributo compensado"><input className="input" value={f.tributo_compensado} onChange={on('tributo_compensado')} placeholder="IPI 5123-01 · ago/2025" /></Field>
          <Field label="Crédito atualizado (saldo)"><input className="input" value={f.credito_atualizado} onChange={on('credito_atualizado')} placeholder="0,00" /></Field>
          <Field label="Valor utilizado"><input className="input" value={f.valor_utilizado} onChange={on('valor_utilizado')} placeholder="0,00" /></Field>
          <Field label="Conta do crédito (ativo)"><CampoContaForm valor={f.conta_credito} set={v => setF(x => ({ ...x, conta_credito: v }))} /></Field>
          <Field label="Conta compensada (passivo)"><CampoContaForm valor={f.conta_compensada} set={v => setF(x => ({ ...x, conta_compensada: v }))} /></Field>
          <Field label="Observação" col={4}><input className="input" value={f.observacao} onChange={on('observacao')} placeholder="Origem do crédito (ação judicial, saldo negativo…)" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar PER/DCOMP</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>PER/DCOMP cadastrados ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}><thead><tr>{['Nº declaração', 'Data', 'Tributo', 'Saldo crédito', 'Utilizado', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={6} texto="Nenhum PER/DCOMP." /> : rows.map(r => (
            <tr key={r.id}><td style={{ ...td, fontFamily: 'monospace', fontSize: 11.5 }}>{r.numero_declaracao}</td><td style={td}>{r.data ? brData(r.data) : '—'}</td><td style={td}>{r.tributo_compensado}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.credito_atualizado)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_utilizado)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: r.data || dataComp(competencia), conta_debito: r.conta_compensada, conta_credito: r.conta_credito, valor: r.valor_utilizado, historico: `Compensação PER/DCOMP ${r.numero_declaracao || ''} · ${r.tributo_compensado || ''}`.trim(), origem: 'perdcomp', documento: r.numero_declaracao }, `Compensar — ${r.tributo_compensado || 'PER/DCOMP'}`)}>Compensar</GerarBtn>{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= JUROS SOBRE CAPITAL PRÓPRIO (JSCP) =================
function PaneJcp({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('jcp', clienteId)
  // IRRF do JSCP subiu para 17,5% em 2026 (era 15%). Vem preenchido, mas é editável.
  const [f, on, reset, setF] = useForm({ descricao: '', data_base: '', pl_ajustado: '', taxa_tjlp: '', valor_juros: '', limite_dedutibilidade: '', juros_provisionados: '', juros_a_pagar: '', irrf_pct: '17.5', irrf_valor: '', liquido: '', conta_despesa: '', conta_irrf: '', conta_pagar: '' })
  // Cálculos automáticos (sugestões, editáveis): juros = PL ajustado × taxa; IRRF = juros a pagar × %;
  // líquido = juros a pagar − IRRF. Não sobrescreve o que o usuário digitou manualmente.
  const jurosCalc = Math.round(num(f.pl_ajustado) * num(f.taxa_tjlp)) / 100
  const irrfCalc = Math.round(num(f.juros_a_pagar) * num(f.irrf_pct)) / 100
  const liqCalc = Math.round((num(f.juros_a_pagar) - (num(f.irrf_valor) || irrfCalc)) * 100) / 100
  async function salvar(e) {
    e.preventDefault()
    try {
      await inserir('jcp', {
        cliente_id: clienteId, descricao: f.descricao, data_base: f.data_base || null,
        pl_ajustado: num(f.pl_ajustado), taxa_tjlp: num(f.taxa_tjlp),
        valor_juros: num(f.valor_juros) || jurosCalc, limite_dedutibilidade: num(f.limite_dedutibilidade),
        juros_provisionados: num(f.juros_provisionados), juros_a_pagar: num(f.juros_a_pagar),
        irrf_pct: num(f.irrf_pct), irrf_valor: num(f.irrf_valor) || irrfCalc, liquido: num(f.liquido) || liqCalc,
        conta_despesa: f.conta_despesa, conta_irrf: f.conta_irrf, conta_pagar: f.conta_pagar, usuario: user?.email,
      })
      reset(); recarregar()
    } catch (er) { alert(er.message) }
  }
  const dataDe = r => r.data_base || dataComp(competencia)
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <FormCard titulo={<><i className="ti ti-coins" style={{ color: ACC.jcp }} /> Novo cálculo de JSCP</>}>
        <SecSub>Memória do <b>juros sobre capital próprio</b>: PL ajustado × TJLP (pró-rata), menos os juros já provisionados, dá o <b>valor a pagar na data base</b>. Contabilização em duas partidas: <b>D Despesa JSCP / C JSCP a pagar</b> (bruto) e <b>D JSCP a pagar / C IRRF a recolher</b> (retenção).</SecSub>
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Descrição" col={2}><input className="input" value={f.descricao} onChange={on('descricao')} placeholder="JSCP 06/2026" /></Field>
          <Field label="Data base"><input className="input" type="date" value={f.data_base} onChange={on('data_base')} /></Field>
          <Field label="PL ajustado (base)"><input className="input" value={f.pl_ajustado} onChange={on('pl_ajustado')} placeholder="0,00" /></Field>
          <Field label="Taxa TJLP % (pró-rata)"><input className="input" value={f.taxa_tjlp} onChange={on('taxa_tjlp')} placeholder="4,5025" /></Field>
          <Field label="Valor dos juros"><input className="input" value={f.valor_juros} onChange={on('valor_juros')} placeholder={jurosCalc ? fmtNum(jurosCalc) : '0,00'} /></Field>
          <Field label="Limite dedutibilidade"><input className="input" value={f.limite_dedutibilidade} onChange={on('limite_dedutibilidade')} placeholder="0,00" /></Field>
          <Field label="Juros já provisionados"><input className="input" value={f.juros_provisionados} onChange={on('juros_provisionados')} placeholder="0,00" /></Field>
          <Field label="Juros a pagar (data base)"><input className="input" value={f.juros_a_pagar} onChange={on('juros_a_pagar')} placeholder="0,00" required /></Field>
          <Field label="IRRF % (17,5% em 2026)"><input className="input" value={f.irrf_pct} onChange={on('irrf_pct')} placeholder="17,5" /></Field>
          <Field label="IRRF valor"><input className="input" value={f.irrf_valor} onChange={on('irrf_valor')} placeholder={irrfCalc ? fmtNum(irrfCalc) : '0,00'} /></Field>
          <Field label="Líquido a pagar"><input className="input" value={f.liquido} onChange={on('liquido')} placeholder={liqCalc ? fmtNum(liqCalc) : '0,00'} /></Field>
          <Field label="Conta despesa JSCP"><CampoContaForm valor={f.conta_despesa} set={v => setF(x => ({ ...x, conta_despesa: v }))} /></Field>
          <Field label="Conta IRRF a recolher"><CampoContaForm valor={f.conta_irrf} set={v => setF(x => ({ ...x, conta_irrf: v }))} /></Field>
          <Field label="Conta JSCP a pagar"><CampoContaForm valor={f.conta_pagar} set={v => setF(x => ({ ...x, conta_pagar: v }))} /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar cálculo</button></div>
        </form>
      </FormCard>
      <Card>
        <SecTitle>Cálculos de JSCP ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}><thead><tr>{['Descrição', 'Data base', 'PL ajustado', 'A pagar', 'IRRF', 'Líquido', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={7} texto="Nenhum cálculo de JSCP." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.descricao || '—'}</b></td><td style={td}>{r.data_base ? brData(r.data_base) : '—'}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.pl_ajustado)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.juros_a_pagar)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.irrf_valor)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.liquido)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataDe(r), conta_debito: r.conta_despesa, conta_credito: r.conta_pagar, valor: r.juros_a_pagar, historico: `JSCP ${r.descricao || ''} · provisão`.trim(), origem: 'jcp', documento: r.descricao }, `Provisão JSCP — ${r.descricao || ''}`)}>Provisão</GerarBtn>{' '}
                {num(r.irrf_valor) > 0 && <><GerarBtn onClick={() => abrirGerar({ data: dataDe(r), conta_debito: r.conta_pagar, conta_credito: r.conta_irrf, valor: r.irrf_valor, historico: `JSCP ${r.descricao || ''} · IRRF (DARF 5706)`.trim(), origem: 'jcp', documento: r.descricao }, `IRRF JSCP — ${r.descricao || ''}`)}>IRRF</GerarBtn>{' '}</>}
                <DelBtn onClick={() => excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= LALUR (IRPJ e CSLL — Lucro Real) =================
const MESES_LALUR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

function PaneLalur({ clienteId, competencia, regime, abrirGerar, planoMap, user }) { // eslint-disable-line no-unused-vars
  const trimestral = /TRIMESTRAL/i.test(regime)
  const [carregando, setCarregando] = useState(true)
  const [cfg, setCfg] = useState(null)
  const [auto, setAuto] = useState(null)   // valores calculados (defaults)
  const [f, setF] = useState(null)         // linhas editáveis

  useEffect(() => {
    let vivo = true
    setCarregando(true); setF(null)
    ;(async () => {
      const [cm, ca] = String(competencia || '').split('/').map(Number)
      const inicioMes = trimestral ? Math.floor((cm - 1) / 3) * 3 + 1 : 1
      const mesesPeriodo = []; for (let m = inicioMes; m <= cm; m++) mesesPeriodo.push(m)
      // Configuração do Lucro Real (Base de Informações).
      const { data: cfgRow } = await supabase.from('cargas_cadastro').select('dados')
        .eq('cliente_id', clienteId).eq('tipo', 'lalur').order('created_at', { ascending: false }).limit(1).maybeSingle()
      const config = (cfgRow?.dados && typeof cfgRow.dados === 'object' && !Array.isArray(cfgRow.dados)) ? cfgRow.dados : {}
      // Lucro do Balancete = resultado acumulado do Comparativo (vivo, com ajustes).
      const { matriz } = await apurarVariacoes(clienteId, { comLancamentos: true })
      const lucroMes = m => { let s = 0; for (const c of Object.keys(matriz)) { const v = matriz[c]?.[m]; if (v != null) s += Number(v) || 0 } return -s }
      const lucro = r2(mesesPeriodo.reduce((s, m) => s + lucroMes(m), 0))
      // Movimento das contas cadastradas (adição/exclusão/IRRF), no período.
      const { data: comps } = await supabase.from('competencias').select('id, mes').eq('cliente_id', clienteId).eq('ano', ca)
      const idsPeriodo = (comps || []).filter(c => mesesPeriodo.includes(c.mes)).map(c => c.id)
      let balRows = []
      if (idsPeriodo.length) { const { data } = await supabase.from('balancete').select('conta, saldo_final').in('competencia_id', idsPeriodo); balRows = data || [] }
      const soma = lista => { const set = new Set((lista || []).map(x => String(x.cod))); if (!set.size) return 0; let s = 0; for (const b of balRows) if (set.has(String(b.conta))) s += Math.abs(Number(b.saldo_final) || 0); return r2(s) }
      // Despesas marcadas INDEDUTÍVEIS no Comparativo (por lançamento) no período → adição.
      // Ignora as que já estão em contas de adição cadastradas (para não contar em dobro).
      let indedutivel = 0
      if (idsPeriodo.length) {
        const { data: deds } = await supabase.from('auditoria').select('razao_id')
          .eq('modulo', 'Comparativo').eq('dedutibilidade', 'Indedutível').not('razao_id', 'is', null).in('competencia_id', idsPeriodo)
        const ids = (deds || []).map(d => d.razao_id).filter(Boolean)
        if (ids.length) {
          const { data: rz } = await supabase.from('razao').select('id, conta, debito, credito').in('id', ids)
          const contasAdic = new Set((config.adicao || []).map(x => String(x.cod)))
          for (const r of (rz || [])) { if (contasAdic.has(String(r.conta))) continue; indedutivel += Math.abs((Number(r.debito) || 0) - (Number(r.credito) || 0)) }
        }
      }
      if (!vivo) return
      const a = {
        lucro, nMeses: mesesPeriodo.length,
        adicao: r2(soma(config.adicao) + indedutivel), exclusao: soma(config.exclusao),
        irrf: soma(config.irrf), irrfAplic: soma(config.irrfAplic),
        indedutivel: r2(indedutivel),
        periodo: `${MESES_LALUR[inicioMes - 1]}–${MESES_LALUR[cm - 1]}/${ca}`,
      }
      setCfg(config); setAuto(a)
      setF({ lucro: a.lucro, adicao: a.adicao, exclusao: a.exclusao, prejuizo: Number(config.prejuizo) || 0, irrf: a.irrf, irrfAplic: a.irrfAplic, antIrpj: 0, antCsll: 0 })
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [clienteId, competencia, regime, trimestral])

  if (carregando || !f) return <Card><p style={{ color: theme.sub, fontSize: 13 }}><i className="ti ti-loader" /> Montando a memória do LALUR ({competencia})…</p></Card>

  const lucro = num(f.lucro), adicao = num(f.adicao), exclusao = num(f.exclusao), prejuizo = num(f.prejuizo)
  const irrf = num(f.irrf), irrfAplic = num(f.irrfAplic)
  const lucroFiscal = r2(lucro + adicao - exclusao)
  const limite30 = lucroFiscal > 0 ? r2(lucroFiscal * 0.30) : 0
  const compensa = r2(Math.min(prejuizo, limite30))
  const base = Math.max(0, r2(lucroFiscal - compensa))
  const irpj15 = r2(base * 0.15)
  const limiteAdic = 20000 * auto.nMeses
  const adicional = r2(Math.max(0, base - limiteAdic) * 0.10)
  const irpjDevido = r2(irpj15 + adicional)
  const csll = r2(base * 0.09)
  const retTotal = r2(irrf + irrfAplic)
  const irpjProvisionar = r2(Math.max(0, irpjDevido - num(f.antIrpj)))
  const csllProvisionar = r2(Math.max(0, csll - num(f.antCsll)))
  const irpjAPagar = r2(irpjDevido - retTotal - num(f.antIrpj))
  const csllAPagar = r2(csll - num(f.antCsll))

  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const contas = cfg?.contas || {}
  const faltaConta = (a, b) => !String(contas[a] || '').trim() || !String(contas[b] || '').trim()
  const semCad = !cfg || (!(cfg.adicao || []).length && !(cfg.exclusao || []).length && !contas.irpjDesp)

  const InputCel = ({ k }) => <input className="input" style={{ maxWidth: 150, textAlign: 'right', padding: '5px 8px' }} value={f[k]} onChange={set(k)} onBlur={e => setF(x => ({ ...x, [k]: r2(num(e.target.value)) }))} />
  const Lin = ({ label, children, forte, neg }) => (
    <tr style={{ borderTop: `1px solid ${theme.border}`, background: forte ? theme.input : 'transparent', fontWeight: forte ? 700 : 400 }}>
      <td style={{ ...td, borderBottom: 'none' }}>{label}</td>
      <td style={{ ...td, borderBottom: 'none', textAlign: 'right', whiteSpace: 'nowrap', color: neg && '' }}>{children}</td>
    </tr>
  )
  const val = v => <span style={{ color: v < 0 ? theme.red : theme.text }}>{money(v)}</span>

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card style={{ borderLeft: `3px solid ${ACC.lalur}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <SecTitle><i className="ti ti-report-money" style={{ color: ACC.lalur }} /> Memória de cálculo — IRPJ e CSLL</SecTitle>
          <span style={{ fontSize: 12, color: theme.sub }}>{trimestral ? 'Lucro Real Trimestral' : 'Lucro Real Anual'} · período <b style={{ color: theme.text }}>{auto.periodo}</b> ({auto.nMeses} {auto.nMeses === 1 ? 'mês' : 'meses'})</span>
        </div>
        <SecSub>O <b>Lucro do Balancete</b> vem do resultado acumulado do Comparativo (vivo). Adições, exclusões e retenções vêm das contas do <b>Cadastro do Lucro Real</b> (Base de Informações) — você pode ajustar aqui.</SecSub>

        {semCad && <p style={{ color: theme.yellow, fontSize: 12.5, margin: '0 0 12px' }}><i className="ti ti-alert-triangle" /> Cadastro do Lucro Real vazio — preencha em <b>Base de Informações → Cadastro do Lucro Real</b> (contas de adição/exclusão, IRRF e de contabilização). Você ainda pode informar os valores à mão abaixo.</p>}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460, maxWidth: 620 }}>
            <tbody>
              <Lin label="Lucro do Balancete (acumulado)">{val(lucro)}</Lin>
              <Lin label={`( + ) Adições${auto.indedutivel > 0 ? ` · inclui ${money(auto.indedutivel)} indedutíveis` : ''}`}><InputCel k="adicao" /></Lin>
              <Lin label="( − ) Exclusões"><InputCel k="exclusao" /></Lin>
              <Lin label="( = ) Lucro Fiscal" forte>{val(lucroFiscal)}</Lin>
              <Lin label="Prejuízo a compensar (saldo)"><InputCel k="prejuizo" /></Lin>
              <Lin label={`( − ) Compensação (limite 30% = ${money(limite30)})`}>{val(-compensa)}</Lin>
              <Lin label="( = ) Base de Cálculo" forte>{val(base)}</Lin>
              <Lin label="IRPJ 15%">{val(irpj15)}</Lin>
              <Lin label={`IRPJ adicional 10% (acima de ${money(limiteAdic)})`}>{val(adicional)}</Lin>
              <Lin label="( = ) IRPJ devido" forte>{val(irpjDevido)}</Lin>
              <Lin label="( − ) IRRF retido na fonte"><InputCel k="irrf" /></Lin>
              <Lin label="( − ) IRRF s/ aplicação financeira"><InputCel k="irrfAplic" /></Lin>
              <Lin label="( − ) IRPJ já provisionado (antecipado)"><InputCel k="antIrpj" /></Lin>
              <Lin label="( = ) IRPJ a pagar" forte>{val(irpjAPagar)}</Lin>
              <Lin label="CSLL 9%">{val(csll)}</Lin>
              <Lin label="( − ) CSLL já provisionada (antecipado)"><InputCel k="antCsll" /></Lin>
              <Lin label="( = ) CSLL a pagar" forte>{val(csllAPagar)}</Lin>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SecTitle>Contabilizar</SecTitle>
        <SecSub>Gera a provisão do período (o que ainda não foi provisionado): <b>D despesa / C a pagar</b>. As contas vêm do Cadastro do Lucro Real.</SecSub>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" disabled={faltaConta('irpjDesp', 'irpjPagar') || irpjProvisionar <= 0}
            title={faltaConta('irpjDesp', 'irpjPagar') ? 'Cadastre as contas de IRPJ (despesa e a pagar) na Base de Informações.' : undefined}
            onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: contas.irpjDesp, conta_credito: contas.irpjPagar, valor: irpjProvisionar, historico: `IRPJ ${trimestral ? 'trimestral' : 'anual'} · ${auto.periodo} (Lucro Real)`, origem: 'lalur', documento: 'IRPJ ' + competencia }, `IRPJ — ${auto.periodo}`)}>
            <i className="ti ti-file-plus" /> Contabilizar IRPJ · {money(irpjProvisionar)}
          </button>
          <button className="btn" disabled={faltaConta('csllDesp', 'csllPagar') || csllProvisionar <= 0}
            title={faltaConta('csllDesp', 'csllPagar') ? 'Cadastre as contas de CSLL (despesa e a pagar) na Base de Informações.' : undefined}
            onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: contas.csllDesp, conta_credito: contas.csllPagar, valor: csllProvisionar, historico: `CSLL ${trimestral ? 'trimestral' : 'anual'} · ${auto.periodo} (Lucro Real)`, origem: 'lalur', documento: 'CSLL ' + competencia }, `CSLL — ${auto.periodo}`)}>
            <i className="ti ti-file-plus" /> Contabilizar CSLL · {money(csllProvisionar)}
          </button>
        </div>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '12px 0 0' }}>As retenções (IRRF) abatem o <b>a pagar</b> por compensação do ativo já registrado; nesta versão elas entram como informação do cálculo. A baixa da retenção contra o passivo pode ser feita depois, conforme formos evoluindo.</p>
      </Card>
    </div>
  )
}

// ================= OUTROS LANÇAMENTOS =================
function PaneOutros({ competencia, abrirGerar }) {
  const [f, on] = useForm({ data: dataComp(competencia), conta_debito: '', conta_credito: '', valor: '', historico: '' })
  return (
    <FormCard titulo={<><i className="ti ti-pencil-plus" style={{ color: ACC.outros }} /> Lançamento avulso</>}>
      <SecSub>Escreva a partida. Ao gerar, entra em Lançamentos e alimenta o Status → Domínio.</SecSub>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 130px', gap: 10 }}>
        <Field label="Data"><input className="input" type="date" value={f.data} onChange={on('data')} /></Field>
        <Field label="Conta débito"><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></Field>
        <Field label="Conta crédito"><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></Field>
        <Field label="Valor"><input className="input" value={f.valor} onChange={on('valor')} placeholder="0,00" /></Field>
        <Field label="Histórico" col={4}><input className="input" value={f.historico} onChange={on('historico')} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => abrirGerar({ data: f.data, conta_debito: f.conta_debito, conta_credito: f.conta_credito, valor: num(f.valor), historico: f.historico, origem: 'manual', documento: '' }, 'Lançamento avulso')}><i className="ti ti-file-plus" /> Gerar lançamento</button>
      </div>
    </FormCard>
  )
}

function Aviso({ texto }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>Outras Contabilizações</h1>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
        <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} /><p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
      </div>
    </div>
  )
}
