import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { checarArquivoEmpresa } from '../lib/validarArquivoEmpresa'
import { useAuth } from '../components/AuthProvider'
import DropZone from '../components/DropZone'
import CampoConta from '../components/CampoConta'
import ModalLalurConfig from '../components/ModalLalurConfig'
import { theme, money } from '../lib/theme'
import InfoTela from '../components/InfoTela'
import { parsePlano, applyMask, normalizaCompetencia } from '../lib/balancete'
import { gerarExcelTimbrado } from '../lib/excel'
import { abrePdfTimbrado } from '../lib/pdf'
import { aberturaComp, excluirSaldoInicialTudo } from '../lib/cargaInicial'

const hoje = () => new Date().toLocaleDateString('pt-BR')

// ISO YYYY-MM-DD → DD/MM/AAAA (relatório da distribuição).
function brDataDist(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }
// Último dia da competência (MM/AAAA) em ISO — corte para o "posição em".
function ultimoDiaComp(competencia) {
  const [m, a] = String(competencia || '').split('/').map(Number)
  if (!m || !a) return ''
  const d = new Date(a, m, 0).getDate()
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
const r2dist = v => Math.round((v || 0) * 100) / 100

// Relatório de composição da distribuição de lucros em ata: por conta/sócio mostra o
// distribuído (saldo que começou), quantas parcelas já pagou, total pago, o pago no mês
// do fechamento e o saldo a pagar. O SUBTOTAL por conta = saldo que bate na conciliação.
function gerarRelatorioDistribuicaoAta({ formato, ata, competencia, empresaNome, planoMap = {}, escopo = 'mes', socioIdx = null }) {
  const [mm, aa] = String(competencia || '').split('/')
  const alvoMes = `${aa}-${String(mm).padStart(2, '0')}`
  const fimMes = ultimoDiaComp(competencia)
  const posic = brDataDist(fimMes) || competencia
  const contaLabel = conta => `Conta ${conta || '—'}${planoMap[conta]?.nome ? ' · ' + planoMap[conta].nome : ''}`
  let socios = (ata?.socios || [])
  if (socioIdx != null && socioIdx !== 'todos' && socioIdx !== '') socios = socios.filter((_, i) => i === Number(socioIdx))
  socios = socios.filter(s => (Number(s.valor) || 0) || (s.pagamentos || []).length)
  if (!socios.length) { alert('Cadastre os sócios (valor da ata) e os pagamentos para gerar o relatório.'); return }
  const arqBase = `distribuicao_lucros_ata_${escopo === 'completo' ? 'completo_' : ''}${String(competencia).replace('/', '-')}`

  // COMPLETO: extrato com cada pagamento por sócio.
  if (escopo === 'completo') {
    const titulo = 'Distribuição de Lucros (ata) — Extrato de pagamentos'
    const sub = `${empresaNome || ''} · Posição em ${posic} · cada pagamento e o saldo a pagar`
    const colunas = [
      { nome: 'Data', largura: 16 },
      { nome: 'Descrição', largura: 40, wrap: true },
      { nome: 'Valor pago', alinhar: 'right', moeda: true },
      { nome: 'Saldo a pagar', alinhar: 'right', moeda: true },
    ]
    let gPago = 0, gSaldo = 0
    const dados = socios.map(s => {
      const inicial = Number(s.valor) || 0
      const pags = (s.pagamentos || []).filter(p => p.data && (!fimMes || p.data <= fimMes)).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)))
      let saldo = inicial, pago = 0
      const linhas = [['—', 'Distribuído em ata (saldo inicial)', '', inicial]]
      for (const p of pags) { const v = Number(p.valor) || 0; pago = r2dist(pago + v); saldo = r2dist(saldo - v); linhas.push([brDataDist(p.data), 'Pagamento', v, saldo]) }
      gPago = r2dist(gPago + pago); gSaldo = r2dist(gSaldo + saldo)
      return { titulo: `${s.nome || '—'} · ${contaLabel(String(s.conta || '').trim())}`, pago, saldo, linhas }
    })
    if (formato === 'excel') {
      const secoes = dados.map(d => ({ titulo: d.titulo, linhas: d.linhas, totais: ['', 'Total pago / saldo a pagar', d.pago, d.saldo] }))
      return gerarExcelTimbrado({ titulo, sub, colunas, secoes, totais: dados.length > 1 ? ['', 'TOTAL GERAL', gPago, gSaldo] : null, arquivo: arqBase + '.xlsx', aba: 'Distribuição' })
    }
    const secoes = dados.map(d => ({ titulo: d.titulo, linhas: d.linhas.map(l => [l[0], l[1], l[2] === '' ? '' : money(l[2]), money(l[3])]), totais: ['', 'Total pago / saldo a pagar', money(d.pago), money(d.saldo)] }))
    return abrePdfTimbrado({ titulo, sub, colunas, secoes, totais: dados.length > 1 ? ['', 'TOTAL GERAL', money(gPago), money(gSaldo)] : null })
  }

  // SÓ DO MÊS: resumo por conta (composição do saldo a pagar, com o pago no mês).
  const grupos = {}
  for (const s of socios) {
    const inicial = Number(s.valor) || 0
    const pags = (s.pagamentos || [])
    const pagosAte = pags.filter(p => p.data && (!fimMes || p.data <= fimMes))
    const totalPago = pagosAte.reduce((x, p) => x + (Number(p.valor) || 0), 0)
    const pagoMes = pags.filter(p => String(p.data || '').slice(0, 7) === alvoMes).reduce((x, p) => x + (Number(p.valor) || 0), 0)
    const saldo = r2dist(inicial - totalPago)
    const conta = String(s.conta || '').trim() || '—'
    const g = (grupos[conta] ||= { conta, nome: planoMap[conta]?.nome || '', itens: [], inicial: 0, pago: 0, mes: 0, saldo: 0, qtd: 0 })
    g.itens.push({ nome: s.nome || '—', inicial, qtd: pagosAte.length, pago: r2dist(totalPago), mes: r2dist(pagoMes), saldo })
    g.inicial = r2dist(g.inicial + inicial); g.pago = r2dist(g.pago + totalPago); g.mes = r2dist(g.mes + pagoMes); g.saldo = r2dist(g.saldo + saldo); g.qtd += pagosAte.length
  }
  const arr = Object.values(grupos).sort((a, b) => String(a.conta).localeCompare(String(b.conta)))
  const geral = arr.reduce((s, g) => ({ inicial: r2dist(s.inicial + g.inicial), pago: r2dist(s.pago + g.pago), mes: r2dist(s.mes + g.mes), saldo: r2dist(s.saldo + g.saldo) }), { inicial: 0, pago: 0, mes: 0, saldo: 0 })
  const titulo = 'Distribuição de Lucros (ata) — Composição do saldo a pagar'
  const sub = `${empresaNome || ''} · Posição em ${posic} · o "Saldo a pagar" de cada conta bate com a conciliação`
  const colunas = [
    { nome: 'Sócio', largura: 34, wrap: true },
    { nome: 'Distribuído (ata)', alinhar: 'right', moeda: true },
    { nome: 'Parcelas pagas', alinhar: 'right' },
    { nome: 'Total pago', alinhar: 'right', moeda: true },
    { nome: 'Pago no mês', alinhar: 'right', moeda: true },
    { nome: 'Saldo a pagar', alinhar: 'right', moeda: true },
  ]
  if (formato === 'excel') {
    const secoes = arr.map(g => ({ titulo: contaLabel(g.conta), linhas: g.itens.map(it => [it.nome, it.inicial, it.qtd, it.pago, it.mes, it.saldo]), totais: ['Subtotal', g.inicial, g.qtd, g.pago, g.mes, g.saldo] }))
    return gerarExcelTimbrado({ titulo, sub, colunas, secoes, totais: ['TOTAL GERAL', geral.inicial, '', geral.pago, geral.mes, geral.saldo], arquivo: arqBase + '.xlsx', aba: 'Distribuição' })
  }
  const secoes = arr.map(g => ({ titulo: contaLabel(g.conta), linhas: g.itens.map(it => [it.nome, money(it.inicial), String(it.qtd), money(it.pago), money(it.mes), money(it.saldo)]), totais: ['Subtotal', money(g.inicial), String(g.qtd), money(g.pago), money(g.mes), money(g.saldo)] }))
  abrePdfTimbrado({ titulo, sub, colunas, secoes, totais: ['TOTAL GERAL', money(geral.inicial), '', money(geral.pago), money(geral.mes), money(geral.saldo)] })
}

// Lê a 1ª planilha detectando a linha de cabeçalho (a 1ª com >=3 células de texto não vazias).
// Necessário p/ exports do Domínio (ex.: plano de contas com cabeçalho na 5ª linha).
function lerPlanilha(XLSX, ws) {
  const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  let hdr = 0
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const txt = (matriz[i] || []).filter(c => String(c ?? '').trim().length > 0)
    if (txt.length >= 3) { hdr = i; break }
  }
  return XLSX.utils.sheet_to_json(ws, { range: hdr, defval: '' })
}

const CARGAS = [
  { tipo: 'plano', icon: 'ti-list-numbers', title: 'Plano de contas', sub: 'Com tipo de conciliação' },
  { tipo: 'depara', icon: 'ti-arrows-transfer-down', title: 'De/Para integrações', sub: 'Acumulador → conta' },
  { tipo: 'apelidos', icon: 'ti-book', title: 'Apelidos', sub: 'Leitura de histórico' },
  { tipo: 'financeiro', icon: 'ti-history', title: 'Histórico de lançamentos financeiros', sub: 'Carga inicial · atualiza a cada mês' },
  { tipo: 'bancoresult', icon: 'ti-cash', title: 'Amarração banco × resultado', sub: 'Contas banco e resultados liberados' },
  { tipo: 'centro_custo', icon: 'ti-sitemap', title: 'Centro de custo', sub: 'Importar os centros de custo do cliente' },
]

// Modelo de planilha de cada carga (colunas + exemplos). Serve para baixar o template
// e para montar o cadastro manual (uma linha por conta).
const MODELOS = {
  plano: {
    cols: ['Código', 'Classificação', 'Nome', 'Tipo', 'Grau'],
    ex: [['1', '1', 'ATIVO', 'S', '1'], ['5', '1110010001', 'CAIXA', 'A', '5']],
    dica: 'Código (reduzido), Classificação (hierárquica), Nome, Tipo (S sintética / A analítica), Grau.',
  },
  depara: {
    cols: ['Acumulador', 'Conta', 'Nome'],
    ex: [['5949', '3.1.1.01', 'Receita de vendas'], ['1102', '4.1.1.01', 'Despesas bancárias']],
    dica: 'Acumulador da integração → conta contábil de destino.',
  },
  apelidos: {
    cols: ['Termo no histórico', 'Cliente/Fornecedor'],
    ex: [['PAGSEG', 'PAGSEGURO INTERNET'], ['CPFL', 'CPFL ENERGIAS RENOVÁVEIS']],
    dica: 'Termo como aparece no histórico → nome real do cliente/fornecedor.',
  },
  financeiro: {
    cols: ['Data', 'Conta', 'Cliente/NF', 'Valor'],
    ex: [['01/01/2026', '1.1.2.01', 'PAGSEGURO NF 3256', '24275.92']],
    dica: 'Saldo de abertura/composição inicial: data, conta, cliente/NF e valor.',
  },
  bancoresult: {
    cols: ['Tipo', 'Código', 'Nome'],
    ex: [['Banco', '1.1.1.01', 'Banco Itaú c/c'], ['Banco', '1.1.1.02', 'Banco Bradesco c/c'], ['Resultado liberado', '4.1.1.01', 'Despesas bancárias / tarifas'], ['Resultado liberado', '3.2.1.01', 'Receita financeira (rendimento)']],
    dica: 'Tipo = "Banco" (conta de banco) ou "Resultado liberado" (resultado que pode receber lançamento direto do banco).',
  },
  centro_custo: {
    cols: ['Código', 'Nome', 'Responsável'],
    ex: [['1', 'ADMINISTRATIVO', 'Financeiro'], ['2', 'COMERCIAL', 'Vendas'], ['3', 'PRODUÇÃO', 'Operações']],
    dica: 'Centros de custo do cliente: código, nome e (opcional) responsável. Um por linha.',
  },
}

// Modelos da carga inicial — em TRÊS blocos:
//  1) Saldos: contas que são só saldo de abertura (data, código, nome, saldo, D/C).
//  2) Clientes e fornecedores: composição COM nota fiscal (data, conta, cliente/forn., NF, valor, D/C).
//  3) Outras contas com composição: SEM nota fiscal — o "quem" é o histórico da conta
//     (data, conta, histórico, valor, D/C).
// Nos blocos 2 e 3 o sistema confere se a soma dos itens bate com o saldo da conta.
const MODELO_SALDOS = {
  cols: ['Data', 'Código', 'Nome', 'Saldo', 'D/C'],
  ex: [['31/12/2025', '12', 'Banco Itaú c/c', '15230.45', 'D'], ['31/12/2025', '340', 'Impostos a recolher', '3120.00', 'C']],
  dica: 'Contas de saldo (banco, aplicação, impostos a recolher…). Uma linha por conta: data, código da conta (o mesmo do razão/plano), nome, saldo e D/C.',
}
const MODELO_CLIFOR = {
  cols: ['Data', 'Conta', 'Cliente/Fornecedor', 'NF', 'Valor', 'D/C'],
  ex: [['31/12/2025', '118', 'PAGSEGURO INTERNET', '3256', '24275.92', 'D'], ['31/12/2025', '205', 'CPFL ENERGIAS', '8842', '1200.00', 'C']],
  dica: 'Clientes e fornecedores. Um título em aberto por linha, COM nota fiscal: data, conta, cliente/fornecedor, NF, valor e D/C.',
}
const MODELO_OUTRAS = {
  cols: ['Data', 'Conta', 'Histórico', 'Competência', 'Valor', 'D/C'],
  ex: [['31/12/2025', '150', 'Adiantamento de viagem', '12/2025', '800.00', 'D'], ['31/12/2025', '260', 'Provisão de férias', '12/2025', '5400.00', 'C']],
  dica: 'Outras contas com composição, SEM nota fiscal (adiantamentos, provisões, empréstimos…). O "quem" é o histórico (você sobe direto do seu sistema). Uma linha por item: data, conta, histórico, competência, valor e D/C.',
}

// Lê valor em formato brasileiro ("1.234,56") ou americano ("1234.56").
function numBR(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '')
  if (!s) return 0
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}
// Saldo com sinal: D (devedor) positivo, C (credor) negativo. Usa a coluna D/C;
// na falta dela, respeita o sinal do próprio número.
function saldoComSinal(valor, dc) {
  const n = numBR(valor)
  const s = String(dc ?? '').trim()
  if (/c/i.test(s)) return -Math.abs(n)
  if (/d/i.test(s)) return Math.abs(n)
  return n
}

// Extrai { codigo, nome, tipo, classif } de uma linha salva (qualquer formato de coluna).
const normK = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// Acha o valor de uma coluna por regex no nome (normalizado).
function campoPor(obj, re) {
  const k = Object.keys(obj || {}).find(k => re.test(normK(k)))
  return k ? obj[k] : ''
}
// Chave de conta p/ casar saldo × composição (dígitos da classificação/código).
const chaveConta = v => String(v ?? '').replace(/\D/g, '')
// Detecta as CHAVES (nomes de coluna) de código/nome/tipo/classificação numa linha crua —
// usado tanto para LER (extrairConta) quanto para GRAVAR de volta (edição de conta).
function colKeys(obj) {
  const keys = Object.keys(obj || {})
  const acha = re => keys.find(k => re.test(normK(k)))
  // Código REDUZIDO da conta (chave estável). Cuidado: no export cru do Domínio há
  // "nome_conta", "tipo_conta" e "classificacao_conta" — todas contêm "conta". Por isso
  // procuramos primeiro "reduzido"/"codigo" e só caímos em "conta" excluindo nome/tipo/etc.
  const kCod = keys.find(k => /reduzid/.test(normK(k)))
    || keys.find(k => /codigo/.test(normK(k)) && !/classif/.test(normK(k)))
    || keys.find(k => /^cod/.test(normK(k)))
    || keys.find(k => /conta/.test(normK(k)) && !/(nome|tipo|classif|razao|inscri|detalhe|grupo|emp|scp|dados|linha|mascara)/.test(normK(k)))
  const kNome = acha(/nome.*conta|conta.*nome/) || acha(/nome|descri/)
  const kTipo = keys.find(k => /tipo/.test(normK(k)) && /conta/.test(normK(k))) || acha(/^tipo/) || acha(/tipo/)
  const kClass = acha(/classific/)
  return { kCod, kNome, kTipo, kClass }
}
function extrairConta(obj) {
  const { kCod, kNome, kTipo, kClass } = colKeys(obj)
  return {
    codigo: String(obj[kCod] ?? '').trim(),
    nome: String(obj[kNome] ?? '').trim(),
    tipo: String(obj[kTipo] ?? '').trim(),
    classif: String(obj[kClass] ?? '').trim(),
  }
}

export default function BaseInformacoes() {
  const { empresaId, empresaNome, competencia, plano, empresas, recalcularPendencias, recarregarPlano } = useAppData()
  const cliente = (empresas || []).find(e => e.id === empresaId)
  const usaCentroCusto = !!cliente?.usa_centro_custo
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))
  const { user } = useAuth()

  const [particularidades, setParticularidades] = useState([])
  const [contatos, setContatos] = useState([])
  const [cargas, setCargas] = useState({})
  const [periodo, setPeriodo] = useState('')
  const [cargaSaldos, setCargaSaldos] = useState(false)   // empresa tem saldo inicial (não é nova)
  const [cargaFeita, setCargaFeita] = useState(false)     // carga inicial já lançada
  const [dist, setDist] = useState(null)   // linha de dist_lucros_config
  const [regime, setRegime] = useState('') // regime tributário do cliente (habilita o LALUR)
  const [modal, setModal] = useState(null)
  const [aberturaTravada, setAberturaTravada] = useState(false) // competência de abertura fechada

  // Descobre se a competência de ABERTURA está fechada (trava mexer no saldo inicial).
  useEffect(() => {
    let ativo = true
    if (!empresaId || !periodo) { setAberturaTravada(false); return }
    aberturaComp(empresaId, periodo).then(a => { if (ativo) setAberturaTravada(!!a.fechada) })
    return () => { ativo = false }
  }, [empresaId, periodo])

  async function carregarCargas() {
    const { data } = await supabase.from('cargas_cadastro')
      .select('id, tipo, vigencia, dados, obs, usuario, created_at')
      .eq('cliente_id', empresaId).order('created_at', { ascending: true })
    const grp = {}
    for (const c of (data || [])) (grp[c.tipo] ||= []).push(c)
    setCargas(grp)
  }
  async function carregarDist() {
    const { data } = await supabase.from('dist_lucros_config').select('*')
      .eq('cliente_id', empresaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    setDist(data || null)
  }
  useEffect(() => {
    setParticularidades([]); setContatos([]); setCargas({}); setPeriodo(''); setDist(null); setCargaSaldos(false); setCargaFeita(false)
    if (!empresaId) return
    carregarCargas(); carregarDist()
    supabase.from('clientes').select('particularidades, contatos, competencia_inicio, carga_saldos, carga_inicial_feita, regime_tributario').eq('id', empresaId).single()
      .then(({ data }) => {
        setParticularidades(data?.particularidades || [])
        setContatos(data?.contatos || [])
        setPeriodo(data?.competencia_inicio || '')
        setCargaSaldos(!!data?.carga_saldos)
        setCargaFeita(!!data?.carga_inicial_feita)
        setRegime(data?.regime_tributario || '')
      })
  }, [empresaId])

  function persistirCliente(campo, valor) {
    supabase.from('clientes').update({ [campo]: valor }).eq('id', empresaId).then(() => {})
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para ver a Base de Informações." /></Wrapper>
  }

  function salvarPartic(texto, idx) {
    const item = { t: texto, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...particularidades, item] : particularidades.map((x, i) => i === idx ? item : x)
    setParticularidades(novo); persistirCliente('particularidades', novo)
  }
  function removerPartic(idx) {
    const novo = particularidades.filter((_, j) => j !== idx)
    setParticularidades(novo); persistirCliente('particularidades', novo)
  }
  function salvarContato(c, idx) {
    const item = { ...c, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...contatos, item] : contatos.map((x, i) => i === idx ? item : x)
    setContatos(novo); persistirCliente('contatos', novo)
  }
  function removerContato(idx) {
    const novo = contatos.filter((_, j) => j !== idx)
    setContatos(novo); persistirCliente('contatos', novo)
  }
  function salvarPeriodo(v, nova) {
    setPeriodo(v); setCargaSaldos(!nova)
    supabase.from('clientes').update({ competencia_inicio: v, carga_saldos: !nova }).eq('id', empresaId).then(() => recalcularPendencias?.())
    setModal(null)
  }
  function abrirCargaInicial(v) {
    setPeriodo(v); setCargaSaldos(true)
    supabase.from('clientes').update({ competencia_inicio: v, carga_saldos: true }).eq('id', empresaId).then(() => {})
    setModal({ tipo: 'cargaInicial', vigencia: v })
  }
  // Só uma carga inicial ativa: se já existe, pergunta e substitui (apaga as anteriores).
  async function concluirCargaInicial(vigencia, payload, obs) {
    const existentes = (cargas.financeiro || []).filter(c => String(c.obs || '').startsWith('Carga inicial'))
    if (existentes.length) {
      if (!confirm('Atualizar a carga inicial salva? Os blocos que você não reenviou são mantidos.')) return
      for (const c of existentes) await supabase.from('cargas_cadastro').delete().eq('id', c.id)
    }
    await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: 'financeiro', vigencia, dados: payload, usuario: user?.email, obs: 'Carga inicial · ' + obs })
    await supabase.from('clientes').update({ carga_inicial_feita: true }).eq('id', empresaId)
    setCargaFeita(true); carregarCargas(); recalcularPendencias?.(); setModal(null)
  }

  // Zera TODO o saldo inicial (todos os arquivos) para re-subir. Trava se a abertura fechou.
  async function excluirTudoSaldoInicial() {
    if (aberturaTravada) { alert('A competência de abertura está FECHADA. Reabra-a para mexer no saldo inicial.'); return }
    if (!confirm('Excluir TODO o saldo inicial (carga inicial) deste cliente? Você poderá subir os arquivos de novo.')) return
    try {
      const n = await excluirSaldoInicialTudo(empresaId, periodo, user?.email)
      setCargaFeita(false); carregarCargas(); recalcularPendencias?.()
      alert(`Saldo inicial excluído (${n} registro(s)). Pode subir a carga inicial de novo.`)
    } catch (e) { alert(e.message) }
  }
  async function excluirCargaInicial(c) {
    if (aberturaTravada) { alert('A competência de abertura está FECHADA. Reabra-a para mexer no saldo inicial.'); return }
    if (!confirm(`Excluir esta carga inicial (${String(c.obs || '').replace(/^Carga inicial · /, '') || 'sem arquivo'})?`)) return
    await supabase.from('cargas_cadastro').delete().eq('id', c.id)
    const resta = (cargas.financeiro || []).filter(x => x.id !== c.id && String(x.obs || '').startsWith('Carga inicial'))
    if (!resta.length) { await supabase.from('clientes').update({ carga_inicial_feita: false }).eq('id', empresaId); setCargaFeita(false) }
    carregarCargas(); recalcularPendencias?.()
  }
  // Arquivos de uma carga inicial: agrupa as linhas (saldos + composições) pela marca de
  // origem __arq. Cargas antigas (sem marca) aparecem como um arquivo só (o nome do obs).
  function arquivosDaCarga(c) {
    const fallback = String(c.obs || '').replace(/^Carga inicial · /, '') || '(sem arquivo)'
    const g = new Map()
    for (const r of [...(c.dados?.saldos || []), ...(c.dados?.composicoes || [])]) {
      const k = r.__arq || fallback; g.set(k, (g.get(k) || 0) + 1)
    }
    return g.size ? [...g.entries()].map(([label, n]) => ({ label, n })) : [{ label: fallback, n: 0 }]
  }
  // Exclui UM arquivo da carga (só as linhas dele). Se for o único, exclui a carga toda.
  async function excluirArquivoCarga(c, label) {
    if (aberturaTravada) { alert('A competência de abertura está FECHADA. Reabra-a para mexer no saldo inicial.'); return }
    const arqs = arquivosDaCarga(c)
    if (arqs.length <= 1) return excluirCargaInicial(c)
    if (!confirm(`Excluir o arquivo "${label}" da carga inicial? Só as linhas dele saem do saldo inicial.`)) return
    const fallback = String(c.obs || '').replace(/^Carga inicial · /, '') || '(sem arquivo)'
    const keep = r => (r.__arq || fallback) !== label
    const saldos = (c.dados?.saldos || []).filter(keep)
    const composicoes = (c.dados?.composicoes || []).filter(keep)
    const labels = [...new Set([...saldos, ...composicoes].map(r => r.__arq).filter(Boolean))]
    await supabase.from('cargas_cadastro').update({ dados: { saldos, composicoes }, obs: 'Carga inicial · ' + (labels.join(' + ') || 'manual') }).eq('id', c.id)
    carregarCargas(); recalcularPendencias?.()
  }
  async function salvarDist(cfg) {
    if (dist) await supabase.from('dist_lucros_config').update(cfg).eq('id', dist.id)
    else await supabase.from('dist_lucros_config').insert({ cliente_id: empresaId, usuario: user?.email, ...cfg })
    await carregarDist(); setModal(null)
  }

  return (
    <Wrapper nome={empresaNome}>
      {/* Particularidades */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderLeft: '3px solid #F5A623', borderRadius: '0 12px 12px 0', padding: 20, marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <p style={{ color: theme.text, fontSize: 15, fontWeight: 600, margin: 0 }}>
            <i className="ti ti-alert-hexagon" style={{ color: '#F5A623', marginRight: 6 }} />Particularidades do cliente
          </p>
          <button className="btn" style={btnMini} onClick={() => setModal({ tipo: 'partic' })}><i className="ti ti-plus" /> Incluir</button>
        </div>
        {particularidades.length === 0
          ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhuma particularidade registrada.</p>
          : particularidades.map((x, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: `1px solid ${theme.border}` }}>
              <span style={{ color: theme.text, fontSize: 13, flex: 1 }}>{x.t} <span style={{ color: theme.sub, fontSize: 11 }}>— atualizado por {x.u} · {x.d}</span></span>
              <Acoes onEdit={() => setModal({ tipo: 'partic', idx: i, valor: x.t })} onDel={() => removerPartic(i)} />
            </div>
          ))}
      </div>

      {/* Contatos */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 8px', gap: 10 }}>
        <p style={{ color: theme.sub, margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8 }}>Contatos</p>
        <button className="btn" style={btnMini} onClick={() => setModal({ tipo: 'contato' })}><i className="ti ti-plus" /> Incluir</button>
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20, marginBottom: 22 }}>
        {contatos.length === 0
          ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhum contato cadastrado.</p>
          : contatos.map((x, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
              <div>
                <p style={{ color: theme.text, margin: 0, fontSize: 13.5 }}>{x.nome}</p>
                <p style={{ color: theme.sub, fontSize: 11.5, margin: '2px 0 0' }}>{x.tel}{x.email ? ' · ' + x.email : ''}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{x.u} · {x.d}</span>
                <Acoes onEdit={() => setModal({ tipo: 'contato', idx: i, valor: x })} onDel={() => removerContato(i)} />
              </div>
            </div>
          ))}
      </div>

      {/* Parâmetros do fechamento */}
      <p style={{ color: theme.sub, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8, margin: '4px 0 12px' }}>Parâmetros do fechamento</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        <CargaCard {...CARGAS[0]} ultima={cargas.plano?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[0] })} />
        <CargaCard {...CARGAS[2]} ultima={cargas.apelidos?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[2] })} />
        <SimplesCard icon="ti-calendar-event" title="Período de início" sub={periodo ? `${periodo} · trava o passado` : 'Trava o passado'}
          badge={!periodo
            ? { txt: 'definir', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)' }
            : (cargaSaldos && !cargaFeita)
              ? { txt: 'carga pendente', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)' }
              : { txt: `início ${periodo}`, cor: theme.green, bg: 'rgba(48,164,108,0.15)' }}
          onClick={() => setModal({ tipo: 'periodo' })} />
        <CargaCard {...CARGAS[4]} ultima={cargas.bancoresult?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[4] })} />
        <SimplesCard icon="ti-users" title="Distribuição de lucros" sub="Limite, alíquota e sócios (IRRF 2026)"
          badge={dist ? { txt: 'configurado', cor: theme.green, bg: 'rgba(48,164,108,0.15)' } : null}
          onClick={() => setModal({ tipo: 'dist' })} />
        {(() => {
          const ehLR = /LUCRO REAL/i.test(regime)
          const cfgLalur = cargas.lalur?.at(-1)
          return (
            <div onClick={ehLR ? () => setModal({ tipo: 'lalur' }) : undefined}
              title={ehLR ? undefined : 'Disponível apenas para clientes no Lucro Real.'}
              style={{ ...cardBase, cursor: ehLR ? 'pointer' : 'not-allowed', opacity: ehLR ? 1 : .5 }}>
              <IconeBadge icon="ti-report-money" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>Cadastro do Lucro Real (LALUR)</p>
                <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{ehLR ? 'Adição/exclusão, IRRF, contabilização e prejuízo' : 'Só para clientes no Lucro Real'}</p>
              </div>
              {ehLR && (cfgLalur
                ? <span style={badge('rgba(48,164,108,0.15)', theme.green)}>configurado</span>
                : <span style={badge('rgba(245,166,35,0.15)', theme.yellow)}>pendente</span>)}
            </div>
          )
        })()}
        <CargaCard {...CARGAS[5]} ultima={cargas.centro_custo?.at(-1)}
          disabled={!usaCentroCusto} dicaDisabled="Ative “Usa centro de custo” no cadastro do cliente para habilitar."
          onClick={() => setModal({ tipo: 'carga', carga: CARGAS[5] })} />
      </div>

      {/* Carga inicial de saldos — cada ARQUIVO importado, individualmente (ver / editar / excluir) */}
      {(() => {
        const cis = (cargas.financeiro || []).filter(c => String(c.obs || '').startsWith('Carga inicial'))
        if (!cis.length) return null
        const linhasArq = cis.flatMap(c => arquivosDaCarga(c).map(a => ({ c, a })))
        return (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '4px 0 12px' }}>
              <p style={{ color: theme.sub, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8, margin: 0 }}>Carga inicial de saldos</p>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 11px', color: aberturaTravada ? theme.sub : theme.red, borderColor: aberturaTravada ? theme.border : 'rgba(229,72,77,0.4)' }} disabled={aberturaTravada} onClick={excluirTudoSaldoInicial} title={aberturaTravada ? 'Competência de abertura fechada — reabra para mexer no saldo inicial' : 'Apaga TODO o saldo inicial para você subir os arquivos de novo'}><i className={`ti ${aberturaTravada ? 'ti-lock' : 'ti-trash'}`} /> Excluir saldo inicial (tudo)</button>
            </div>
            {aberturaTravada && <p style={{ color: theme.yellow, fontSize: 12, margin: '0 0 10px' }}><i className="ti ti-lock" /> A competência de <b>abertura</b> ({periodo}) está <b>fechada</b> — reabra-a para excluir/alterar o saldo inicial.</p>}
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
              {linhasArq.map(({ c, a }, i) => (
                <div key={c.id + '·' + a.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 13 }}>
                  <i className="ti ti-file-invoice" style={{ color: theme.accent, fontSize: 18, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label} <span style={{ color: theme.sub, fontSize: 11.5 }}>· {a.n} linha(s)</span></p>
                    <p style={{ margin: '2px 0 0', color: theme.sub, fontSize: 11.5 }}>vigência {c.vigencia || '—'} · {c.usuario || '—'} · {dataHora(c.created_at)}</p>
                  </div>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setModal({ tipo: 'verCargaInicial', carga: c })}>ver</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setModal({ tipo: 'cargaInicial', vigencia: c.vigencia })}>editar</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: 'rgba(229,72,77,0.4)' }} onClick={() => excluirArquivoCarga(c, a.label)}>excluir</button>
                </div>
              ))}
            </div>
            {cis.length > 1 && <p style={{ color: theme.yellow, fontSize: 12, margin: '8px 0 0' }}><i className="ti ti-alert-triangle" /> Há mais de uma carga inicial. A mais recente é a que vale — exclua as antigas.</p>}
          </div>
        )
      })()}

      {/* Modais */}
      {modal?.tipo === 'carga' && (
        <ModalCarga carga={modal.carga} historico={cargas[modal.carga.tipo] || []} empresaId={empresaId} usuario={user?.email}
          onClose={() => setModal(null)} onImportado={() => { carregarCargas(); recarregarPlano() }} />
      )}
      {modal?.tipo === 'partic' && (
        <ModalTexto titulo={modal.idx == null ? 'Nova particularidade' : 'Editar particularidade'} valorInicial={modal.valor || ''}
          label="Particularidade" onClose={() => setModal(null)} onSalvar={v => { salvarPartic(v, modal.idx); setModal(null) }} />
      )}
      {modal?.tipo === 'contato' && (
        <ModalContato valorInicial={modal.valor} onClose={() => setModal(null)} onSalvar={c => { salvarContato(c, modal.idx); setModal(null) }} />
      )}
      {modal?.tipo === 'periodo' && (
        <ModalPeriodo valorInicial={periodo} cargaSaldos={cargaSaldos} cargaFeita={cargaFeita}
          onClose={() => setModal(null)} onSalvar={salvarPeriodo} onFazerCarga={abrirCargaInicial} />
      )}
      {modal?.tipo === 'cargaInicial' && (
        <ModalCargaInicial vigencia={modal.vigencia} empresaId={empresaId} onClose={() => setModal(null)} onConcluir={concluirCargaInicial} />
      )}
      {modal?.tipo === 'dist' && (
        <ModalDist inicial={dist} empresaId={empresaId} competencia={competencia} empresaNome={empresaNome} planoMap={planoMap} onClose={() => setModal(null)} onSalvar={salvarDist} />
      )}
      {modal?.tipo === 'lalur' && (
        <ModalLalurConfig empresaId={empresaId} usuario={user?.email} competencia={competencia} regime={regime}
          inicial={cargas.lalur?.at(-1)?.dados} onClose={() => setModal(null)} onSaved={carregarCargas} />
      )}
      {modal?.tipo === 'verCargaInicial' && (
        <Modal titulo="Carga inicial — conteúdo importado" sub={String(modal.carga.obs || '').replace(/^Carga inicial · /, '')} onClose={() => setModal(null)} largura={760}>
          <TabelaDados titulo="Saldos de abertura" linhas={modal.carga.dados?.saldos || []} />
          <TabelaDados titulo="Composições de abertura" linhas={modal.carga.dados?.composicoes || []} />
        </Modal>
      )}
    </Wrapper>
  )
}

// Data/hora curta pt-BR de um created_at.
function dataHora(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Preview das linhas importadas (objetos → tabela; chaves como colunas).
function TabelaDados({ titulo, linhas }) {
  const cols = linhas.length ? Object.keys(linhas[0]).filter(k => !k.startsWith('__')) : []
  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>{titulo} <span style={{ color: theme.sub, fontWeight: 400 }}>· {linhas.length} linha(s)</span></p>
      {!linhas.length ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Sem linhas.</p> : (
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8, overflow: 'auto', maxHeight: 240 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: theme.input }}>{cols.map(k => <th key={k} style={{ textAlign: 'left', padding: '6px 10px', color: theme.sub, whiteSpace: 'nowrap' }}>{k}</th>)}</tr></thead>
            <tbody>{linhas.slice(0, 300).map((l, i) => <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>{cols.map(k => <td key={k} style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: theme.text }}>{String(l[k] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ---------- Cards ---------- */
function CargaCard({ icon, title, sub, ultima, onClick, disabled, dicaDisabled }) {
  return (
    <div onClick={disabled ? undefined : onClick} title={disabled ? dicaDisabled : undefined}
      style={{ ...cardBase, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .5 : 1 }}>
      <IconeBadge icon={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>{title}</p>
        <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{disabled ? dicaDisabled : sub}</p>
      </div>
      {disabled
        ? <span style={badge('rgba(255,255,255,0.06)', theme.sub)}>desabilitado</span>
        : ultima
          ? <span style={badge('rgba(48,164,108,0.15)', theme.green)}>vigência {ultima.vigencia}</span>
          : <span style={badge('rgba(245,166,35,0.15)', theme.yellow)}>carga pendente</span>}
    </div>
  )
}
function SimplesCard({ icon, title, sub, onClick, badge: b }) {
  return (
    <div onClick={onClick} style={{ ...cardBase, cursor: onClick ? 'pointer' : 'default' }}>
      <IconeBadge icon={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>{title}</p>
        <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{sub}</p>
      </div>
      {b && <span style={badge(b.bg || 'rgba(255,255,255,0.06)', b.cor)}>{b.txt}</span>}
    </div>
  )
}
function IconeBadge({ icon }) {
  return (
    <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 20 }} />
    </span>
  )
}
function Acoes({ onEdit, onDel }) {
  return (
    <span style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
      <i className="ti ti-pencil" style={{ color: theme.sub, cursor: 'pointer', fontSize: 14 }} onClick={onEdit} title="Editar" />
      <i className="ti ti-trash" style={{ color: theme.sub, cursor: 'pointer', fontSize: 14 }} onClick={onDel} title="Excluir" />
    </span>
  )
}

/* ---------- Modais ---------- */
function ModalCarga({ carga, historico, empresaId, usuario, onClose, onImportado }) {
  const modelo = MODELOS[carga.tipo] || { cols: ['Código', 'Nome'], ex: [], dica: '' }
  const linhaVazia = () => Object.fromEntries(modelo.cols.map(c => [c, '']))
  const [vigencia, setVigencia] = useState('')
  const [modo, setModo] = useState('arquivo') // 'arquivo' | 'manual'
  const [linhas, setLinhas] = useState([linhaVazia()])
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [planoIdx, setPlanoIdx] = useState(null) // { porRed, porNum, mascara } p/ puxar nome pelo código
  const [hist, setHist] = useState(historico || []) // cargas (vigências) já salvas — recarrega ao salvar
  const [msgOk, setMsgOk] = useState('')
  const [pendente, setPendente] = useState(null) // { dados, nome, diff? } aguardando confirmação
  const [planoRaw, setPlanoRaw] = useState([])   // linhas cruas do plano atual (p/ diff e mesclagem)
  const [editConta, setEditConta] = useState(null) // { idx, codigo, classif, nome, tipo } conta em edição
  const ehPlano = carga.tipo === 'plano'
  const vigOk = /^\d{2}\/\d{4}$/.test(vigencia)
  const fileRef = useRef(null) // input escondido: o botão "Importar planilha" abre o seletor direto

  async function recarregar() {
    const { data } = await supabase.from('cargas_cadastro').select('id, vigencia, dados, usuario, obs, created_at')
      .eq('cliente_id', empresaId).eq('tipo', carga.tipo).order('created_at', { ascending: true })
    setHist(data || [])
  }

  // Salva a EDIÇÃO de uma conta já cadastrada (importada por planilha ou manual): grava o
  // código/nome/tipo/classificação de volta na linha crua da carga mais recente, nas MESMAS
  // colunas do arquivo, e atualiza a carga. Corrige direto no cadastro atual.
  async function salvarEdicaoConta(ed) {
    const cr = hist.length ? hist[hist.length - 1] : null
    if (!cr) return
    setSalvando(true); setErro('')
    try {
      const dados = Array.isArray(cr.dados) ? cr.dados.map(r => ({ ...r })) : []
      const row = dados[ed.idx]
      if (!row) throw new Error('linha não encontrada')
      const { kCod, kNome, kTipo, kClass } = colKeys(row)
      if (kCod) row[kCod] = ed.codigo
      if (kNome) row[kNome] = ed.nome
      if (kTipo) row[kTipo] = ed.tipo
      if (kClass) row[kClass] = ed.classif
      const { error } = await supabase.from('cargas_cadastro').update({ dados }).eq('id', cr.id)
      if (error) throw error
      setEditConta(null); await recarregar(); onImportado()
      setMsgOk('Conta atualizada.')
    } catch (err) { setErro('Erro ao salvar a conta: ' + (err.message || err)) } finally { setSalvando(false) }
  }

  // Carrega o plano de contas para autopreencher nome/classificação a partir do código.
  useEffect(() => {
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        const plano = parsePlano(data?.dados)
        const porRed = {}, porNum = {}
        for (const p of plano) {
          if (p.reduzido) porRed[p.reduzido] = p
          if (p.classif) porNum[p.classif.replace(/\D/g, '')] = p
        }
        setPlanoIdx({ porRed, porNum, mascara: plano.find(p => p.mascara)?.mascara || '9.9.9.999.9999' })
        setPlanoRaw(Array.isArray(data?.dados) ? data.dados : [])
      })
  }, [empresaId])

  // Chave estável de uma linha de plano (código reduzido; senão dígitos da classificação).
  const chavePlano = row => { const e = extrairConta(row); return String(e.codigo || '').trim() || chaveConta(e.classif) }
  // Diferença do plano importado vs o plano atual: contas novas e alteradas
  // (nome/classificação/tipo). "Mantidas" = existem hoje e não vieram no arquivo.
  function diffPlano(novoDados) {
    const antigos = new Map(planoRaw.map(r => [chavePlano(r), extrairConta(r)]).filter(([k]) => k))
    const novas = [], alteradas = []
    const novasKeys = new Set()
    for (const r of novoDados) {
      const k = chavePlano(r); if (!k) continue
      novasKeys.add(k)
      const e = extrairConta(r), old = antigos.get(k)
      if (!old) novas.push(e)
      else if (String(old.nome).trim() !== String(e.nome).trim() || chaveConta(old.classif) !== chaveConta(e.classif) || String(old.tipo).trim() !== String(e.tipo).trim()) alteradas.push({ de: old, para: e })
    }
    const mantidas = [...antigos.keys()].filter(k => !novasKeys.has(k)).length
    return { novas, alteradas, mantidas }
  }
  // Mescla o plano atual com o importado: mantém as contas existentes e
  // inclui/atualiza só as novas e alteradas (o novo sobrepõe pela chave).
  function mesclarPlano(novoDados) {
    const mapa = new Map()
    for (const r of planoRaw) { const k = chavePlano(r); if (k) mapa.set(k, r) }
    const extra = []
    for (const r of novoDados) { const k = chavePlano(r); if (k) mapa.set(k, r); else extra.push(r) }
    return [...mapa.values(), ...extra]
  }

  // Acha a conta no plano pelo código digitado (reduzido ou classificação, com/sem máscara).
  function buscaConta(v) {
    if (!planoIdx) return null
    const t = String(v || '').trim(); if (!t) return null
    if (planoIdx.porRed[t]) return planoIdx.porRed[t]
    return planoIdx.porNum[t.replace(/\D/g, '')] || null
  }

  // Colunas do modelo: qual é a de código, nome e classificação (para autopreencher).
  const colCod = modelo.cols.find(c => /(c[oó]digo|conta)/i.test(c) && !/classific/i.test(c))
  const colNome = modelo.cols.find(c => /nome/i.test(c))
  const colClassif = modelo.cols.find(c => /classific/i.test(c))
  // Centro de custo tem código e descritivo PRÓPRIOS (não vêm do plano de contas).
  const semPlano = carga.tipo === 'centro_custo'

  async function baixarModelo() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([modelo.cols, ...(modelo.ex || [])])
    ws['!cols'] = modelo.cols.map(c => ({ wch: Math.max(14, c.length + 4) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Modelo')
    XLSX.writeFile(wb, `modelo_${carga.tipo}.xlsx`)
  }

  // Sobrepõe a carga da mesma vigência (se houver) antes de inserir a nova.
  async function sobreporSeMesma() {
    const mesma = (hist || []).filter(h => h.vigencia === vigencia)
    if (mesma.length) {
      if (!confirm(`Já existe carga para a vigência ${vigencia}. Deseja sobrepor (substituir)?`)) return false
      for (const m of mesma) await supabase.from('cargas_cadastro').delete().eq('id', m.id)
    }
    return true
  }

  // Escolher/arrastar o arquivo faz a LEITURA e mostra a prévia; só grava ao confirmar.
  async function importarArquivo(file) {
    if (!file) return
    const errCod = await checarArquivoEmpresa(file, cliente)
    if (errCod) { setErro(errCod); return }
    if (!vigOk) { setErro('Informe a vigência (MM/AAAA) antes de escolher o arquivo.'); return }
    setErro(''); setMsgOk('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const dados = lerPlanilha(XLSX, wb.Sheets[wb.SheetNames[0]])
      if (!dados.length) { setErro('Planilha vazia.'); return }
      // No plano de contas, mostra o que é novo/alterado vs o plano atual.
      const diff = (ehPlano && planoRaw.length) ? diffPlano(dados) : null
      setPendente({ dados, nome: file.name, diff }) // aguarda confirmação (conferir antes de gravar)
    } catch (err) { setErro('Erro ao ler o arquivo: ' + err.message) }
  }

  // Confirma a importação lida (grava de fato).
  async function confirmarImport() {
    if (!pendente) return
    setErro(''); setSalvando(true)
    try {
      if (!(await sobreporSeMesma())) { setSalvando(false); return }
      // Plano: mescla com o atual (mantém as contas existentes, inclui/atualiza as novas).
      const dadosFinal = (ehPlano && planoRaw.length) ? mesclarPlano(pendente.dados) : pendente.dados
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: carga.tipo, vigencia, dados: dadosFinal, usuario, obs: pendente.nome,
      })
      if (error) throw error
      await recarregar(); onImportado(); setSalvando(false)
      const resumo = pendente.diff ? ` · ${pendente.diff.novas.length} nova(s), ${pendente.diff.alteradas.length} alterada(s)` : ''
      setMsgOk(`Importado · vigência ${vigencia} (${dadosFinal.length} conta(s)${resumo}).`); setPendente(null)
    } catch (err) { setErro('Erro ao importar: ' + err.message); setSalvando(false) }
  }

  async function salvarManual() {
    if (!vigOk) { setErro('Informe a vigência (MM/AAAA) antes de salvar.'); return }
    const dados = linhas.filter(l => Object.values(l).some(v => String(v).trim()))
    if (!dados.length) { setErro('Preencha ao menos uma linha.'); return }
    setErro(''); setSalvando(true)
    try {
      if (!(await sobreporSeMesma())) { setSalvando(false); return }
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: carga.tipo, vigencia, dados, usuario, obs: 'Cadastro manual',
      })
      if (error) throw error
      await recarregar(); onImportado(); setSalvando(false); setMsgOk(`Salvo · vigência ${vigencia} (${dados.length} conta(s)).`)
    } catch (err) { setErro('Erro ao salvar: ' + err.message); setSalvando(false) }
  }

  // Carrega as linhas de uma vigência no editor manual (para editar e salvar de novo).
  function editarVigencia(c) {
    setVigencia(c.vigencia || '')
    setModo('manual'); setMsgOk(''); setErro('')
    const colTipo = modelo.cols.find(k => /tipo/i.test(k))
    const ls = (Array.isArray(c.dados) ? c.dados : []).map(o => {
      const ec = extrairConta(o); const row = linhaVazia()
      if (colCod) row[colCod] = ec.codigo
      if (colNome) row[colNome] = ec.nome
      if (colTipo) row[colTipo] = ec.tipo
      if (colClassif) row[colClassif] = ec.classif
      return row
    })
    setLinhas(ls.length ? ls : [linhaVazia()])
  }
  function novaVigencia() { setVigencia(''); setLinhas([linhaVazia()]); setModo('manual'); setMsgOk(''); setErro('') }

  function setCelV(i, col, v) {
    setLinhas(ls => ls.map((l, j) => {
      if (j !== i) return l
      const nova = { ...l, [col]: v }
      // Ao informar o código, puxa nome e classificação do plano de contas (menos no centro de custo).
      if (col === colCod && !semPlano) {
        const p = buscaConta(v)
        if (p) {
          if (colNome) nova[colNome] = p.nome
          if (colClassif && colClassif !== colCod) nova[colClassif] = applyMask(p.classif, planoIdx?.mascara)
        }
      }
      return nova
    }))
  }
  const setCel = (i, col) => e => setCelV(i, col, e.target.value)

  async function excluirVigencia(id) {
    if (!confirm('Excluir esta vigência da carga?')) return
    await supabase.from('cargas_cadastro').delete().eq('id', id)
    await recarregar(); onImportado()
  }

  // Carga mais recente → "Contas já cadastradas".
  const cargaRecente = hist.length ? hist[hist.length - 1] : null
  // Guarda o ÍNDICE da linha crua (idx) em cada conta, para poder EDITAR direto na carga.
  const contasCad = cargaRecente ? (Array.isArray(cargaRecente.dados) ? cargaRecente.dados : [])
    .map((raw, idx) => ({ idx, ...extrairConta(raw) })).filter(c => c.codigo || c.nome) : []
  const ehBR = carga.tipo === 'bancoresult'
  const bancosCad = contasCad.filter(c => normK(c.tipo).includes('banco'))
  const resultCad = contasCad.filter(c => /result|liber/.test(normK(c.tipo)))
  const credito = cargaRecente ? `${(cargaRecente.usuario || '').split('@')[0] || '—'} · ${new Date(cargaRecente.created_at).toLocaleDateString('pt-BR')}` : ''
  const LinhaConta = ({ c }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${theme.border}`, fontSize: 13 }}>
      <span style={{ color: theme.text, minWidth: 0 }}><span style={{ color: theme.sub }}>{c.codigo}</span>{c.codigo && c.nome ? ' · ' : ''}{c.nome}{c.tipo ? <span style={{ color: theme.sub, fontSize: 11, marginLeft: 6 }}>({String(c.tipo).toUpperCase().slice(0, 1) === 'S' ? 'sintética' : 'analítica'})</span> : ''}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
        <span style={{ color: theme.sub, fontSize: 12 }}>{credito}</span>
        {c.idx != null && <i className="ti ti-pencil" title="Editar conta" onClick={() => setEditConta({ ...c })} style={{ color: theme.sub, cursor: 'pointer', fontSize: 15 }} />}
      </span>
    </div>
  )
  const SubTit = ({ children }) => <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4, margin: '14px 0 2px' }}>{children}</p>

  return (
    <Modal titulo={carga.title} sub={carga.sub} onClose={onClose} largura={680}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: 0, flex: 1 }}>{modelo.dica || 'Importe a planilha ou cadastre manualmente.'} Cada carga cria uma <b style={{ color: theme.text }}>vigência</b> e preserva o histórico.</p>
        <button className="btn btn-ghost" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }} onClick={baixarModelo}><i className="ti ti-download" /> Baixar modelo</button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label>1. Vigência (MM/AAAA)</label>
        <input className="input" style={{ maxWidth: 220 }} value={vigencia} onChange={e => setVigencia(e.target.value)} placeholder="01/2026" autoFocus />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={modo === 'arquivo' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }}
          onClick={() => {
            setModo('arquivo')
            if (!vigOk) { setErro('Informe a vigência (MM/AAAA) antes de importar.'); return }
            if (!salvando && !pendente) fileRef.current?.click() // abre o seletor de arquivo direto
          }}><i className="ti ti-cloud-upload" /> Importar planilha</button>
        <button className={modo === 'manual' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('manual')}><i className="ti ti-keyboard" /> Cadastrar manual</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importarArquivo(f) }} />
      </div>

      {modo === 'arquivo' ? (
        <>
          <label>2. Arquivo</label>
          {!pendente ? (
            <DropZone onArquivo={importarArquivo} disabled={!vigOk || salvando}
              hint={vigOk ? 'Arraste ou clique · .xlsx, .xls ou .csv' : 'Informe a vigência primeiro'} />
          ) : (
            <div style={{ border: `1px solid ${theme.accent}`, borderRadius: 10, padding: 14, marginTop: 4 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}><i className="ti ti-eye" style={{ color: theme.accent }} /> Confira antes de importar</p>
              <p style={{ fontSize: 12.5, color: theme.sub, margin: '0 0 10px' }}>{pendente.nome} · <b style={{ color: theme.text }}>{pendente.dados.length}</b> linha(s) · vigência {vigencia}</p>
              {pendente.diff && (
                <div style={{ background: theme.input, borderRadius: 8, padding: '10px 12px', marginBottom: 10, fontSize: 12.5 }}>
                  <p style={{ margin: '0 0 6px', color: theme.text, fontWeight: 600 }}><i className="ti ti-git-compare" style={{ color: theme.accent, marginRight: 5 }} />Comparação com o plano atual — será incluído só o que é novo ou mudou; o resto é mantido.</p>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span style={{ color: theme.green }}><b>{pendente.diff.novas.length}</b> nova(s)</span>
                    <span style={{ color: theme.yellow }}><b>{pendente.diff.alteradas.length}</b> alterada(s)</span>
                    <span style={{ color: theme.sub }}><b>{pendente.diff.mantidas}</b> mantida(s) (não vieram no arquivo)</span>
                  </div>
                  {(pendente.diff.novas.length + pendente.diff.alteradas.length) > 0 && (
                    <div style={{ marginTop: 8, maxHeight: 130, overflowY: 'auto' }}>
                      {pendente.diff.novas.slice(0, 12).map((c, i) => (
                        <div key={'n' + i} style={{ fontSize: 12, padding: '3px 0', color: theme.text }}><span style={{ color: theme.green, fontSize: 11, marginRight: 6 }}>NOVA</span><span style={{ color: theme.sub }}>{c.codigo}</span> {c.nome}</div>
                      ))}
                      {pendente.diff.alteradas.slice(0, 12).map((c, i) => (
                        <div key={'a' + i} style={{ fontSize: 12, padding: '3px 0', color: theme.text }}><span style={{ color: theme.yellow, fontSize: 11, marginRight: 6 }}>ALTEROU</span><span style={{ color: theme.sub }}>{c.para.codigo}</span> {c.de.nome} → {c.para.nome}</div>
                      ))}
                      {(pendente.diff.novas.length + pendente.diff.alteradas.length) > 24 && <p style={{ fontSize: 11, color: theme.sub, margin: '4px 0 0' }}>… e mais.</p>}
                    </div>
                  )}
                  {pendente.diff.novas.length + pendente.diff.alteradas.length === 0 && <p style={{ fontSize: 12, color: theme.sub, margin: '6px 0 0' }}>Nada novo ou alterado em relação ao plano atual.</p>}
                </div>
              )}
              <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 8, maxHeight: 240 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
                  <thead><tr style={{ background: theme.input }}>{Object.keys(pendente.dados[0] || {}).map(c => <th key={c} style={{ textAlign: 'left', padding: '7px 10px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }}>{c}</th>)}</tr></thead>
                  <tbody>{pendente.dados.slice(0, 8).map((row, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>{Object.keys(pendente.dados[0] || {}).map(c => <td key={c} style={{ padding: '6px 10px', fontSize: 12.5, color: theme.text }}>{String(row[c] ?? '')}</td>)}</tr>
                  ))}</tbody>
                </table>
              </div>
              {pendente.dados.length > 8 && <p style={{ fontSize: 11.5, color: theme.sub, margin: '6px 0 0' }}>… e mais {pendente.dados.length - 8} linha(s).</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn" disabled={salvando} onClick={confirmarImport}><i className="ti ti-check" /> {salvando ? 'Importando…' : 'Confirmar importação'}</button>
                <button className="btn btn-ghost" disabled={salvando} onClick={() => setPendente(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <label>2. Linhas (uma por linha){semPlano ? ' — digite o código e o descritivo do centro' : (colCod && colNome ? ' — digite o código que o nome é puxado do plano' : '')}</label>
          <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  {modelo.cols.map(c => <th key={c} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{c}</th>)}
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    {modelo.cols.map(c => (
                      <td key={c} style={{ padding: 4 }}>
                        {c === 'Tipo' && carga.tipo === 'bancoresult'
                          ? <select className="input" style={{ minWidth: 150 }} value={l[c]} onChange={setCel(i, c)}><option value="">—</option><option value="Banco">Banco</option><option value="Resultado liberado">Resultado liberado</option></select>
                          : (c === colCod && !semPlano)
                            ? <CampoConta value={l[c]} onChange={v => setCelV(i, c, v)} onPick={p => setCelV(i, c, p.cod)} placeholder={`${c} (F4)`} style={{ minWidth: 160 }} />
                            : <input className="input" value={l[c]} onChange={setCel(i, c)} placeholder={c} />}
                      </td>
                    ))}
                    <td style={{ textAlign: 'center' }}>
                      <i className="ti ti-trash" title="Remover linha" onClick={() => setLinhas(ls => ls.filter((_, j) => j !== i).length ? ls.filter((_, j) => j !== i) : [linhaVazia()])} style={{ color: theme.sub, cursor: 'pointer' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => setLinhas(ls => [...ls, linhaVazia()])}><i className="ti ti-plus" /> Adicionar linha</button>
            <button className="btn" disabled={salvando} onClick={salvarManual}>{salvando ? 'Salvando…' : 'Salvar cadastro'}</button>
          </div>
        </>
      )}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '10px 0 0' }}>{erro}</p>}
      {msgOk && <p style={{ color: theme.green, fontSize: 13, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msgOk}</p>}

      {/* Histórico de vigências */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '22px 0 6px' }}>
        <p style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .6, margin: 0 }}>Histórico de vigências</p>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={novaVigencia}><i className="ti ti-plus" /> Nova vigência</button>
      </div>
      {hist.length === 0
        ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhuma carga ainda.</p>
        : hist.slice().reverse().map(c => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: `1px solid ${theme.border}`, fontSize: 12.5 }}>
            <span style={{ color: theme.text }}>Vigência <b>{c.vigencia || '—'}</b> · {Array.isArray(c.dados) ? c.dados.length : ((c.dados?.saldos?.length || 0) + (c.dados?.composicoes?.length || 0))} item(ns) <span style={{ color: theme.sub }}>· {c.obs || ''}</span></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: theme.sub, whiteSpace: 'nowrap' }}>{(c.usuario || '').split('@')[0]} · {new Date(c.created_at).toLocaleDateString('pt-BR')}</span>
              <i className="ti ti-pencil" title="Editar esta vigência" onClick={() => editarVigencia(c)} style={{ color: theme.accent, cursor: 'pointer', flexShrink: 0 }} />
              <i className="ti ti-trash" title="Excluir esta vigência" onClick={() => excluirVigencia(c.id)} style={{ color: theme.sub, cursor: 'pointer', flexShrink: 0 }} />
            </span>
          </div>
        ))}

      {/* Contas já cadastradas (carga mais recente) */}
      {contasCad.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px' }}>Contas já cadastradas</p>
          {ehBR ? (
            <>
              <SubTit>Contas de banco</SubTit>
              {bancosCad.length ? bancosCad.map((c, i) => <LinhaConta key={'b' + i} c={c} />) : <p style={{ color: theme.sub, fontSize: 12.5 }}>—</p>}
              <SubTit>Resultados liberados (lançamento direto do banco)</SubTit>
              {resultCad.length ? resultCad.map((c, i) => <LinhaConta key={'r' + i} c={c} />) : <p style={{ color: theme.sub, fontSize: 12.5 }}>—</p>}
            </>
          ) : (
            contasCad.map((c, i) => <LinhaConta key={i} c={c} />)
          )}
        </div>
      )}

      {editConta && (
        <ModalEditarConta conta={editConta} ehPlano={ehPlano} salvando={salvando}
          onClose={() => setEditConta(null)} onSalvar={salvarEdicaoConta} />
      )}
    </Modal>
  )
}

// Edita uma conta já cadastrada (código, classificação, nome, tipo sintética/analítica).
function ModalEditarConta({ conta, ehPlano, salvando, onClose, onSalvar }) {
  const [f, setF] = useState({ codigo: conta.codigo || '', classif: conta.classif || '', nome: conta.nome || '', tipo: String(conta.tipo || '').toUpperCase().slice(0, 1) === 'S' ? 'S' : 'A' })
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }))
  return (
    <Modal titulo="Editar conta" sub="Ajusta a conta na carga atual" onClose={onClose} largura={460}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div><label>Código (reduzido)</label><input className="input" value={f.codigo} onChange={set('codigo')} autoFocus /></div>
        {ehPlano && <div><label>Classificação</label><input className="input" value={f.classif} onChange={set('classif')} placeholder="ex.: 1110010000000001" /></div>}
        <div><label>Nome</label><input className="input" value={f.nome} onChange={set('nome')} /></div>
        {ehPlano && (
          <div><label>Tipo</label>
            <select className="input" value={f.tipo} onChange={set('tipo')}>
              <option value="A">A · analítica (recebe lançamento)</option>
              <option value="S">S · sintética (soma as analíticas)</option>
            </select>
          </div>
        )}
      </div>
      <Rodape onClose={onClose} salvando={salvando} onSalvar={() => onSalvar({ idx: conta.idx, codigo: f.codigo.trim(), classif: f.classif.trim(), nome: f.nome.trim(), tipo: f.tipo })} />
    </Modal>
  )
}

function ModalTexto({ titulo, label, valorInicial, onClose, onSalvar }) {
  const [v, setV] = useState(valorInicial)
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <label>{label}</label>
      <textarea className="input" rows={3} value={v} onChange={e => setV(e.target.value)} autoFocus />
      <Rodape onClose={onClose} onSalvar={() => v.trim() && onSalvar(v.trim())} />
    </Modal>
  )
}

function ModalContato({ valorInicial, onClose, onSalvar }) {
  const [f, setF] = useState(valorInicial || { nome: '', tel: '', email: '' })
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }))
  return (
    <Modal titulo={valorInicial ? 'Editar contato' : 'Novo contato'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div><label>Nome</label><input className="input" value={f.nome} onChange={set('nome')} autoFocus /></div>
        <div><label>Telefone</label><input className="input" value={f.tel} onChange={set('tel')} /></div>
        <div><label>E-mail</label><input className="input" value={f.email} onChange={set('email')} /></div>
      </div>
      <Rodape onClose={onClose} onSalvar={() => f.nome.trim() && onSalvar(f)} />
    </Modal>
  )
}

function mesAnterior(p) {
  const m = String(p || '').match(/^(\d{2})\/(\d{4})$/)
  if (!m) return '—'
  let mes = +m[1], ano = +m[2]
  mes -= 1; if (mes === 0) { mes = 12; ano -= 1 }
  return `${String(mes).padStart(2, '0')}/${ano}`
}

function ModalPeriodo({ valorInicial, cargaSaldos, cargaFeita, onClose, onSalvar, onFazerCarga }) {
  const [v, setV] = useState(valorInicial || '')
  const [nova, setNova] = useState(valorInicial ? !cargaSaldos : false)
  const [erro, setErro] = useState('')
  const vNorm = normalizaCompetencia(v)            // aceita data/serial e normaliza p/ MM/AAAA
  const ok = /^\d{2}\/\d{4}$/.test(vNorm)
  const valida = () => ok ? true : (setErro('Use o formato MM/AAAA.'), false)

  return (
    <Modal titulo={`Período de início${ok ? ' — ' + vNorm : ''}`} onClose={onClose} largura={560}>
      <label>Competência de início (MM/AAAA)</label>
      <input className="input" value={v} onChange={e => setV(e.target.value)} placeholder="04/2026" autoFocus />
      <p style={{ color: theme.sub, fontSize: 12.5, margin: '10px 0 0', lineHeight: 1.55 }}>
        A partir desta competência o passado fica travado. O mês anterior ({mesAnterior(vNorm)}) é o saldo de abertura.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '16px 0 0', cursor: 'pointer', color: theme.text, fontSize: 13 }}>
        <input type="checkbox" checked={nova} onChange={e => setNova(e.target.checked)} />
        Empresa nova — não tem saldo inicial
      </label>

      {!nova && (
        <div style={{ background: theme.input, border: `1px solid ${cargaFeita ? 'rgba(48,164,108,0.45)' : 'rgba(245,166,35,0.45)'}`, borderRadius: 10, padding: 16, marginTop: 14 }}>
          <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}>Carga inicial de saldos e composições</p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '6px 0 0', lineHeight: 1.55 }}>
            Lance o saldo de abertura de cada conta e, nas contas de composição, os itens iniciais (por cliente/NF).
            Pode fazer agora ou depois — mas o primeiro fechamento só encerra com a carga concluída.
          </p>
          <p style={{ color: cargaFeita ? theme.green : theme.yellow, fontSize: 13, fontWeight: 600, margin: '10px 0 0' }}>
            <i className={`ti ${cargaFeita ? 'ti-circle-check' : 'ti-alert-triangle'}`} /> {cargaFeita ? 'Carga inicial concluída.' : 'Carga inicial pendente.'}
          </p>
        </div>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 8 }}>{erro}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={() => valida() && onSalvar(vNorm, nova)}>{nova ? 'Salvar' : 'Depois'}</button>
        {!nova && <button className="btn" onClick={() => valida() && onFazerCarga(vNorm)}><i className="ti ti-cloud-upload" /> Fazer agora</button>}
      </div>
    </Modal>
  )
}

// Editor manual de um bloco da carga inicial: uma linha por item, com as mesmas colunas
// do modelo. Serve para DIGITAR do zero (implantar sem arquivo) ou ALTERAR à mão o que
// veio de uma planilha. Ao informar o código, puxa o nome do plano de contas.
function GradeManual({ cols, linhas, onChange, planoNomes }) {
  const vazia = () => Object.fromEntries(cols.map(c => [c, '']))
  const rows = (linhas && linhas.length) ? linhas : [vazia()]
  const colCod = cols.find(c => /(c[oó]digo|conta)/i.test(c) && !/classific/i.test(c))
  const colNome = cols.find(c => /nome/i.test(c))
  const larga = c => /valor|saldo|nome|cliente|forn|hist|descri/i.test(c)
  function setCel(i, col, v) {
    onChange(rows.map((l, j) => {
      if (j !== i) return l
      const nl = { ...l, [col]: v }
      if (col === colCod && colNome && planoNomes && !String(nl[colNome] || '').trim()) {
        const nm = planoNomes.red?.[chaveConta(v)] || planoNomes.cls?.[chaveConta(v)]
        if (nm) nl[colNome] = nm
      }
      return nl
    }))
  }
  const temDados = l => Object.entries(l).some(([k, v]) => !k.startsWith('__') && String(v ?? '').trim())
  function delLinha(i) {
    // Confirma só quando a linha tem algo preenchido (evita apagar um lançamento por engano).
    if (temDados(rows[i]) && !window.confirm('Excluir este lançamento da carga inicial?')) return
    const n = rows.filter((_, j) => j !== i); onChange(n.length ? n : [vazia()])
  }
  return (
    <div>
      <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ background: theme.card }}>
            {cols.map(c => <th key={c} style={{ textAlign: 'left', padding: '6px 8px', color: theme.sub, whiteSpace: 'nowrap' }}>{c}</th>)}
            <th style={{ padding: '6px 8px', color: theme.sub, textAlign: 'center' }}>Excluir</th>
          </tr></thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                {cols.map(c => (
                  <td key={c} style={{ padding: '3px 4px', verticalAlign: 'top' }}>
                    {c === colCod
                      ? <CampoConta value={l[c] ?? ''} onChange={v => setCel(i, c, v)} placeholder="Cód (F4)" style={{ width: 150 }} />
                      : <input value={l[c] ?? ''} onChange={e => setCel(i, c, e.target.value)}
                          style={{ width: larga(c) ? 150 : 84, background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 5, color: theme.text, padding: '4px 6px', fontSize: 12 }} />}
                  </td>
                ))}
                <td style={{ textAlign: 'center', padding: '3px 6px' }}>
                  <button type="button" onClick={() => delLinha(i)} title="Excluir esta linha"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(229,72,77,0.10)', border: `1px solid rgba(229,72,77,0.35)`, color: theme.red, borderRadius: 6, padding: '3px 8px', fontSize: 11.5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <i className="ti ti-trash" /> Excluir
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-ghost" style={{ fontSize: 12, marginTop: 8 }} onClick={() => onChange([...rows, vazia()])}><i className="ti ti-plus" /> Adicionar linha</button>
    </div>
  )
}

function ModalCargaInicial({ vigencia, empresaId, onClose, onConcluir }) {
  const [saldos, setSaldos] = useState(null)        // { nome, dados:[...] } — só saldo
  const [comp, setComp] = useState(null)            // clientes e fornecedores (com NF)
  const [outras, setOutras] = useState(null)        // outras contas com composição (sem NF)
  const [pendCarga, setPendCarga] = useState(null)  // { setter, atual, dados, nome } — pergunta substituir/complementar
  const [modoBloco, setModoBloco] = useState({})    // { saldos:'manual'|'arquivo', ... } por bloco
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [planoNomes, setPlanoNomes] = useState({ red: {}, cls: {} })  // nome p/ conferência

  // Nomes do plano p/ exibir na conferência. Mapas SEPARADOS por reduzido e por
  // classificação: como a carga usa o código reduzido, o nome é buscado pelo
  // reduzido primeiro. (Evita colisão de dígitos, ex.: reduzido "23" = clientes
  // vs classificação "2.3" = patrimônio líquido, que dariam a mesma chave.)
  useEffect(() => {
    if (!empresaId) return
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        const red = {}, cls = {}
        for (const p of parsePlano(data?.dados)) {
          if (p.reduzido) red[chaveConta(p.reduzido)] = p.nome
          if (p.classif) cls[chaveConta(p.classif)] = p.nome
        }
        setPlanoNomes({ red, cls })
      })
  }, [empresaId])

  // Pré-carrega a carga inicial JÁ SALVA nos três blocos, para não perdê-la ao
  // concluir: o bloco que não for reenviado é preservado. Divide as composições
  // em clientes/fornecedores (tem cliente/fornecedor ou NF) e outras (histórico).
  useEffect(() => {
    if (!empresaId) return
    supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'financeiro')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        const d = data?.dados
        if (!d || Array.isArray(d) || !String(data?.obs || '').startsWith('Carga inicial')) return
        const ehClifor = r => Object.keys(r || {}).some(k => /cliente|fornec|\bnf\b|nota\s*fisc/.test(normK(k)))
        const comps = d.composicoes || []
        const cli = comps.filter(ehClifor), out = comps.filter(r => !ehClifor(r))
        if ((d.saldos || []).length) setSaldos({ nome: 'carga anterior', dados: d.saldos, salvo: true })
        if (cli.length) setComp({ nome: 'carga anterior', dados: cli, salvo: true })
        if (out.length) setOutras({ nome: 'carga anterior', dados: out, salvo: true })
      })
  }, [empresaId])

  // Rótulo único do arquivo dentro do bloco (não fundir arquivos: cada linha guarda de
  // qual arquivo veio em `__arq`, para poder excluir um arquivo por vez).
  function rotuloUnico(nome, atual) {
    const usados = new Set((atual?.dados || []).map(r => r.__arq).filter(Boolean))
    if (!usados.has(nome)) return nome
    let i = 2; while (usados.has(`${nome} (${i})`)) i++
    return `${nome} (${i})`
  }
  async function lerArquivo(file, setter, atual) {
    if (!file) return
    const errCod = await checarArquivoEmpresa(file, cliente)
    if (errCod) { setErro(errCod); return }
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const brutos = lerPlanilha(XLSX, wb.Sheets[wb.SheetNames[0]])
      if (!brutos.length) { setErro('Planilha vazia.'); return }
      const label = rotuloUnico(file.name, atual)
      const dados = brutos.map(r => ({ ...r, __arq: label }))  // marca a origem de cada linha
      // Já há arquivo neste bloco → pergunta SUBSTITUIR (troca tudo) ou COMPLEMENTAR
      // (adiciona SEM fundir — cada arquivo continua identificável e removível sozinho).
      if (atual && (atual.dados || []).length) { setPendCarga({ setter, atual, dados, nome: label }); return }
      setter({ nome: label, dados })
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }
  // Resolve a pergunta substituir/complementar da carga inicial.
  function resolverPendCarga(modo) {
    const p = pendCarga; if (!p) return
    if (modo === 'complementar') {
      // Adiciona sem fundir: as linhas novas já vêm marcadas com o próprio arquivo (__arq).
      p.setter({ nome: p.nome, dados: [...(p.atual.dados || []), ...p.dados] })
    } else {
      p.setter({ nome: p.nome, dados: p.dados })
    }
    setPendCarga(null)
  }

  async function baixarModelo(modelo, arquivo) {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([modelo.cols, ...(modelo.ex || [])])
    ws['!cols'] = modelo.cols.map(c => ({ wch: Math.max(16, c.length + 4) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Modelo')
    XLSX.writeFile(wb, arquivo)
  }

  // Conferência: soma da composição por conta × saldo informado no bloco de saldos.
  // Blocos 2 (clientes/fornecedores) e 3 (outras contas) somam juntos por conta.
  const conferencia = (() => {
    const compRows = [...(comp?.dados || []), ...(outras?.dados || [])]
    if (!compRows.length) return []
    // Saldo informado por conta (chave dígitos).
    const saldoPorConta = {}
    const nomePorConta = {}
    for (const r of (saldos?.dados || [])) {
      const cod = campoPor(r, /(codigo|conta)/) || campoPor(r, /^cod/)
      const k = chaveConta(cod); if (!k) continue
      saldoPorConta[k] = (saldoPorConta[k] || 0) + saldoComSinal(campoPor(r, /saldo|valor/), campoPor(r, /^d\/?c$|natureza/))
      nomePorConta[k] = campoPor(r, /nome|descri/) || nomePorConta[k]
    }
    // Soma da composição por conta.
    const compPorConta = {}
    for (const r of compRows) {
      const cod = campoPor(r, /^conta$|(codigo|conta)/) || campoPor(r, /^cod/)
      const k = chaveConta(cod); if (!k) continue
      compPorConta[k] = (compPorConta[k] || 0) + saldoComSinal(campoPor(r, /valor|saldo/), campoPor(r, /^d\/?c$|natureza/))
    }
    return Object.keys(compPorConta).map(k => {
      const somaComp = compPorConta[k]
      const saldo = saldoPorConta[k]
      const temSaldo = saldoPorConta[k] !== undefined
      const diff = temSaldo ? (saldo - somaComp) : null
      return {
        k, nome: nomePorConta[k] || planoNomes.red?.[k] || planoNomes.cls?.[k] || '',
        somaComp, saldo, temSaldo, diff,
        // A composição É o saldo da conta (soma dos itens por código, D − C). Só há
        // divergência quando o usuário informou um saldo separado que não bate.
        ok: !temSaldo || Math.abs(diff) < 0.005,
      }
    }).sort((a, b) => a.k.localeCompare(b.k))
  })()

  const temAlgo = (saldos?.dados?.length || 0) + (comp?.dados?.length || 0) + (outras?.dados?.length || 0) > 0
  const temDivergencia = conferencia.some(c => !c.ok)

  // Tira linhas em branco (a grade manual deixa uma linha vazia no fim para digitar).
  // Ignora chaves internas (__arq) — uma linha só com a marca de origem é vazia.
  const semVazias = arr => (arr || []).filter(r => Object.entries(r).some(([k, v]) => !k.startsWith('__') && String(v ?? '').trim()))

  async function concluir() {
    setSalvando(true)
    const composicoes = [...semVazias(comp?.dados), ...semVazias(outras?.dados)]
    const saldosF = semVazias(saldos?.dados)
    // obs = lista dos arquivos que compõem a carga (derivada das marcas __arq).
    const arqs = [...new Set([...saldosF, ...composicoes].map(r => r.__arq).filter(Boolean))]
    const obsArq = arqs.join(' + ') || 'manual'
    try { await onConcluir(vigencia, { saldos: saldosF, composicoes }, obsArq) }
    finally { setSalvando(false) }
  }

  const Bloco = ({ id, icon, titulo, dica, modelo, arquivo, estado, setter }) => {
    const modo = modoBloco[id] || 'arquivo'
    const setModo = m => setModoBloco(s => ({ ...s, [id]: m }))
    const segBtn = (m, ic, txt) => (
      <button className="btn btn-ghost" onClick={() => setModo(m)}
        style={{ fontSize: 12, padding: '5px 12px', color: modo === m ? theme.accent : theme.sub, borderColor: modo === m ? theme.accent : theme.cb, background: modo === m ? 'rgba(74,124,255,0.10)' : 'transparent' }}>
        <i className={`ti ${ic}`} /> {txt}
      </button>
    )
    // Arquivos deste bloco (agrupa as linhas pela marca de origem __arq) — cada um removível.
    const lotes = (() => {
      const g = new Map()
      for (const r of (estado?.dados || [])) {
        const k = r.__arq || (estado?.nome || 'sem arquivo')
        g.set(k, (g.get(k) || 0) + 1)
      }
      return [...g.entries()].map(([label, n]) => ({ label, n }))
    })()
    const removerArq = label => {
      const resto = (estado?.dados || []).filter(r => (r.__arq || estado?.nome) !== label)
      setter(resto.length ? { ...estado, dados: resto, salvo: false } : null)
    }
    return (
      <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}><i className={`ti ${icon}`} style={{ color: theme.accent, marginRight: 6 }} />{titulo}</p>
            <p style={{ color: theme.sub, fontSize: 12, margin: '4px 0 0', lineHeight: 1.5 }}>{dica}</p>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => baixarModelo(modelo, arquivo)}><i className="ti ti-download" /> Modelo</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {segBtn('arquivo', 'ti-file-spreadsheet', 'Arquivo')}
          {segBtn('manual', 'ti-keyboard', 'Digitar / editar')}
        </div>
        {modo === 'arquivo'
          ? <DropZone onArquivo={f => lerArquivo(f, setter, estado)} hint="Arraste ou clique · .xlsx, .xls ou .csv · pode subir vários (não funde)" />
          : <GradeManual cols={modelo.cols} linhas={estado?.dados || []} planoNomes={planoNomes}
              onChange={novo => setter({ nome: 'Digitado manualmente', dados: novo.map(r => r.__arq ? r : { ...r, __arq: 'Digitado manualmente' }) })} />}
        {lotes.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {lotes.map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: estado?.salvo ? theme.sub : theme.green }}>
                <i className={`ti ${estado?.salvo ? 'ti-database' : 'ti-file-check'}`} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label} — {l.n} linha(s)</span>
                <i className="ti ti-trash" title="Excluir este arquivo (só as linhas dele)" onClick={() => removerArq(l.label)} style={{ color: theme.sub, cursor: 'pointer', flexShrink: 0 }} />
              </div>
            ))}
            {estado?.salvo && <span style={{ color: theme.sub, fontSize: 11.5 }}>Será mantido se você não reenviar.</span>}
          </div>
        )}
      </div>
    )
  }

  return (
    <Modal titulo="Carga inicial de saldos" sub={`Saldo de abertura — vigência ${vigencia}`} onClose={onClose} largura={640}>
      <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
        São <b style={{ color: theme.text }}>três blocos</b>: contas de <b style={{ color: theme.text }}>saldo</b> (basta o valor de abertura),
        <b style={{ color: theme.text }}> clientes e fornecedores</b> (títulos em aberto com nota fiscal) e
        <b style={{ color: theme.text }}> outras contas com composição</b> (sem NF — pelo histórico da conta).
        Nas contas de composição, o <b style={{ color: theme.text }}>saldo é a própria soma dos itens</b> (por código, débito − crédito) — não precisa informá-lo à parte. Se você informar um saldo, o sistema confere se bate.
        <br />Cada bloco aceita <b style={{ color: theme.text }}>Arquivo</b> (subir planilha) ou <b style={{ color: theme.text }}>Digitar / editar</b> (implantar à mão ou corrigir linha a linha o que já subiu).
      </p>
      {(saldos?.salvo || comp?.salvo || outras?.salvo) && (
        <p style={{ color: theme.sub, fontSize: 12, marginBottom: 12, padding: '8px 11px', background: theme.input, borderRadius: 8, lineHeight: 1.5 }}>
          <i className="ti ti-info-circle" style={{ color: theme.accent, marginRight: 5 }} />Já existe carga inicial para este cliente — os blocos abaixo vêm preenchidos. Reenviar um bloco <b style={{ color: theme.text }}>substitui só aquele bloco</b>; os demais são mantidos.
        </p>
      )}

      {Bloco({ id: 'saldos', icon: 'ti-scale', titulo: '1. Saldos de abertura', dica: MODELO_SALDOS.dica,
        modelo: MODELO_SALDOS, arquivo: 'modelo_saldos_abertura.xlsx', estado: saldos, setter: setSaldos })}

      {Bloco({ id: 'comp', icon: 'ti-users', titulo: '2. Clientes e fornecedores', dica: MODELO_CLIFOR.dica,
        modelo: MODELO_CLIFOR, arquivo: 'modelo_clientes_fornecedores.xlsx', estado: comp, setter: setComp })}

      {Bloco({ id: 'outras', icon: 'ti-list-details', titulo: '3. Outras contas com composição', dica: MODELO_OUTRAS.dica,
        modelo: MODELO_OUTRAS, arquivo: 'modelo_outras_composicoes.xlsx', estado: outras, setter: setOutras })}

      {/* Conferência composição × saldo */}
      {conferencia.length > 0 && (
        <div style={{ marginTop: 4, marginBottom: 8 }}>
          <p style={{ color: theme.sub, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '0 0 6px' }}>Conferência composição × saldo</p>
          {conferencia.map(c => (
            <div key={c.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: `1px solid ${theme.border}`, fontSize: 12.5 }}>
              <span style={{ color: theme.text }}>
                <i className={`ti ${c.ok ? 'ti-circle-check' : 'ti-alert-triangle'}`} style={{ color: c.ok ? theme.green : theme.yellow, marginRight: 6 }} />
                {c.nome || c.k}
              </span>
              <span style={{ color: theme.sub, fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right' }}>
                comp. {money(Math.abs(c.somaComp))} {c.somaComp < 0 ? 'C' : 'D'}
                {c.temSaldo
                  ? <> · saldo {money(Math.abs(c.saldo))} {c.saldo < 0 ? 'C' : 'D'}{c.ok ? '' : <b style={{ color: theme.yellow }}> · dif {money(Math.abs(c.diff))}</b>}</>
                  : <span style={{ color: theme.green }}> · vira o saldo da conta</span>}
              </span>
            </div>
          ))}
          {temDivergencia && <p style={{ color: theme.yellow, fontSize: 12, margin: '8px 0 0' }}><i className="ti ti-info-circle" /> Há contas em que a composição não fecha com o saldo. Você pode concluir mesmo assim e ajustar depois.</p>}
        </div>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 13, marginTop: 10 }}>{erro}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={!temAlgo || salvando} onClick={concluir}>
          <i className="ti ti-cloud-upload" /> {salvando ? 'Concluindo…' : 'Concluir carga inicial'}
        </button>
      </div>

      {pendCarga && (
        <div onClick={() => setPendCarga(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 90 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(460px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 20 }}>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}><i className="ti ti-files" style={{ color: theme.accent, marginRight: 6 }} />Este bloco já tem arquivo</h3>
            <p style={{ color: theme.sub, fontSize: 13, margin: '0 0 4px' }}>Já há <b style={{ color: theme.text }}>{(pendCarga.atual.dados || []).length}</b> linha(s). O novo arquivo tem <b style={{ color: theme.text }}>{pendCarga.dados.length}</b>.</p>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}><b style={{ color: theme.text }}>Complementar</b> adiciona o novo arquivo <b style={{ color: theme.text }}>sem fundir</b> — cada arquivo continua separado e pode ser excluído sozinho depois (ex.: fornecedores em duas planilhas). <b style={{ color: theme.text }}>Substituir</b> troca tudo pelo novo arquivo.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setPendCarga(null)}>Cancelar</button>
              <button className="btn btn-ghost" style={{ color: theme.yellow, borderColor: theme.yellow }} onClick={() => resolverPendCarga('substituir')}><i className="ti ti-refresh" /> Substituir</button>
              <button className="btn" onClick={() => resolverPendCarga('complementar')}><i className="ti ti-plus" /> Complementar</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ModalDist({ inicial, empresaId, competencia, empresaNome, planoMap = {}, onClose, onSalvar }) {
  const [limite, setLimite] = useState(inicial?.limite ?? 50000)
  const [aliquota, setAliquota] = useState(inicial?.aliquota ?? 10)
  const [contas, setContas] = useState(inicial?.contas?.length ? inicial.contas : [{ cod: '', nome: '' }])
  const [socios, setSocios] = useState(inicial?.socios?.length ? inicial.socios : [{ nome: '', ident: '' }])
  // Lucros a distribuir registrados em ATA (passivo "a distribuir") — só cadastro/informação.
  const [ata, setAta] = useState(inicial?.ata && !Array.isArray(inicial.ata) ? inicial.ata : { houve: false, arquivo: '', documento: '', socios: [] })
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [relEscopo, setRelEscopo] = useState('mes')   // 'mes' | 'completo'
  const [relSocio, setRelSocio] = useState('todos')    // 'todos' | índice do sócio

  const upd = (set, i, k) => e => set(l => l.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))
  const rem = (set, i) => set(l => l.filter((_, j) => j !== i))
  const updAtaSocio = (i, k) => e => setAta(a => ({ ...a, socios: a.socios.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x) }))
  const setAtaContaSocio = (i, cod) => setAta(a => ({ ...a, socios: a.socios.map((x, j) => j === i ? { ...x, conta: cod } : x) }))
  const addPagamento = i => setAta(a => ({ ...a, socios: a.socios.map((x, j) => j === i ? { ...x, pagamentos: [...(x.pagamentos || []), { data: '', valor: '' }] } : x) }))
  const updPagamento = (i, k, campo) => e => setAta(a => ({ ...a, socios: a.socios.map((x, j) => j === i ? { ...x, pagamentos: (x.pagamentos || []).map((p, pk) => pk === k ? { ...p, [campo]: e.target.value } : p) } : x) }))
  const remPagamento = (i, k) => setAta(a => ({ ...a, socios: a.socios.map((x, j) => j === i ? { ...x, pagamentos: (x.pagamentos || []).filter((_, pk) => pk !== k) } : x) }))
  const totalAta = (ata.socios || []).reduce((s, x) => s + (Number(x.valor) || 0), 0)
  const saldoSocio = s => r2dist((Number(s.valor) || 0) - (s.pagamentos || []).reduce((x, p) => x + (Number(p.valor) || 0), 0))

  // Marca "houve": se ainda não há sócios na ata, semeia com os nomes já cadastrados.
  function marcarHouve(houve) {
    setAta(a => {
      const base = (a.socios && a.socios.length) ? a.socios : socios.filter(s => s.nome).map(s => ({ nome: s.nome, valor: '' }))
      return { ...a, houve, socios: houve ? (base.length ? base : [{ nome: '', valor: '' }]) : a.socios }
    })
  }

  async function anexarAta(file) {
    if (!file || !empresaId) return
    setErro('')
    const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
    const path = `atas/dist/${empresaId}${ext}`
    const { error } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
    if (error) { setErro('Não consegui anexar a ata: ' + error.message); return }
    setAta(a => ({ ...a, arquivo: path, documento: file.name }))
  }
  async function verAta() {
    if (!ata.arquivo) return
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(ata.arquivo, 300)
    if (error) { setErro('Não consegui abrir a ata: ' + error.message); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }
  async function removerAta() {
    if (ata.arquivo) await supabase.storage.from('extratos').remove([ata.arquivo])
    setAta(a => ({ ...a, arquivo: '', documento: '' }))
  }

  async function salvar() {
    setSalvando(true)
    const ataLimpa = ata.houve
      ? { houve: true, arquivo: ata.arquivo || '', documento: ata.documento || '', socios: (ata.socios || []).filter(s => s.nome || s.valor).map(s => ({ nome: s.nome, cpf: String(s.cpf || '').trim(), valor: Number(s.valor) || 0, conta: String(s.conta || '').trim(), pagamentos: (s.pagamentos || []).filter(p => p.data || p.valor).map(p => ({ data: p.data || '', valor: Number(p.valor) || 0 })) })) }
      : { houve: false, arquivo: '', documento: '', socios: [] }
    await onSalvar({
      limite: Number(limite) || 0, aliquota: Number(aliquota) || 0,
      contas: contas.filter(c => c.cod || c.nome), socios: socios.filter(s => s.nome || s.ident),
      ata: ataLimpa,
    })
    setSalvando(false)
  }

  return (
    <Modal titulo="Distribuição de lucros · IRRF 2026" sub="Lei 15.270/2025 — limite, alíquota, contas observadas e sócios." onClose={onClose} largura={640}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div><label>Limite mensal por sócio (R$)</label><input className="input" type="number" value={limite} onChange={e => setLimite(e.target.value)} /></div>
        <div><label>Alíquota de IRRF (%)</label><input className="input" type="number" value={aliquota} onChange={e => setAliquota(e.target.value)} /></div>
      </div>

      <LinhaTitulo titulo="Contas de distribuição observadas" onAdd={() => setContas(l => [...l, { cod: '', nome: '' }])} />
      {contas.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" style={{ width: 130 }} placeholder="Código" value={c.cod} onChange={upd(setContas, i, 'cod')} />
          <input className="input" style={{ flex: 1 }} placeholder="Nome da conta" value={c.nome} onChange={upd(setContas, i, 'nome')} />
          <i className="ti ti-trash" onClick={() => rem(setContas, i)} style={{ color: theme.sub, cursor: 'pointer', alignSelf: 'center' }} />
        </div>
      ))}

      <LinhaTitulo titulo="Sócios" onAdd={() => setSocios(l => [...l, { nome: '', ident: '' }])} />
      {socios.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Nome do sócio" value={s.nome} onChange={upd(setSocios, i, 'nome')} />
          <input className="input" style={{ flex: 1 }} placeholder="Identificação no razão (CC/histórico)" value={s.ident} onChange={upd(setSocios, i, 'ident')} />
          <i className="ti ti-trash" onClick={() => rem(setSocios, i)} style={{ color: theme.sub, cursor: 'pointer', alignSelf: 'center' }} />
        </div>
      ))}

      <p style={{ color: theme.sub, fontSize: 11.5, margin: '12px 0 0' }}>Estimativa para revisão humana — o razão não distingue sozinho lucro de 2025 (isento) de lucro novo.</p>

      {/* ---- Lucros a distribuir registrados em ATA (passivo "a distribuir") ---- */}
      <div style={{ borderTop: `0.5px solid ${theme.cb}`, margin: '18px 0 0', paddingTop: 16 }}>
        <span style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4 }}>Lucros a distribuir (registrados em ata)</span>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '4px 0 10px' }}>Distribuição deliberada em ata que fica no passivo "a distribuir" — separada da distribuição do ano acima. Só cadastro/informação.</p>
        <div style={{ display: 'flex', gap: 18, marginBottom: ata.houve ? 12 : 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="ata-houve" checked={!ata.houve} onChange={() => setAta(a => ({ ...a, houve: false }))} /> Não houve
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="ata-houve" checked={!!ata.houve} onChange={() => marcarHouve(true)} /> Houve (distribuído em ata)
          </label>
        </div>

        {ata.houve && <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
              <i className="ti ti-paperclip" /> {ata.documento ? 'Trocar ata' : 'Importar ata'}
              <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={e => anexarAta(e.target.files?.[0])} />
            </label>
            {ata.documento && <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-file" /> {ata.documento}</span>}
            {ata.arquivo && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={verAta}><i className="ti ti-eye" /> Ver</button>}
            {ata.arquivo && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={removerAta}><i className="ti ti-trash" /> Excluir</button>}
          </div>

          <LinhaTitulo titulo="Sócios, conta e pagamentos" onAdd={() => setAta(a => ({ ...a, socios: [...(a.socios || []), { nome: '', valor: '', conta: '', pagamentos: [] }] }))} />
          {(ata.socios || []).map((s, i) => (
            <div key={i} style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Nome do sócio" value={s.nome} onChange={updAtaSocio(i, 'nome')} />
                <input className="input" style={{ width: 150 }} placeholder="CPF" value={s.cpf || ''} onChange={updAtaSocio(i, 'cpf')} />
                <input className="input" style={{ width: 140 }} type="number" step="0.01" placeholder="Distribuído (R$)" value={s.valor} onChange={updAtaSocio(i, 'valor')} />
                <div style={{ width: 150 }}><CampoConta value={s.conta || ''} onChange={cod => setAtaContaSocio(i, cod)} onPick={p => setAtaContaSocio(i, p.cod)} placeholder="Conta (F4)" /></div>
                <i className="ti ti-trash" onClick={() => setAta(a => ({ ...a, socios: a.socios.filter((_, j) => j !== i) }))} style={{ color: theme.sub, cursor: 'pointer' }} />
              </div>
              {s.conta && planoMap[s.conta] && <p style={{ fontSize: 11, color: theme.accent, margin: '4px 0 0' }}><i className="ti ti-corner-down-right" /> {planoMap[s.conta].nome}</p>}
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>Pagamentos já feitos</span>
                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => addPagamento(i)}><i className="ti ti-plus" /> pagamento</button>
                </div>
                {(s.pagamentos || []).length === 0 && <p style={{ fontSize: 11.5, color: theme.sub, margin: '4px 0 0' }}>Nenhum pagamento — o saldo a pagar é o valor distribuído.</p>}
                {(s.pagamentos || []).map((p, k) => (
                  <div key={k} style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                    <input className="input" type="date" style={{ width: 165 }} value={p.data || ''} onChange={updPagamento(i, k, 'data')} />
                    <input className="input" type="number" step="0.01" style={{ width: 140 }} placeholder="Valor pago (R$)" value={p.valor} onChange={updPagamento(i, k, 'valor')} />
                    <i className="ti ti-trash" onClick={() => remPagamento(i, k)} style={{ color: theme.sub, cursor: 'pointer' }} />
                  </div>
                ))}
                <p style={{ fontSize: 12, color: theme.text, margin: '8px 0 0', textAlign: 'right' }}>Saldo a pagar: <b style={{ color: saldoSocio(s) > 0.005 ? theme.text : theme.green }}>{money(saldoSocio(s))}</b></p>
              </div>
            </div>
          ))}
          <p style={{ color: theme.text, fontSize: 12.5, margin: '8px 0 0', textAlign: 'right' }}>Total distribuído em ata: <b>{money(totalAta)}</b></p>

          {/* Relatório de composição (para o cliente e para conciliar) */}
          <div style={{ borderTop: `0.5px solid ${theme.cb}`, paddingTop: 12, marginTop: 12 }}>
            <span style={{ fontSize: 12, color: theme.sub }}><i className="ti ti-report" /> Relatório de composição{competencia ? ` (${competencia})` : ''}</span>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }} value={relEscopo} onChange={e => setRelEscopo(e.target.value)}>
                <option value="mes">Só do mês (resumo)</option>
                <option value="completo">Completo (cada pagamento)</option>
              </select>
              <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }} value={relSocio} onChange={e => setRelSocio(e.target.value)}>
                <option value="todos">Todos os sócios</option>
                {(ata.socios || []).map((s, i) => <option key={i} value={i}>{s.nome || `Sócio ${i + 1}`}</option>)}
              </select>
              <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => gerarRelatorioDistribuicaoAta({ formato: 'pdf', ata, competencia, empresaNome, planoMap, escopo: relEscopo, socioIdx: relSocio })} title="Gerar em PDF — arraste na conciliação para bater o saldo"><i className="ti ti-file-type-pdf" /> PDF</button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px', borderColor: theme.accent, color: theme.accent }} onClick={() => gerarRelatorioDistribuicaoAta({ formato: 'excel', ata, competencia, empresaNome, planoMap, escopo: relEscopo, socioIdx: relSocio })} title="Gerar em Excel"><i className="ti ti-file-spreadsheet" /> Excel</button>
            </div>
            <p style={{ fontSize: 11, color: theme.sub, margin: '6px 0 0' }}>O saldo a pagar de cada conta bate com a conciliação. Só o pagamento com data dentro de {competencia || 'MM/AAAA'} entra como "pago no mês". O "completo" lista cada pagamento (bom para mandar ao cliente).</p>
          </div>
        </>}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : 'Salvar configuração'}</button>
      </div>
    </Modal>
  )
}

function ModalSimples({ titulo, texto, onClose }) {
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <p style={{ color: theme.text, fontSize: 13.5, lineHeight: 1.6 }}>{texto}</p>
      <Rodape onClose={onClose} fechar />
    </Modal>
  )
}

function LinhaTitulo({ titulo, onAdd }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 8px' }}>
      <span style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4 }}>{titulo}</span>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={onAdd}><i className="ti ti-plus" /> Adicionar</button>
    </div>
  )
}

function Modal({ titulo, sub, children, onClose, largura = 520 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: `min(${largura}px, 96vw)`, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 17 }}>{titulo}</h2>
            {sub && <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 2 }}>{sub}</p>}
          </div>
          <i className="ti ti-x" style={{ color: theme.sub, cursor: 'pointer', fontSize: 18 }} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}
function Rodape({ onClose, onSalvar, fechar }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
      <button className="btn btn-ghost" onClick={onClose}>{fechar ? 'Fechar' : 'Cancelar'}</button>
      {!fechar && <button className="btn" onClick={onSalvar}>Salvar</button>}
    </div>
  )
}

/* ---------- estilos ---------- */
const cardBase = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }
const btnMini = { fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }
const badge = (bg, cor) => ({ background: bg, color: cor, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0 })

function Wrapper({ children, nome }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Base de Informações</h1>
        <InfoTela titulo="Base de Informações">Cadastros e parâmetros do cliente que abastecem o fechamento (contas, centros de custo, regras). É a base consultada pelas telas de fechamento.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Parâmetros do cliente{nome ? <> <b style={{ color: theme.text }}>{nome}</b></> : ''} — valem para todos os fechamentos.
      </p>
      {children}
    </div>
  )
}
function Aviso({ texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
