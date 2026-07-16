import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money, moneyDC } from '../lib/theme'
import { montarBalancete, parsePlano, composicaoAbertura, difConciliacao, applyMask, erroContaSintetica, ehCompetenciaInicial, excluirLinhaAbertura } from '../lib/balancete'
import { abrePdfTimbrado } from '../lib/pdf'
import { gerarExcelTimbrado } from '../lib/excel'
import { listarComentariosConta, adicionarComentario, excluirComentario } from '../lib/comentarios'
import { aberturaComp, excluirSaldoInicialTudo } from '../lib/cargaInicial'
import CampoConta from '../components/CampoConta'

const dataHora = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }

// Comentários da conta (histórico que acompanha a conta em todos os meses). Independe da
// competência: fica por cliente + conta e vai acumulando a cada fechamento. Aparece também
// no Book de Composições. Editável aqui na Conciliação.
function ComentariosConta({ clienteId, conta, usuario }) {
  const [itens, setItens] = useState(null)
  const [texto, setTexto] = useState('')
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    let vivo = true
    listarComentariosConta(clienteId, conta).then(r => { if (vivo) setItens(r) })
    return () => { vivo = false }
  }, [clienteId, conta])

  async function adicionar() {
    const t = texto.trim()
    if (!t || salvando) return
    setSalvando(true)
    const { data, error } = await adicionarComentario(clienteId, conta, t, usuario)
    setSalvando(false)
    if (!error && data) { setItens(l => [data, ...(l || [])]); setTexto('') }
  }
  async function remover(id) {
    if (!window.confirm('Excluir este comentário do histórico da conta?')) return
    await excluirComentario(id)
    setItens(l => (l || []).filter(i => i.id !== id))
  }

  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16 }}>
      <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>Comentários da conta</p>
      <p style={{ fontSize: 12, color: theme.sub, margin: '0 0 10px' }}>
        Observações que acompanham esta conta em <b>todos os meses</b> (vão para o Book). Todo mundo acompanha o que está acontecendo.
      </p>
      <textarea className="input" rows={2} value={texto} onChange={e => setTexto(e.target.value)} placeholder="Escreva um comentário sobre esta conta…" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn" disabled={!texto.trim() || salvando} onClick={adicionar}><i className="ti ti-message-plus" /> Adicionar comentário</button>
      </div>
      <div style={{ marginTop: 12 }}>
        {itens === null ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Carregando…</p>
          : itens.length === 0 ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhum comentário ainda.</p>
          : itens.map(c => (
            <div key={c.id} style={{ borderTop: `1px solid ${theme.border}`, padding: '9px 0', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <i className="ti ti-message-2" style={{ color: theme.accent, fontSize: 16, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: theme.text, whiteSpace: 'pre-wrap' }}>{c.texto}</div>
                <div style={{ fontSize: 11, color: theme.sub, marginTop: 3 }}>{dataHora(c.created_at)}{c.usuario ? ` · ${String(c.usuario).split('@')[0]}` : ''}</div>
              </div>
              <span onClick={() => remover(c.id)} title="Excluir" style={{ cursor: 'pointer', color: theme.sub, fontSize: 15 }}><i className="ti ti-trash" /></span>
            </div>
          ))}
      </div>
    </div>
  )
}

// NF no histórico só faz sentido em contas de cliente/fornecedor (a pagar/a receber,
// duplicatas, adiantamentos). Nas demais (banco, despesa, etc.) o histórico sai sem NF.
const contaComNF = (nome) => {
  const s = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  // cliente/fornecedor/duplicata/adiantamento, ou "contas/títulos/valores a pagar/receber"
  // (exclui "salários a pagar", "impostos a pagar" etc. — não envolvem NF).
  return /cliente|fornecedor|duplicata|adiantament|(contas?|titulos?|valores?|creditos?) a (pagar|receber)/.test(s)
}

// ---- Leitura do histórico: extrai NF e entidade (cliente/fornecedor) com confiança ----
const RUIDO = /\b(VENDA|VENDAS|COMPRA|COMPRAS|PAGTO|PAGAMENTO|RECEBIMENTO|RECEBTO|REF|REFERENTE|NOTA|FISCAL|DUPLICATA|DUPL|BOLETO|TITULO|TÍTULO|VLR|VALOR|PARCELA|PARC|CONF|S\/|A|DE|DA|DO|DOS|DAS|E|NO|NA|EM)\b/ig
// Remove o sufixo societário (S.A, LTDA, EIRELI, ME, EPP) e o que vier depois.
const tiraSufixo = e => e.replace(/\s+(S[./]?\s?A\.?|LTDA\.?|EIRELI|EPP|ME)\b.*$/i, '').replace(/\s+/g, ' ').trim()

// ---- Unificação de nomes parecidos (mesmo cliente/fornecedor escrito de formas diferentes) ----
// Palavras genéricas de razão social: não distinguem uma empresa de outra, então são ignoradas
// na comparação (senão "...DE FORCA E LUZ" casaria empresas distintas).
const GENERICAS = new Set(['COMPANHIA', 'CIA', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'ENERGIA', 'ENERGIAS', 'ELETRICA', 'ELETRICAS', 'FORCA', 'LUZ', 'COMERCIO', 'COMERCIAL', 'INDUSTRIA', 'INDUSTRIAL', 'SERVICO', 'SERVICOS', 'BRASIL', 'NACIONAL', 'GRUPO', 'HOLDING', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'TRANSPORTE', 'TRANSPORTES', 'LOGISTICA', 'SOLUCOES', 'TECNOLOGIA', 'SISTEMAS', 'ASSOCIACAO', 'INSTITUTO', 'FUNDACAO', 'BANCO', 'SUPERMERCADO', 'SUPERMERCADOS', 'ALIMENTOS', 'DO', 'DA', 'DE', 'DOS', 'DAS', 'E', 'EM'])
const normNome = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
// Tokens distintivos de um nome (>=3 letras, sem genéricas). Se sobrar vazio, usa todos.
function tokensNome(nome) {
  const todos = normNome(nome).split(' ').filter(Boolean)
  const dist = todos.filter(t => t.length >= 3 && !GENERICAS.has(t))
  return dist.length ? dist : todos
}
// Dois nomes são o mesmo cliente se um conjunto de tokens é subconjunto do outro,
// ou a interseção cobre a maioria do menor e há um token forte (>=4 letras) em comum.
function mesmoCliente(a, b) {
  const inter = a.filter(t => b.includes(t))
  if (!inter.length) return false
  const menor = Math.min(a.length, b.length)
  if (inter.length === menor) return true
  return inter.length / menor >= 0.6 && inter.some(t => t.length >= 4)
}

function lerHistorico(h) {
  const s = String(h || '').trim()
  const nfm = s.match(/\bNF\.?\s*(?:N[ºo°.]*\s*)?(\d{2,9})/i) || s.match(/\bNOTA\s*(?:FISCAL)?\s*N?[ºo°.]*\s*(\d{2,9})/i) || s.match(/\bN[ºo°]\.?\s*(\d{2,9})/i)
  const nf = nfm ? nfm[1] : (s.match(/\b(\d{3,9})\b/)?.[1] || '')

  // O nome do cliente/fornecedor vem antes do bloco fiscal (CF./NF/NOTA/RPS).
  const corpo = s.split(/\s(?:CF\b|NF\b|NOTA\s+FISCAL|RPS\b)/i)[0].trim()
  let entidade = '', ident = false
  const mRec = corpo.match(/\b(?:RECEBIMENTO|RECEBTO|PAGAMENTO|PAGTO)\s+(?:A\s+|DE\s+|AO\s+)?(.+)$/i)
  if (mRec) {
    // "VALOR REF. RECEBIMENTO <NOME> NF ..."
    entidade = tiraSufixo(mRec[1].trim()); ident = true
  } else if (/\s[-–]\s/.test(corpo)) {
    // "... - ACUM. N - <NOME> CF. NF. ..." → último segmento entre travessões
    const segs = corpo.split(/\s[-–]\s/).map(x => x.trim()).filter(Boolean)
    entidade = tiraSufixo(segs[segs.length - 1]); ident = true
  }
  // Fallback: heurística antiga de remoção de ruído (leitura incerta).
  if (!entidade || entidade.length < 3) {
    entidade = s.replace(nfm ? nfm[0] : '', ' ').replace(/\b\d+\b/g, ' ').replace(RUIDO, ' ').replace(/[.\-/]+/g, ' ').replace(/\s+/g, ' ').trim()
    ident = false
  }
  // Confiança: alta = nome confiável + NF; média = nome confiável sem NF; baixa = leitura incerta.
  let conf = 'baixa'
  if (ident && entidade.length >= 4 && nf) conf = 'alta'
  else if (ident && entidade.length >= 4) conf = 'media'
  return { nf, entidade: entidade || '', ident, conf }
}

// Aplica um ajuste de leitura (correção manual de NF/nome/histórico) sobre o lançamento.
function aplicarAjuste(l, aj) {
  let historico = l.historico
  let leitura = lerHistorico(historico)
  if (aj) {
    if (aj.historico) { historico = aj.historico; leitura = lerHistorico(historico) }
    if (aj.nf) leitura = { ...leitura, nf: String(aj.nf).trim() }
    if (aj.entidade) leitura = { ...leitura, entidade: String(aj.entidade).trim(), ident: true }
    const ent = (leitura.entidade || '')
    leitura = { ...leitura, ajustado: true, conf: (leitura.ident && ent.length >= 4 && leitura.nf) ? 'alta' : (leitura.ident && ent.length >= 4) ? 'media' : leitura.conf }
  }
  return { ...l, historico, leitura }
}

function tipoConta(nome) {
  const n = (nome || '').toLowerCase()
  if (/(icms|pis|cofins|iss|imposto|tribut|darf|das\b)/.test(n)) return 'Imposto'
  if (/(cliente|duplicata|receber|fornecedor|pagar|estoque|mercadoria)/.test(n)) return 'Composição'
  return 'Saldo'
}

// Agrupa lançamentos por cliente/fornecedor (unificando nomes parecidos) → blocos p/ relatório.
function agruparPorCliente(lancs) {
  // Título e pagamento com a MESMA NF específica (>=5 díg.) são o mesmo fornecedor, mesmo
  // com o nome lido diferente (ex.: "RSM ... AUDITORIA" no título e "RSM ... AUDITORES
  // INDEPENDENTES" no pagamento). Junta os dois no MESMO bloco — assim o subtotal do
  // fornecedor bate (débito e crédito juntos) no "Conciliados".
  const canonPorNF = {}
  const porNF = {}
  for (const l of lancs) { const nf = nfKey(l.leitura?.nf); if (nf && nf.length >= 5 && l.leitura?.ident && String(l.leitura.entidade || '').trim()) (porNF[nf] = porNF[nf] || []).push(l.leitura.entidade.trim()) }
  for (const nf in porNF) { const ns = [...new Set(porNF[nf])]; if (ns.length > 1) canonPorNF[nf] = ns.slice().sort((a, b) => a.length - b.length)[0] } // rótulo: o nome mais curto (mais limpo)
  const nomeCanon = l => {
    const nf = nfKey(l.leitura?.nf)
    if (nf && canonPorNF[nf]) return canonPorNF[nf]
    return l.leitura?.ident && l.leitura.entidade ? l.leitura.entidade : '(não identificado)'
  }
  const grupos = {}, nomes = []
  for (const l of lancs) {
    const k = nomeCanon(l)
    if (!grupos[k]) { grupos[k] = []; nomes.push(k) }
    grupos[k].push(l)
  }
  const idents = nomes.filter(k => k !== '(não identificado)')
  const tk = Object.fromEntries(idents.map(k => [k, tokensNome(k)]))
  const clusters = []
  for (const k of idents) {
    const alvo = clusters.find(cl => cl.some(m => mesmoCliente(tk[k], tk[m])))
    if (alvo) alvo.push(k); else clusters.push([k])
  }
  if (grupos['(não identificado)']) clusters.push(['(não identificado)'])
  return clusters.map(membros => {
    const cliente = membros.slice().sort((a, b) => b.length - a.length)[0]
    return { cliente, lancs: membros.flatMap(m => grupos[m]) }
  }).sort((a, b) => (a.cliente === '(não identificado)' ? 1 : 0) - (b.cliente === '(não identificado)' ? 1 : 0) || a.cliente.localeCompare(b.cliente, 'pt-BR'))
}

// Composição "por entidade" (cliente/fornecedor + NF): só clientes, fornecedores,
// contas a pagar e adiantamentos. As demais contas mostram só os lançamentos do razão,
// sem extrair nome/NF nem agrupar por entidade.
function ehPorEntidade(nome) {
  const n = baixaTxt(nome)
  return /client|fornecedor|duplicat|adiantament|contas? a pagar|a receber/.test(n)
}

// Conta retificadora (redutora): saldo na natureza invertida é NORMAL — não destacar.
// Padrão Domínio: nome começa com "(-)"; também depreciação/amortização/PCLD/perdas.
function ehRedutora(nome) {
  const n = baixaTxt(nome)
  return /\(\s*-\s*\)|deprecia|amortiza|exaust|pcld|perdas estimad|provis[aã]o para perda|redutora/.test(n) || /^\s*\(?\s*-/.test(String(nome || ''))
}

// Chave da NF ignorando zeros à esquerda e não-dígitos: "05602823" e "5602823" casam.
const nfKey = nf => String(nf ?? '').replace(/\D/g, '').replace(/^0+/, '')

// Baixa (conciliação) por NÚMERO DA NOTA + cliente: um débito e um crédito só se
// conciliam (zeram) quando têm a MESMA NF (ignorando zeros à esquerda) e o cliente bate
// (nome aproximado). Valor igual com NF diferente NÃO zera (ex.: faturou NF 3256 e
// recebeu NF 3249 — títulos distintos). Retorna { baixados, aproximadas } onde
// aproximadas são as NFs que só casaram após ignorar zeros (para alertar e confirmar).
function baixadosPorNF(lancs) {
  const porNF = {}
  for (const l of lancs) { const nf = nfKey(l.leitura?.nf); if (nf) (porNF[nf] = porNF[nf] || []).push(l) }
  const baixados = new Set()
  const aproximadas = []
  // Tenta baixar um conjunto de lançamentos da mesma NF+cliente: precisa de débito e
  // crédito e o líquido tem que zerar.
  const tryBaix = grp => {
    const temD = grp.some(l => Number(l.debito) > 0.005)
    const temC = grp.some(l => Number(l.credito) > 0.005)
    if (!temD || !temC) return
    if (Math.abs(grp.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)) >= 0.005) return
    for (const l of grp) baixados.add(l)
    const strs = [...new Set(grp.map(l => String(l.leitura?.nf ?? '').trim()).filter(Boolean))]
    if (strs.length > 1) aproximadas.push(strs.join(' = '))
  }
  const nomeDe = l => (l.leitura?.ident && l.leitura.entidade) ? l.leitura.entidade : null
  for (const nf in porNF) {
    const grp = porNF[nf]
    // Clusters de cliente DENTRO desta NF — números pequenos (NF 64) se repetem entre
    // fornecedores diferentes; sem separar, o nome não bate entre todos e nada baixava.
    const nomes = [...new Set(grp.map(nomeDe).filter(Boolean))]
    const clusters = []
    for (const nm of nomes) { const tk = tokensNome(nm); const c = clusters.find(c => mesmoCliente(c.tk, tk)); if (c) c.nomes.push(nm); else clusters.push({ tk, nomes: [nm] }) }
    if (clusters.length <= 1) { tryBaix(grp); continue } // um cliente só (ou nenhum identificado) → como antes
    // Vários NOMES na mesma NF. Mas se a NF é ESPECÍFICA (>=5 dígitos — praticamente única
    // entre fornecedores) e há UM só nome em cada LADO (um crédito=título e um débito=
    // pagamento), é o mesmo título com o nome lido de formas diferentes (ex.: "RSM ...
    // AUDITORIA E CONSULTORIA" no saldo anterior vs "RSM ... AUDITORES INDEPENDENTES" no
    // pagamento) — confia na NF e baixa o par. Só NF curta repetida entre fornecedores
    // (ex.: 64) separa por nome, para não casar o título de um com o pagamento de outro.
    const nomesLado = teste => [...new Set(grp.filter(teste).map(nomeDe).filter(Boolean))]
    const nomesD = nomesLado(l => Number(l.debito) > 0.005)
    const nomesC = nomesLado(l => Number(l.credito) > 0.005)
    if (nf.length >= 5 && nomesD.length <= 1 && nomesC.length <= 1) { tryBaix(grp); continue }
    // Vários clientes na mesma NF → casa cada cliente isoladamente (o par certo baixa).
    for (const c of clusters) tryBaix(grp.filter(l => { const nm = nomeDe(l); return nm && mesmoCliente(tokensNome(nm), c.tk) }))
  }
  return { baixados, aproximadas }
}

// Natureza invertida do SALDO da conta (não redutora):
// 'credor' = conta do Ativo (1) com saldo credor; 'devedor' = Passivo (2) com saldo devedor.
// Contas de DUPLA NATUREZA: podem ficar devedoras OU credoras normalmente, então não se
// alerta natureza invertida (ex.: Ajustes de Exercícios Anteriores, Lucros/Prejuízos
// Acumulados, Resultado do Exercício, Conta Corrente de Sócios). Vale para todos os clientes.
function ehDuplaNatureza(nome) {
  const n = baixaTxt(nome)
  return /ajuste.{0,6}exerc|exerc.{0,8}anterior|lucros?.{0,8}preju|preju[ií]zos?.{0,6}acumulad|lucros?.{0,6}acumulad|resultado.{0,8}(do\s+)?exerc|resultado.{0,6}acumulad|conta.?corrente.{0,14}(s[oó]cio|acionist|cotist)|(s[oó]cio|acionist|cotist).{0,14}conta.?corrente/.test(n)
}
function saldoInvertido(classifRaw, nome, saldoFinal, redutoraCtx) {
  if (redutoraCtx || ehRedutora(nome) || ehDuplaNatureza(nome)) return null
  const d = String(classifRaw || '').replace(/\D/g, '')[0]
  const s = Number(saldoFinal) || 0
  if (d === '1' && s < -0.005) return 'credor'
  if (d === '2' && s > 0.005) return 'devedor'
  return null
}


const baixaTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Deriva o tipo de tratamento (Composição/Imposto/Saldo) a partir da classificação do plano.
function tipoPorClassif(c) {
  const n = baixaTxt(c)
  if (!n) return ''
  if (/imposto|icms|pis|cofins|tribut/.test(n)) return 'Imposto'
  if (/composi/.test(n)) return 'Composição'
  if (/saldo|banco|simples/.test(n)) return 'Saldo'
  return ''
}

// Tipo de conta na conciliação:
// - 'saldo'      → não tem composição; vale o saldo final, validado por documento (extrato).
//                  Padrão para Disponível (caixa, bancos, aplicações) = classificação 1.1.1.
// - 'composicao' → o saldo é formado pelos lançamentos (clientes, fornecedores, impostos a pagar…).
function tipoAuto(classifRaw) {
  const c = String(classifRaw || '').replace(/\D/g, '')
  return c.startsWith('111') ? 'saldo' : 'composicao'
}
const LABEL_TIPO = { saldo: 'Saldo', composicao: 'Composição' }

export default function Conciliacao() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()
  const [compId, setCompId] = useState(null)
  const [baseContas, setBaseContas] = useState([]) // contas do balancete (Ativo/Passivo)
  const [planoRed, setPlanoRed] = useState({})     // reduzido → { nome, classif, sintetica } (p/ contas só de lançamento)
  const [planoFull, setPlanoFull] = useState([])   // plano inteiro (p/ achar as sintéticas ancestrais)
  const [planoMask, setPlanoMask] = useState('9.9.9.999.9999') // máscara de classificação do cliente
  const [conf, setConf] = useState({}) // conta -> registro conciliacao_conta
  const [acertos, setAcertos] = useState({}) // conta -> ajuste (soma dos lançamentos de acerto pendentes)
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null) // conta selecionada (detalhe)
  const [filtroFarol, setFiltroFarol] = useState('todos') // 'todos' | 'red' | 'yellow' | 'green'
  const [saldoIni, setSaldoIni] = useState({ periodo: '', fechada: false }) // trava do saldo inicial (abertura)

  // Competência de abertura do cliente + se está fechada (para o atalho de excluir saldo inicial).
  useEffect(() => {
    let ativo = true
    if (!empresaId) { setSaldoIni({ periodo: '', fechada: false }); return }
    supabase.from('clientes').select('competencia_inicio').eq('id', empresaId).maybeSingle()
      .then(async ({ data }) => { const per = data?.competencia_inicio || ''; const ab = await aberturaComp(empresaId, per); if (ativo) setSaldoIni({ periodo: per, fechada: !!ab.fechada }) })
    return () => { ativo = false }
  }, [empresaId])

  async function excluirSaldoIni() {
    if (saldoIni.fechada) { alert('A competência de abertura está FECHADA. Reabra-a para mexer no saldo inicial.'); return }
    if (!window.confirm('Excluir TODO o saldo inicial (carga inicial) deste cliente? Você poderá subir os arquivos de novo em Base de Informações.')) return
    try { const n = await excluirSaldoInicialTudo(empresaId, saldoIni.periodo, user?.email); alert(`Saldo inicial excluído (${n} registro(s)).`); recarregar() }
    catch (e) { alert(e.message) }
  }
  // Clicar em "Conciliação" no menu (mesma rota) volta para a lista, mesmo estando
  // no detalhe de uma conta — cada navegação gera uma location.key nova.
  const location = useLocation()
  useEffect(() => { setSel(null) }, [location.key])

  async function carregarConf(cid) {
    const { data } = await supabase.from('conciliacao_conta').select('*').eq('competencia_id', cid)
    const m = {}; for (const r of (data || [])) m[r.conta] = r
    setConf(m)
  }

  // Correções pendentes (tabela lançamentos) alteram o saldo da conta antes mesmo
  // de irem para o Domínio. Somamos aqui para o saldo "efetivo" reconferir com o extrato.
  async function carregarAcertos(cid) {
    const { data } = await supabase.from('lancamentos').select('conta_debito, conta_credito, valor').eq('competencia_id', cid)
    const m = {}
    const add = (c, campo, v) => { if (!c) return; m[c] = m[c] || { deb: 0, cred: 0 }; m[c][campo] += v }
    for (const l of (data || [])) {
      const v = Number(l.valor) || 0
      add(l.conta_debito, 'deb', v)
      add(l.conta_credito, 'cred', v)
    }
    setAcertos(m)
  }
  const recarregar = () => { if (compId) { carregarConf(compId); carregarAcertos(compId) } }
  const ajNet = c => { const a = acertos[c.conta]; return a ? a.deb - a.cred : 0 } // efeito no saldo (D-C)
  const saldoEf = c => (Number(c.saldo_final) || 0) + ajNet(c)

  useEffect(() => {
    setSel(null); setBaseContas([]); setCompId(null); setConf({}); setPlanoRed({}); setPlanoFull([])
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)
    const [mes, ano] = competencia.split('/').map(Number)
    supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      .then(async ({ data: comp }) => {
        if (!comp) { setCarregando(false); return }
        setCompId(comp.id)
        const { linhas } = await montarBalancete(empresaId, comp.id)
        // Conciliação trata só Ativo (1) e Passivo (2). Receita/Custos/Despesa vão no Comparativo.
        const ap = linhas.filter(l => { const d = String(l.classifRaw || l.classif).trim()[0]; return d === '1' || d === '2' })
        setBaseContas(ap.map(l => ({ ...l, conta: l.reduzido })))
        // Índice do plano (reduzido → nome/classif) p/ mostrar contas que só têm
        // lançamento manual/correção e não vieram no balancete importado.
        const { data: pc } = await supabase.from('cargas_cadastro').select('dados')
          .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
        const parsed = parsePlano(pc?.dados)
        const idx = {}
        for (const p of parsed) { if (p.reduzido) idx[String(p.reduzido)] = { nome: p.nome, classif: p.classif, sintetica: !!p.sintetica } }
        setPlanoRed(idx)
        setPlanoFull(parsed)
        setPlanoMask(parsed.find(p => p.mascara)?.mascara || '9.9.9.999.9999')
        await carregarConf(comp.id)
        await carregarAcertos(comp.id)
        setCarregando(false)
      })
  }, [empresaId, competencia])

  const tipoEf = c => conf[c.conta]?.tipo || tipoAuto(c.classifRaw)

  // Régua única (todas as contas começam vermelhas):
  // - Verde:   documento suporte importado que bate com o saldo.
  // - Amarelo: confirmada ("está certo") e com justificativa da falta de documento.
  // - Vermelho: nada disso (padrão).
  function statusConta(c) {
    const reg = conf[c.conta]
    if (!reg) return theme.red
    const docBate = reg.documento_path && reg.saldo_documento != null &&
      Math.abs(difConciliacao(saldoEf(c), reg.saldo_documento)) < 0.05 // natureza da conta (D/C)
    if (docBate) return theme.green
    if (reg.conciliada && reg.justificativa) return theme.yellow
    return theme.red
  }

  async function trocaTipo(c) {
    const novo = tipoEf(c) === 'saldo' ? 'composicao' : 'saldo'
    const reg = conf[c.conta]
    if (reg) await supabase.from('conciliacao_conta').update({ tipo: novo, usuario: user?.email }).eq('id', reg.id)
    else await supabase.from('conciliacao_conta').insert({ competencia_id: compId, conta: c.conta, tipo: novo, usuario: user?.email })
    carregarConf(compId)
  }

  // Contas que só têm LANÇAMENTO (manual/correção) e não vieram no balancete importado
  // (ex.: "a distribuir" de um sócio recém-criada). Entram na lista como analíticas com
  // saldo de balancete zero — o acerto do lançamento vira o saldo efetivo. Só Ativo/Passivo.
  const dig = s => String(s || '').replace(/\D/g, '')
  const mk = x => applyMask(dig(x), planoMask) // classificação com pontos (padrão das demais contas)
  const baseSet = new Set(baseContas.map(c => String(c.reduzido)))
  const baseClassif = new Set(baseContas.map(c => dig(c.classifRaw || c.classif)))
  // Analíticas que só têm lançamento (não vieram no balancete) — Ativo/Passivo.
  const analiticasExtra = Object.keys(acertos)
    .filter(cod => !baseSet.has(String(cod)) && planoRed[String(cod)] && !planoRed[String(cod)].sintetica && ['1', '2'].includes(dig(planoRed[String(cod)].classif)[0]))
    .map(cod => {
      const p = planoRed[String(cod)]; const raw = dig(p.classif); const ac = acertos[String(cod)] || { deb: 0, cred: 0 }
      // O movimento do lançamento manual entra nas colunas Débito/Crédito (o saldo já
      // vem por ajNet). saldo_final fica 0 para não duplicar o valor no saldo efetivo.
      return { reduzido: String(cod), conta: String(cod), classif: mk(p.classif), classifRaw: raw, nome: p.nome || '', sintetica: false, folha: true, saldo_final: 0, saldo_inicial: 0, debito: ac.deb || 0, credito: ac.cred || 0 }
    })
  // Sintéticas ANCESTRAIS dessas analíticas que ainda não estão na lista — para amarrar a
  // analítica à(s) sintética(s) no painel, igual às demais contas. Saldo vem da soma das
  // analíticas (ajSintMap, por prefixo de classificação); Débito/Crédito somam as filhas.
  const sintMap = {}
  for (const a of analiticasExtra) {
    for (const p of planoFull) {
      if (!p.sintetica) continue
      const sr = dig(p.classif)
      if (!sr || sr === a.classifRaw || !a.classifRaw.startsWith(sr) || baseClassif.has(sr) || sintMap[sr]) continue
      sintMap[sr] = { reduzido: p.reduzido ? String(p.reduzido) : '', conta: String(p.reduzido || `sint_${sr}`), classif: mk(p.classif), classifRaw: sr, nome: p.nome || '', sintetica: true, folha: false, saldo_final: 0, saldo_inicial: 0, debito: 0, credito: 0 }
    }
  }
  for (const a of analiticasExtra) for (const sr in sintMap) if (a.classifRaw.startsWith(sr)) { sintMap[sr].debito += a.debito; sintMap[sr].credito += a.credito }
  const extras = [...analiticasExtra, ...Object.values(sintMap)]
  // Ordena TODAS as contas pela classificação (dígitos) — assim as contas criadas por
  // lançamento (ex.: "a distribuir" de um sócio) entram na posição certa, não no fim.
  // A comparação por string dos dígitos preserva a hierarquia (sintética = prefixo → antes).
  const chaveClassif = c => String(c.classifRaw || c.classif || '').replace(/\D/g, '')
  const contas = (extras.length ? [...baseContas, ...extras] : [...baseContas])
    .sort((a, b) => { const ka = chaveClassif(a), kb = chaveClassif(b); return ka < kb ? -1 : ka > kb ? 1 : 0 })
  // Redutora por herança da sintética: se a SINTÉTICA-mãe é redutora (ex.: "(–) Depreciações
  // Acumuladas"), a analítica também é — então saldo na natureza invertida é NORMAL nela.
  const prefixosRedutores = contas.filter(c => c.sintetica && ehRedutora(c.nome)).map(chaveClassif).filter(Boolean)
  const herdaRedutora = c => { const cr = chaveClassif(c); return !!cr && prefixosRedutores.some(sr => cr.length > sr.length && cr.startsWith(sr)) }

  if (!empresaId) return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral." /></Wrapper>
  if (carregando) return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  if (!compId || contas.length === 0) return <Wrapper><Aviso icon="ti-table-off" texto="Nenhum balancete nesta competência. Importe o razão primeiro." /></Wrapper>

  if (sel) return <Detalhe conta={sel} tipoCta={tipoEf(sel)} reg={conf[sel.conta]} compId={compId} empresaId={empresaId} usuario={user?.email} competencia={competencia} ajuste={acertos[sel.conta] || null} getCompetenciaId={getCompetenciaId} onSalvarConf={recarregar} onMudou={recarregar} onVoltar={() => setSel(null)} />

  // A SINTÉTICA é a soma das ANALÍTICAS: as correções/estornos pendentes ficam nas
  // analíticas (acertos por conta), então acumulamos o ajuste nas sintéticas ancestrais
  // (classificação que é prefixo) para o total refletir os estornos feitos embaixo.
  // Débito E crédito das correções pendentes acumulados nas sintéticas ancestrais (por
  // prefixo de classificação) — para a MOVIMENTAÇÃO (não só o saldo) refletir os estornos.
  const ajSintDC = (() => {
    const map = {}
    const sints = contas.filter(c => c.sintetica)
    for (const a of contas) {
      if (a.sintetica) continue
      const acc = acertos[a.conta]
      if (!acc || (Math.abs(acc.deb) < 0.005 && Math.abs(acc.cred) < 0.005)) continue
      const ar = String(a.classifRaw || a.classif)
      for (const s of sints) {
        const sr = String(s.classifRaw || s.classif)
        if (ar !== sr && ar.startsWith(sr)) { const e = map[sr] || (map[sr] = { deb: 0, cred: 0 }); e.deb += acc.deb; e.cred += acc.cred }
      }
    }
    return map
  })()
  // Débito/crédito pendentes de uma conta (analítica = acertos dela; sintética = soma das filhas).
  const ajDebOf = c => c.sintetica ? (ajSintDC[String(c.classifRaw || c.classif)]?.deb || 0) : (acertos[c.conta]?.deb || 0)
  const ajCredOf = c => c.sintetica ? (ajSintDC[String(c.classifRaw || c.classif)]?.cred || 0) : (acertos[c.conta]?.cred || 0)
  const ajTotal = c => ajDebOf(c) - ajCredOf(c)
  const saldoEfAll = c => (Number(c.saldo_final) || 0) + ajTotal(c)

  // Contadores por farol (só analíticas — as sintéticas não têm status).
  const corFarol = { red: theme.red, yellow: theme.yellow, green: theme.green }
  const cont = { red: 0, yellow: 0, green: 0 }
  for (const c of contas) {
    if (c.sintetica) continue
    const s = statusConta(c)
    if (s === theme.red) cont.red++; else if (s === theme.yellow) cont.yellow++; else if (s === theme.green) cont.green++
  }
  // Lista visível: "todos" mostra tudo (com sintéticas); um farol específico mostra
  // só as analíticas daquele status (foca no que falta corrigir).
  const contasVis = filtroFarol === 'todos'
    ? contas
    : contas.filter(c => !c.sintetica && statusConta(c) === corFarol[filtroFarol])

  const farois = [
    { k: 'todos', cor: null, txt: 'Todos', n: cont.red + cont.yellow + cont.green },
    { k: 'red', cor: theme.red, txt: 'Vermelho', n: cont.red },
    { k: 'yellow', cor: theme.yellow, txt: 'Amarelo', n: cont.yellow },
    { k: 'green', cor: theme.green, txt: 'Verde', n: cont.green },
  ]

  return (
    <Wrapper nome={empresaNome} comp={competencia}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {farois.map(o => (
          <button key={o.k} onClick={() => setFiltroFarol(o.k)} className="btn btn-ghost"
            title={o.k === 'red' ? 'Pendente' : o.k === 'yellow' ? 'Confirmada + justificada (sem documento)' : o.k === 'green' ? 'Documento bate com o saldo' : 'Mostrar todas'}
            style={{ fontSize: 12, padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 7, fontWeight: filtroFarol === o.k ? 700 : 400, borderColor: filtroFarol === o.k ? (o.cor || theme.accent) : theme.cb, background: filtroFarol === o.k ? 'rgba(255,255,255,0.05)' : 'transparent' }}>
            {o.cor ? <Dot c={o.cor} /> : <i className="ti ti-list" />} {o.txt} <span style={{ color: theme.sub }}>({o.n})</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {saldoIni.periodo && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px', color: saldoIni.fechada ? theme.sub : theme.red, borderColor: saldoIni.fechada ? theme.cb : 'rgba(229,72,77,0.4)' }} disabled={saldoIni.fechada} onClick={excluirSaldoIni} title={saldoIni.fechada ? `Abertura (${saldoIni.periodo}) fechada — reabra para mexer no saldo inicial` : 'Apagar TODO o saldo inicial para subir os arquivos de novo (Base de Informações)'}><i className={`ti ${saldoIni.fechada ? 'ti-lock' : 'ti-trash'}`} /> {saldoIni.fechada ? 'Saldo inicial travado' : 'Excluir saldo inicial'}</button>}
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', minWidth: 960, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Conta</th><th style={th}>Classificação</th><th style={th}>Nome da Conta</th><th style={th}>Tipo</th>
              <th style={thR}>Saldo inicial</th><th style={thR}>Débito</th>
              <th style={thR}>Crédito</th><th style={thR}>Saldo atual</th><th style={{ ...th, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {contasVis.length === 0 && (
              <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: theme.sub, padding: 20 }}>Nenhuma conta com esse farol.</td></tr>
            )}
            {contasVis.map((c, i) => {
              const sint = c.sintetica
              const peso = sint ? 700 : 400 // só as sintéticas em negrito
              const t = tipoEf(c)
              const inv = sint ? null : saldoInvertido(c.classifRaw, c.nome, saldoEfAll(c), herdaRedutora(c))
              return (
                <tr key={i} onClick={() => !sint && setSel(c)}
                  style={{ borderTop: `1px solid ${theme.border}`, cursor: sint ? 'default' : 'pointer', background: inv ? 'rgba(229,72,77,0.08)' : sint ? theme.input : 'transparent', fontWeight: peso }}>
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{c.reduzido || ''}</td>
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{c.classif}</td>
                  <td style={{ ...td, fontWeight: peso }}>
                    {c.nome || '—'}
                    {inv && <span title={`Conta do ${inv === 'credor' ? 'Ativo com saldo credor' : 'Passivo com saldo devedor'} (não é redutora) — verifique`} style={{ marginLeft: 8, background: 'rgba(229,72,77,0.18)', color: theme.red, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3 }}><i className="ti ti-alert-octagon" /> saldo {inv}</span>}
                  </td>
                  <td style={{ ...td }}>{sint ? '' : (
                    <span onClick={e => { e.stopPropagation(); trocaTipo(c) }} title="Clique para alternar Saldo / Composição"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: t === 'saldo' ? 'rgba(245,166,35,0.15)' : 'rgba(74,124,255,0.14)', color: t === 'saldo' ? theme.yellow : theme.accent }}>
                      {LABEL_TIPO[t]} <i className="ti ti-switch-horizontal" style={{ fontSize: 12 }} />
                    </span>)}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{moneyDC(c.saldo_inicial)}</td>
                  <td style={{ ...tdR, fontWeight: peso }} title={Math.abs(ajDebOf(c)) > 0.005 ? `Balancete ${money(c.debito)} + correções pendentes ${money(ajDebOf(c))}` : undefined}>
                    {money((Number(c.debito) || 0) + ajDebOf(c))}
                    {Math.abs(ajDebOf(c)) > 0.005 && <span title="Inclui correções pendentes de contabilização" style={{ marginLeft: 5, color: theme.accent, fontSize: 10, fontWeight: 700 }}>±</span>}
                  </td>
                  <td style={{ ...tdR, fontWeight: peso }} title={Math.abs(ajCredOf(c)) > 0.005 ? `Balancete ${money(c.credito)} + correções pendentes ${money(ajCredOf(c))}` : undefined}>
                    {money((Number(c.credito) || 0) + ajCredOf(c))}
                    {Math.abs(ajCredOf(c)) > 0.005 && <span title="Inclui correções pendentes de contabilização" style={{ marginLeft: 5, color: theme.accent, fontSize: 10, fontWeight: 700 }}>±</span>}
                  </td>
                  <td style={{ ...tdR, fontWeight: peso, color: inv ? theme.red : undefined }} title={Math.abs(ajTotal(c)) > 0.005 ? `Saldo do balancete ${moneyDC(c.saldo_final)} + correções pendentes ${moneyDC(ajTotal(c))}` : undefined}>
                    {moneyDC(saldoEfAll(c))}
                    {Math.abs(ajTotal(c)) > 0.005 && <span title="Inclui correções pendentes de contabilização" style={{ marginLeft: 6, color: theme.accent, fontSize: 10, fontWeight: 700 }}>±</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>{sint ? '' : <Dot c={statusConta(c)} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Wrapper>
  )
}

function Detalhe({ conta, tipoCta, reg, compId, empresaId, usuario, competencia, ajuste = null, getCompetenciaId, onSalvarConf, onMudou, onVoltar }) {
  const ajDeb = ajuste?.deb || 0, ajCred = ajuste?.cred || 0, ajNet = ajDeb - ajCred // correções pendentes
  const [lanc, setLanc] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [acao, setAcao] = useState(null)   // lançamento clicado (justificar/corrigir)
  const [verCorr, setVerCorr] = useState(null) // lançamento já tratado (ver o que foi feito / desfazer)
  const [plano, setPlano] = useState([])   // [{ cod, nome }] para os seletores de conta
  const [partidas, setPartidas] = useState({}) // chave (data|histórico) -> lançamentos da partida (p/ contrapartida)
  const [msg, setMsg] = useState('')
  const [verComposic, setVerComposic] = useState(null) // { titulo, itens } — composição de um saldo
  const [tratados, setTratados] = useState(new Set()) // razao_ids já corrigidos/estornados/justificados
  const [tratadosAb, setTratadosAb] = useState(new Set()) // itens de ABERTURA já conferidos (sem razao_id, chave AB·…)
  const [confirmados, setConfirmados] = useState(new Set()) // linhas confirmadas EM LOTE — saem do em aberto (Conciliados)
  const [verConferidos, setVerConferidos] = useState(false) // mostra a seção "Conferidos" (p/ reabrir)
  const [buscaNome, setBuscaNome] = useState('') // busca por nome na composição de clientes/fornecedores
  const [selLin, setSelLin] = useState(() => new Set()) // linhas marcadas p/ conectar (baixa manual)
  const [abertura, setAbertura] = useState({ inicial: false, fechada: false }) // esta competência é a de abertura? está fechada?
  const [loteForn, setLoteForn] = useState(null) // { lines } — corrigir fornecedor em lote
  const [conectarDif, setConectarDif] = useState(null) // { alvo, net } — apontar desconto/juros da diferença
  const [novoLanc, setNovoLanc] = useState(false)       // abre o modal de novo lançamento manual nesta conta
  const [nomesConf, setNomesConf] = useState(new Set())   // nomes CONFIÁVEIS do cliente (não pede revisão)
  const [nomesIsolados, setNomesIsolados] = useState(new Set()) // nomes a NÃO unir com parecidos (desvincular)
  const [nomesAlias, setNomesAlias] = useState({}) // APELIDOS: nomeAntigoKey -> nome correto (renomeia em todo lugar)
  const [aberturaAj, setAberturaAj] = useState({}) // ajustes por item de saldo inicial: {chave:{nf,entidade,historico}}
  const [acertoNomes, setAcertoNomes] = useState({}) // nome de fornecedor por lançamento de acerto: {uuid: nome}
  // Chave ESTÁVEL de um item de saldo inicial (não muda ao editar NF/nome/histórico): conta +
  // valor + nome ORIGINAL da carga. Usa _origEntidade quando já foi ajustado antes.
  const chaveAberturaAj = l => `${conta.conta}·${Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100)}·${chaveNome(l._origEntidade || l.leitura?.entidade || '')}`

  // Cadastro permanente de nomes do cliente (confiáveis + isolados + apelidos) — cargas_cadastro
  // tipo 'conciliacao_nomes', um por cliente (vale para todos os meses).
  const chaveNome = s => baixaTxt(s).replace(/\s+/g, ' ').trim()
  async function carregarNomes() {
    const { data } = await supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'conciliacao_nomes').order('created_at', { ascending: false }).limit(1).maybeSingle()
    const d = data?.dados && typeof data.dados === 'object' ? data.dados : {}
    setNomesConf(new Set((d.confiaveis || []).map(chaveNome)))
    setNomesIsolados(new Set((d.isolados || []).map(chaveNome)))
    setNomesAlias(d.aliases && typeof d.aliases === 'object' ? d.aliases : {})
    setAberturaAj(d.aberturaAjustes && typeof d.aberturaAjustes === 'object' ? d.aberturaAjustes : {})
    setAcertoNomes(d.acertoNomes && typeof d.acertoNomes === 'object' ? d.acertoNomes : {})
  }
  useEffect(() => { if (empresaId) carregarNomes() }, [empresaId]) // eslint-disable-line react-hooks/exhaustive-deps
  async function salvarNomes(conf, iso, aliases = nomesAlias, aberAj = aberturaAj, acNomes = acertoNomes) {
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', 'conciliacao_nomes')
    // vigencia é NOT NULL — usa a competência atual (o registro é único por cliente, lido sempre o mais recente).
    const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: 'conciliacao_nomes', vigencia: competencia || '00/0000', dados: { confiaveis: [...conf], isolados: [...iso], aliases: aliases || {}, aberturaAjustes: aberAj || {}, acertoNomes: acNomes || {} }, usuario })
    if (error) { setMsg('Não consegui salvar: ' + error.message); return error }
  }
  async function marcarConfiavel(nome) {
    const k = chaveNome(nome); if (!k) return
    const conf = new Set(nomesConf); conf.add(k); setNomesConf(conf)
    await salvarNomes(conf, nomesIsolados)
  }
  async function marcarIsolado(nome) {
    const k = chaveNome(nome); if (!k) return
    const iso = new Set(nomesIsolados); iso.add(k); setNomesIsolados(iso)
    await salvarNomes(nomesConf, iso)
    carregarLanc()
  }
  const [filtroSit, setFiltroSit] = useState('') // filtro por situação: ''|devedor|semtitulo|unificados|incerta|confirmaveis
  const [selEnt, setSelEnt] = useState(() => new Set()) // entidades marcadas p/ baixa em lote (por nome)

  async function carregarTratados() {
    // Linhas de razão são tratadas por razao_id (uuid). Linhas de ABERTURA (saldo inicial)
    // não têm razao_id — são tratadas por uma chave estável no campo `item` (prefixo "AB·").
    // CONFIRMADAS em lote (detalhe "Confirmado em lote…") SAEM do em aberto → Conciliados;
    // justificativas individuais continuam na composição (não escondem título aberto).
    const { data } = await supabase.from('auditoria').select('razao_id, item, detalhe')
      .eq('competencia_id', compId).eq('modulo', 'Conciliação')
    const rz = new Set(), ab = new Set(), conf = new Set()
    for (const a of (data || [])) {
      const abItem = String(a.item || '').startsWith('AB·') ? a.item : null
      const chave = a.razao_id || abItem
      if (!chave) continue
      if (a.razao_id) rz.add(a.razao_id); else ab.add(a.item)
      // BAIXA em lote: além do razao_id, guarda a chave ESTÁVEL (conta·data·NF, no `item`)
      // para a conciliação SOBREVIVER à REIMPORTAÇÃO do razão (novos uuid). Sem isso um lado
      // do par (ex.: o pagamento) vira órfão e o "Conciliados" desbalanceia. Só a baixa em
      // lote usa isso — as demais tratativas (ajuste/correção) seguem pelo razao_id, para
      // não mexer nos filtros/leitura incerta.
      if (String(a.detalhe || '').startsWith('Confirmado em lote')) { conf.add(chave); if (a.item && !abItem) conf.add(a.item) }
    }
    setTratados(rz); setTratadosAb(ab); setConfirmados(conf)
  }
  // Chave estável de uma linha de abertura (saldo inicial) e testes de "já tratada"/"confirmada".
  const chaveAbertura = l => `AB·${conta.conta}·${nfKey(l.leitura?.nf)}·${baixaTxt(l.leitura?.entidade || '')}·${Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100)}`
  // Chave estável de uma linha de razão pelo `item` (conta·data·NF) — igual à gravada na
  // auditoria por registrar()/baixarConexao(). Casa mesmo após reimportar o razão.
  const itemConc = l => `${conta.conta} · ${l.data || ''} · NF ${l.leitura?.nf || '—'}`
  // A chave `item` (conta·data·NF) só é usada quando é ÚNICA na conta — senão (ex.: vários
  // pagamentos no mesmo dia com NF genérica 062026) casaria linhas demais. Só o razao_id
  // (preciso) trata as ambíguas; a chave estável resgata as de NF específica após reimportar.
  const itemCount = {}
  for (const l of lanc) { if (!l._abertura && !l.acerto) { const k = itemConc(l); itemCount[k] = (itemCount[k] || 0) + 1 } }
  const itemUnico = l => itemCount[itemConc(l)] === 1
  const chaveTrat = l => l.acerto ? String(l.id).replace(/^ac_/, '') : (l._abertura ? chaveAbertura(l) : l.id)
  const jaTratada = l => l._abertura ? tratadosAb.has(chaveAbertura(l)) : tratados.has(l.id)
  const foiConfirmado = l => confirmados.has(chaveTrat(l)) || (!l._abertura && !l.acerto && itemUnico(l) && confirmados.has(itemConc(l))) // saiu do em aberto (conciliado)
  useEffect(() => { carregarTratados() }, [compId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function carregarLanc() {
    setCarregando(true)
    const [{ data: rz }, { data: aj }, { data: acs }, abertura, { data: cn }] = await Promise.all([
      supabase.from('razao').select('id, data, contrapartida, historico, debito, credito').eq('competencia_id', compId).eq('conta', conta.conta).order('data'),
      supabase.from('ajuste_leitura').select('razao_id, nf, entidade, historico').eq('competencia_id', compId),
      supabase.from('lancamentos').select('id, data, conta_debito, conta_credito, valor, historico, razao_id, origem').eq('competencia_id', compId),
      composicaoAbertura(empresaId, compId, conta.conta, conta.classifRaw, conta.nome),
      supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'conciliacao_nomes').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    // APELIDOS: renomeia o nome lido pelo nome correto (vale p/ saldo inicial e razão).
    const aliasMap = (cn?.dados?.aliases && typeof cn.dados.aliases === 'object') ? cn.dados.aliases : {}
    // Nomes CONFIÁVEIS do cliente → quem bate sobe para conf 'alta' (não pede revisão).
    const confSet = new Set(((cn?.dados?.confiaveis) || []).map(chaveNome))
    // Ajustes por item de saldo inicial (NF/nome/histórico) — não têm razao_id.
    const aberAjMap = (cn?.dados?.aberturaAjustes && typeof cn.dados.aberturaAjustes === 'object') ? cn.dados.aberturaAjustes : {}
    // Nome de fornecedor dado a um lançamento de acerto (por uuid) — "Corrigir fornecedor".
    const acNomesMap = (cn?.dados?.acertoNomes && typeof cn.dados.acertoNomes === 'object') ? cn.dados.acertoNomes : {}
    const bump = l => {
      if (!l?.leitura) return l
      let leitura = l.leitura, hist = l.historico
      // Saldo inicial: guarda o nome ORIGINAL (para a chave estável) e aplica o ajuste salvo.
      if (l._abertura) {
        const orig = l._origEntidade || leitura.entidade
        l = { ...l, _origEntidade: orig }
        const ov = aberAjMap[`${conta.conta}·${Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100)}·${chaveNome(orig)}`]
        if (ov) {
          leitura = { ...leitura, entidade: ov.entidade || leitura.entidade, nf: (ov.nf != null && ov.nf !== '') ? ov.nf : leitura.nf, ident: true }
          if (ov.historico) hist = ov.historico
        }
      }
      const al = leitura.entidade ? aliasMap[chaveNome(leitura.entidade)] : null
      if (al && al !== leitura.entidade) leitura = { ...leitura, entidade: al, ident: true }
      // Recalcula a confiança após ajustes (nome + NF = alta).
      if (leitura.ident && leitura.entidade && ((leitura.nf && leitura.entidade.length >= 4) || confSet.has(chaveNome(leitura.entidade))) && leitura.conf !== 'alta') leitura = { ...leitura, conf: 'alta', confiavel: !leitura.nf }
      return (leitura === l.leitura && hist === l.historico) ? l : { ...l, leitura, historico: hist }
    }
    const ajById = {}; for (const a of (aj || [])) ajById[a.razao_id] = a
    // Correções pendentes (estornos/acertos) que tocam ESTA conta entram na composição
    // como lançamentos: o estorno aparece aqui e casa por NF com a baixa original → zera
    // (aparece em "Conciliados") e a contrapartida fica demonstrada nas duas contas.
    const acertoLancs = (acs || [])
      .filter(a => String(a.conta_debito) === String(conta.conta) || String(a.conta_credito) === String(conta.conta))
      .map(a => {
        const ehDeb = String(a.conta_debito) === String(conta.conta)
        const base = aplicarAjuste({
          id: 'ac_' + a.id, data: a.data,
          contrapartida: ehDeb ? a.conta_credito : a.conta_debito,
          historico: a.historico,
          debito: ehDeb ? (Number(a.valor) || 0) : 0,
          credito: ehDeb ? 0 : (Number(a.valor) || 0),
        }, null)
        // Nome de fornecedor atribuído a este acerto ("Corrigir fornecedor") → identifica a linha.
        const nomeAc = acNomesMap[a.id]
        if (nomeAc) base.leitura = { ...base.leitura, entidade: nomeAc, ident: true, conf: 'alta' }
        return { ...base, acerto: true, origem: a.origem || null, razaoRef: a.razao_id || null }
      })
    // Títulos de abertura (saldo anterior) primeiro; depois o movimento do mês; por fim os acertos.
    setLanc([...(abertura || []).map(a => bump({ ...a, _abertura: true })), ...(rz || []).map(l => bump(aplicarAjuste(l, ajById[l.id]))), ...acertoLancs])
    setCarregando(false)
  }
  useEffect(() => { carregarLanc() }, [compId, conta.conta]) // eslint-disable-line react-hooks/exhaustive-deps

  // Esta competência é a de ABERTURA do cliente? (só nela o "Saldo anterior" vem da carga
  // inicial e pode ser excluído aqui). Guarda também se a abertura está fechada (trava).
  useEffect(() => {
    let ativo = true
    ;(async () => {
      const inicial = await ehCompetenciaInicial(empresaId, compId)
      let fechada = false
      if (inicial) { const ab = await aberturaComp(empresaId, competencia); fechada = !!ab.fechada }
      if (ativo) setAbertura({ inicial, fechada })
    })()
    return () => { ativo = false }
  }, [empresaId, compId, competencia])

  // Exclui a linha do saldo inicial (Saldo anterior) da carga inicial — para tirar um
  // duplicado sem ir à Base de Informações. Trava se a abertura estiver fechada.
  async function excluirAbertura(l) {
    if (abertura.fechada) { setMsg('A competência de abertura está FECHADA — reabra-a para excluir o saldo inicial.'); return }
    const valor = (Number(l.debito) || 0) - (Number(l.credito) || 0)
    const cliente = String(l._origEntidade ?? l.leitura?.entidade ?? '').trim()
    const dataISOalvo = (l.data && l.data !== 'abertura') ? l.data : ''
    if (!window.confirm(`Excluir esta linha do saldo inicial?\n\n${cliente || '(sem nome)'}${dataISOalvo ? ' · ' + dataISOalvo : ''} · ${money(Math.abs(valor))}\n\nA linha sai da carga inicial (você pode subir de novo em Base de Informações).`)) return
    try {
      const r = await excluirLinhaAbertura(empresaId, { conta: conta.conta, classifRaw: conta.classifRaw, valor, cliente, data: dataISOalvo }, usuario)
      if (!r.removidas) { setMsg('Não encontrei essa linha na carga inicial (pode já ter sido removida).'); return }
      setMsg('Linha do saldo inicial excluída.')
      carregarLanc(); onMudou && onMudou()
    } catch (e) { setMsg(e.message) }
  }

  // Razão inteiro da competência, indexado por partida (mesma data + histórico),
  // para descobrir a contrapartida (a(s) conta(s) do lado oposto de cada lançamento).
  useEffect(() => {
    supabase.from('razao').select('data, conta, historico, debito, credito').eq('competencia_id', compId)
      .then(({ data }) => {
        const idx = {}
        for (const r of (data || [])) { const k = `${r.data || ''}|${r.historico || ''}`; (idx[k] = idx[k] || []).push(r) }
        setPartidas(idx)
      })
  }, [compId])

  useEffect(() => {
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setPlano(parsePlano(data?.dados).map(p => ({ cod: p.reduzido, nome: p.nome, classif: p.classif, sintetica: p.sintetica })).filter(p => p.cod)))
  }, [empresaId])

  const planoMap = Object.fromEntries(plano.map(p => [p.cod, p.nome]))
  // Redutora por herança: sintética-mãe redutora (ex.: "(–) Depreciações") → a analítica
  // herda a natureza, então saldo invertido é normal e não vira alerta.
  const digCl = s => String(s ?? '').replace(/\D/g, '')
  const prefixosRedutores = plano.filter(p => p.sintetica && ehRedutora(p.nome)).map(p => digCl(p.classif)).filter(Boolean)
  const herdaRedutoraConta = c => { const cr = digCl(c.classifRaw || c.classif); return !!cr && prefixosRedutores.some(sr => cr.length > sr.length && cr.startsWith(sr)) }

  // Natureza pela classificação: Ativo (1) é devedora (clientes); Passivo (2) credora (fornecedores).
  const natCredito = String(conta.classifRaw || conta.classif || '').replace(/\D/g, '')[0] === '2'
  const lab = natCredito ? 'fornecedor' : 'cliente'
  const ov = l => natCredito ? ((Number(l.credito) || 0) - (Number(l.debito) || 0)) : ((Number(l.debito) || 0) - (Number(l.credito) || 0))

  // Contrapartida de um lançamento: usa a informada no razão (quando preenchida);
  // senão infere pela partida dobrada (contas do lado oposto na mesma data+histórico).
  function contraDe(l) {
    const imp = String(l.contrapartida ?? '').trim()
    if (imp && !/^0+([.,]0+)?$/.test(imp.replace(/\./g, ''))) return [imp]
    const part = partidas[`${l.data || ''}|${l.historico || ''}`] || []
    const ehDeb = Number(l.debito) > 0.005
    const contras = part.filter(r => (ehDeb ? Number(r.credito) > 0.005 : Number(r.debito) > 0.005) && String(r.conta) !== String(conta.conta))
    return [...new Set(contras.map(r => String(r.conta)))]
  }

  const somaComp = lanc.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
  // Nas contas de COMPOSIÇÃO a abertura entra como títulos (já no somaComp); nas de SALDO
  // (ex.: banco) não há título de abertura — então o saldo inicial não está no somaComp.
  // Completa o que falta da abertura para a amarração fechar nos dois casos.
  const aberturaSoma = lanc.reduce((s, l) => l._abertura ? s + (Number(l.debito) || 0) - (Number(l.credito) || 0) : s, 0)
  const aberturaFaltante = (Number(conta.saldo_inicial) || 0) - aberturaSoma
  // Saldo efetivo (balancete + acertos) para amarrar com a composição, que já inclui os acertos.
  const dif = (Number(conta.saldo_final) || 0) + ajNet - somaComp - aberturaFaltante

  // Resíduo da NF do lançamento (D - C de todos os lançamentos da mesma NF) — usado para
  // tratar a diferença como desconto/juros quando NF e cliente batem mas o valor não.
  function residuoNF(l) {
    const k = nfKey(l?.leitura?.nf)
    if (!k) return 0
    const mesmos = lanc.filter(x => nfKey(x.leitura?.nf) === k)
    const temD = mesmos.some(x => Number(x.debito) > 0.005), temC = mesmos.some(x => Number(x.credito) > 0.005)
    if (!temD || !temC) return 0 // só faz sentido quando a NF tem os dois lados
    return mesmos.reduce((s, x) => s + (Number(x.debito) || 0) - (Number(x.credito) || 0), 0)
  }

  // Conciliação por NF + cliente: tira do "em aberto" o que já se baixou (mesma NF, cliente bate).
  const ehEntidadeConta = ehPorEntidade(conta.nome) && tipoCta !== 'saldo'
  const { baixados, aproximadas } = ehEntidadeConta ? baixadosPorNF(lanc) : { baixados: new Set(), aproximadas: [] }

  // Correção que se ANULA com a origem: o lançamento de acerto (estorno/reclassificação)
  // aponta para a linha original que corrige (razaoRef → id). Quando os dois se anulam
  // NESTA conta, o par é conciliado AUTOMATICAMENTE — ambos saem do "em aberto" e vão para
  // os Conciliados (sem baixa manual, sem virar uma linha nova de cliente/fornecedor).
  const porIdLanc = {}; for (const l of lanc) if (l.id != null) porIdLanc[l.id] = l
  const autoConc = new Set()
  for (const l of lanc) {
    if (!l.acerto || !l.razaoRef) continue
    const orig = porIdLanc[l.razaoRef]
    if (!orig || autoConc.has(l)) continue
    const soma = ((Number(l.debito) || 0) - (Number(l.credito) || 0)) + ((Number(orig.debito) || 0) - (Number(orig.credito) || 0))
    if (Math.abs(soma) < 0.005) { autoConc.add(l); autoConc.add(orig) }
  }

  // Reconhece "cartão de crédito" pela expressão no histórico OU no nome da contrapartida —
  // para juntar esses lançamentos num grupo só (em vez de espalhados no "não identificado").
  const semAcento = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const ehCartaoCredito = l => {
    const contras = (contraDe(l) || []).map(c => planoMap[c] || '').join(' ')
    return /cartao\s+de\s+credito/.test(semAcento(`${l.historico || ''} ${contras}`))
  }
  // Agrupa só o que está EM ABERTO (não baixado) por nome; incerto cai em "(não identificado)".
  const grupos = {}, nomes = []
  for (const l of lanc) {
    if (baixados.has(l) || foiConfirmado(l) || autoConc.has(l)) continue // baixado por NF, confirmado em lote ou correção que anulou a origem → saiu
    if (Math.abs(ov(l)) < 0.005) continue
    const key = l.leitura.ident && l.leitura.entidade ? l.leitura.entidade
      : ehCartaoCredito(l) ? 'Cartão de crédito' : '(não identificado)'
    if (!grupos[key]) { grupos[key] = []; nomes.push(key) }
    grupos[key].push(l)
  }
  // Unifica nomes parecidos (mesmo cliente escrito de formas diferentes) em um cluster.
  const idents = nomes.filter(k => k !== '(não identificado)')
  const tk = Object.fromEntries(idents.map(k => [k, tokensNome(k)]))
  const clusters = []
  for (const k of idents) {
    // Nome ISOLADO (o usuário desvinculou): nunca une com outro — fica no seu próprio grupo.
    const isoladoK = nomesIsolados.has(chaveNome(k))
    const alvo = isoladoK ? null : clusters.find(cl => !cl.isolado && cl.membros.some(m => mesmoCliente(tk[k], tk[m])))
    if (alvo) alvo.membros.push(k); else clusters.push({ membros: [k], isolado: isoladoK })
  }
  const listaTodas = clusters.map(cl => {
    const membros = cl.membros.slice().sort((a, b) => b.length - a.length)
    const lancs = cl.membros.flatMap(m => grupos[m])
    return { nome: membros[0], variacoes: membros, lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: membros.length > 1, unk: false }
  })
  if (grupos['(não identificado)']) {
    const lancs = grupos['(não identificado)']
    listaTodas.push({ nome: '(não identificado)', variacoes: [], lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: false, unk: true })
  }
  listaTodas.sort((a, b) => (a.unk ? 1 : 0) - (b.unk ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'))
  // Entidade RESOLVIDA: zerou e TODAS as linhas já foram tratadas (conferido/corrigido/baixa)
  // → sai do em aberto e vai para os Conciliados (o que zerou). É o caso "bateu e está certo".
  const ehResolvida = g => !g.unk && Math.abs(g.total) < 0.005 && g.lancs.length > 0 && g.lancs.every(l => l.acerto || jaTratada(l))
  const resolvidasEnt = listaTodas.filter(ehResolvida)
  const lista = listaTodas.filter(g => !ehResolvida(g))

  // Para os relatórios: o que está em aberto (compõe o saldo) e o que zerou (baixa/confirmação/resolvida).
  const ehEntidade = ehEntidadeConta
  const emAbertoTodos = ehEntidade ? lista.flatMap(g => g.lancs) : lanc.filter(l => Math.abs(ov(l)) >= 0.005 && !autoConc.has(l))
  // Conciliados (saíram do em aberto): confirmados em lote + entidades que zeraram e foram
  // tratadas + pares de correção que se anularam com a origem. Ficam numa seção colapsável.
  const confirmadosLancs = lanc.filter(l => foiConfirmado(l) && Math.abs(ov(l)) >= 0.005)
  const autoConcLancs = lanc.filter(l => autoConc.has(l) && Math.abs(ov(l)) >= 0.005)
  const conferidosLancs = [...new Set([...confirmadosLancs, ...resolvidasEnt.flatMap(g => g.lancs).filter(l => Math.abs(ov(l)) >= 0.005), ...autoConcLancs])]
  const zerados = [...new Set([...baixados, ...conferidosLancs])] // sem repetir (uma linha pode ser baixada E confirmada)
  const conferidosPorNome = {}
  for (const l of conferidosLancs) { const k = autoConc.has(l) ? 'Correções conciliadas (estorno ↔ origem)' : (l.leitura?.entidade || '(sem nome)'); (conferidosPorNome[k] = conferidosPorNome[k] || []).push(l) }
  const conferidosGrupos = Object.entries(conferidosPorNome).map(([nome, lancs]) => ({ nome, lancs }))
  const algoEmAberto = lista.length > 0 || conferidosGrupos.length > 0

  // Leitura incerta = ainda PENDENTE (não conferida/confirmada). O que já foi tratado sai da conta.
  const leituraIncerta = l => Math.abs(ov(l)) >= 0.005 && l.leitura.conf !== 'alta' && !jaTratada(l) && !foiConfirmado(l) && !autoConc.has(l)
  const revs = lanc.filter(leituraIncerta).length

  // Anomalia de natureza: conta de cliente (Ativo) deve ficar devedora; fornecedor (Passivo) credora.
  // Um grupo com total na natureza invertida (total < 0) é estranho e precisa ser verificado.
  const natAnom = natCredito ? 'devedor' : 'credor'   // saldo que é ANÔMALO nesta conta
  const natOk = natCredito ? 'credora' : 'devedora'   // natureza esperada da conta
  const anomalos = lista.filter(x => x.total < -0.005).map(x => x.nome)
  const unificados = lista.filter(x => x.unido).length
  const contaInvertida = ((Number(conta.saldo_final) || 0) + ajNet) * (natCredito ? -1 : 1) < -0.005

  // Casamento por NF: o título nasce de um lado (cliente=débito; fornecedor=crédito) e
  // a baixa vem do outro. Para o saldo zerar, a NF da baixa tem que ser a mesma do título.
  // Uma baixa com NF que não casa com nenhum título do mesmo cliente/fornecedor é um erro.
  const ladoOrigem = natCredito ? 'credito' : 'debito'
  const ladoBaixa = natCredito ? 'debito' : 'credito'
  const baixaSemTitulo = g => {
    const nfsTitulo = new Set(g.lancs.filter(l => Number(l[ladoOrigem]) > 0.005 && l.leitura.nf).map(l => nfKey(l.leitura.nf)))
    return new Set(g.lancs.filter(l => Number(l[ladoBaixa]) > 0.005 && l.leitura.nf && !nfsTitulo.has(nfKey(l.leitura.nf))))
  }
  const totalSemTitulo = lista.reduce((n, g) => n + baixaSemTitulo(g).size, 0)
  // Linhas pendentes (não tratadas) de uma entidade e se ela pode ser confirmada em lote:
  // composição já ZERADA, nome identificado, sem erro de NF/natureza e com pendências.
  const pendentesEnt = g => g.lancs.filter(l => l.id && !l.acerto && !jaTratada(l))
  const podeConfirmarEnt = g => Math.abs(g.total) < 0.005 && g.total >= -0.005 && !g.unk && baixaSemTitulo(g).size === 0 && pendentesEnt(g).length > 0
  const confirmaveis = lista.filter(podeConfirmarEnt)
  // Filtro por situação — mesma definição de cada faixa de aviso. Só filtra a lista
  // (não confirma nada); a única situação que também baixa em lote é "confirmaveis".
  const sitPred = {
    devedor: g => g.total < -0.005,
    semtitulo: g => baixaSemTitulo(g).size > 0,
    unificados: g => g.unido,
    incerta: g => g.lancs.some(leituraIncerta),
    confirmaveis: podeConfirmarEnt,
  }
  const listaBase = (filtroSit && sitPred[filtroSit]) ? lista.filter(sitPred[filtroSit]) : lista
  // Busca por nome: mostra as entidades cujo nome (ou variação) OU algum histórico contém o texto.
  const termoBusca = baixaTxt(buscaNome).trim()
  const listaVis = termoBusca
    ? listaBase.filter(g => baixaTxt(g.nome).includes(termoBusca) || (g.variacoes || []).some(v => baixaTxt(v).includes(termoBusca)) || g.lancs.some(l => baixaTxt(l.historico).includes(termoBusca)))
    : listaBase

  async function registrar(tipo, payload) {
    const id = await getCompetenciaId()
    // Linha de ABERTURA (saldo inicial) não tem razao_id: é identificada pela chave estável
    // "AB·…" no campo item; a razão vai pelo razao_id (uuid).
    const ehAb = !!acao?._abertura
    const razaoIdLinha = ehAb ? null : (acao?.id || null)
    // Trava: um lançamento só pode ter UMA correção/estorno por vez. Se já houver,
    // bloqueia — para refazer, o usuário abre a linha (já tratada) e clica em Desfazer.
    if (payload.lancamento && acao?.id && !ehAb) {
      const { count } = await supabase.from('lancamentos').select('id', { count: 'exact', head: true })
        .eq('competencia_id', id).eq('razao_id', acao.id)
      if (count) {
        setAcao(null)
        setMsg('Este lançamento já foi corrigido/estornado. Abra a linha (marcada como "corrigido") e clique em "Desfazer" antes de refazer.')
        return
      }
    }
    const item = ehAb ? chaveAbertura(acao) : `${conta.conta} · ${acao?.data || ''} · NF ${acao?.leitura.nf || '—'}`
    await supabase.from('auditoria').insert({ competencia_id: id, modulo: 'Conciliação', item, tipo, detalhe: payload.detalhe || null, razao_id: razaoIdLinha, usuario })
    let virouLancamento = false
    if (tipo === 'Correção' && payload.lancamento && (payload.lancamento.conta_debito || payload.lancamento.conta_credito)) {
      const L = payload.lancamento
      const eSint = erroContaSintetica(plano, L.conta_debito, L.conta_credito)
      if (eSint) { setMsg(eSint); return }
      await supabase.from('lancamentos').insert({
        competencia_id: id, data: L.data || null,
        conta_debito: L.conta_debito || null, conta_credito: L.conta_credito || null,
        valor: Number(L.valor) || 0, historico: L.historico || null,
        documento: acao?.leitura.nf ? `NF ${acao.leitura.nf}` : null,
        origem: 'correcao', razao_id: razaoIdLinha, usuario,
      })
      virouLancamento = true
      // LALUR: reclassificou para uma DESPESA → registra dedutível/indedutível (aparece no
      // relatório de Despesas indedutíveis). Sem NF, o padrão sugerido é indedutível.
      if (payload.dedut?.tipo) {
        await supabase.from('auditoria').insert({
          competencia_id: id, modulo: 'Conciliação', tipo: 'Justificativa',
          item: `${payload.dedut.conta} · dedutibilidade`,
          detalhe: `${payload.dedut.tipo} — reclassificado de ${conta.conta} · ${money(payload.dedut.valor)} · ${acao?.historico || ''}`,
          dedutibilidade: payload.dedut.tipo, razao_id: razaoIdLinha, usuario,
        })
      }
      // A reclassificação também MOVIMENTA a conta de DESTINO. Se ela for de RESULTADO
      // (3/4/5), o valor recebido gera variação no mês — e essa variação já está justificada
      // (foi você quem a criou). Registra a justificativa (modulo Comparativo) na conta de
      // destino para a variação não voltar como pendência "sem justificativa" no Comparativo/Status.
      const classifDeCod = cod => (plano || []).find(p => String(p.cod) === String(cod))?.classif || ''
      const ehResultadoCod = cod => ['3', '4', '5'].includes(String(classifDeCod(cod)).replace(/\D/g, '')[0])
      const destino = [L.conta_debito, L.conta_credito].find(c => c && String(c) !== String(conta.conta) && ehResultadoCod(c))
      if (destino) {
        await supabase.from('auditoria').insert({
          competencia_id: id, modulo: 'Comparativo', tipo: 'Justificativa',
          item: `${destino} · ${competencia}`,
          detalhe: `Recebido por reclassificação de ${conta.conta} · ${money(Number(L.valor) || 0)}${L.historico ? ' · ' + L.historico : ''}`,
          razao_id: razaoIdLinha, usuario,
        })
      }
    }
    // Ajuste de leitura (nome/NF/histórico) — ajuda o sistema a cruzar; reaplicado sempre.
    // Não se aplica à abertura (a leitura dela vem da carga inicial, não do razão).
    let ajustouLeitura = false
    const aj = payload.ajuste
    if (aj && ehAb && (aj.nf || aj.entidade || aj.historico)) {
      // Saldo inicial não tem razao_id → guarda o ajuste (NF/nome/histórico) por item, com
      // chave estável (conta+valor+nome original). Vale para todos os meses.
      const key = chaveAberturaAj(acao)
      const novo = { ...(aberturaAj[key] || {}) }
      if (aj.entidade) novo.entidade = String(aj.entidade).trim()
      if (aj.nf != null && aj.nf !== '') novo.nf = String(aj.nf).trim()
      if (aj.historico) novo.historico = String(aj.historico).trim()
      const map = { ...aberturaAj, [key]: novo }
      setAberturaAj(map)
      await salvarNomes(nomesConf, nomesIsolados, nomesAlias, map)
      ajustouLeitura = true
    } else if (aj && acao?.id && !ehAb && (aj.nf || aj.entidade || aj.historico)) {
      await supabase.from('ajuste_leitura').upsert({
        competencia_id: id, razao_id: acao.id,
        nf: aj.nf || null, entidade: aj.entidade || null, historico: aj.historico || null, usuario,
      }, { onConflict: 'razao_id' })
      ajustouLeitura = true
    }
    setMsg(ajustouLeitura ? 'Leitura ajustada — o sistema vai recruzar.' : virouLancamento ? 'Correção registrada — lançamento enviado para o painel Contabilizar.' : `${tipo} registrada na auditoria.`)
    if (ehAb) setTratadosAb(prev => new Set(prev).add(chaveAbertura(acao))) // abertura: marca pela chave
    else if (acao?.id) setTratados(prev => new Set(prev).add(acao.id)) // marca a linha como tratada na hora
    setAcao(null)
    carregarTratados()
    if (virouLancamento) { onMudou && onMudou(); carregarLanc() } // atualiza saldo e mostra o acerto na composição
    else if (ajustouLeitura) carregarLanc()
  }

  // Confirma EM LOTE uma entidade (cliente/fornecedor) cuja composição já está ZERADA:
  // registra uma justificativa por linha (com usuário e data) e marca as linhas como
  // conferidas — evita abrir uma a uma quando o nome está identificado e falta só a NF.
  // Monta a linha de auditoria de um lançamento — abertura (saldo inicial) vai sem razao_id,
  // identificada pela chave estável "AB·…" no campo item; razão vai pelo razao_id (uuid).
  const linhaAuditoria = (l, id, nome) => ({
    competencia_id: id, modulo: 'Conciliação',
    item: l._abertura ? chaveAbertura(l) : `${conta.conta} · ${l.data || ''} · NF ${l.leitura.nf || '—'}`,
    tipo: 'Justificativa',
    detalhe: `Confirmado em lote — ${nome}: composição identificada e zerada no mês (título e baixa se compensam), sem NF.`,
    razao_id: l._abertura ? null : l.id, usuario,
  })
  const marcarTratadas = linhas => {
    setTratados(prev => { const s = new Set(prev); linhas.filter(l => !l._abertura).forEach(l => s.add(l.id)); return s })
    setTratadosAb(prev => { const s = new Set(prev); linhas.filter(l => l._abertura).forEach(l => s.add(chaveAbertura(l))); return s })
  }
  async function confirmarEntidade(grupo, nome) {
    const alvo = (grupo || []).filter(l => l.id && !l.acerto && !jaTratada(l))
    if (!alvo.length) return
    if (!window.confirm(`Confirmar ${alvo.length} lançamento(s) de "${nome}" como conferidos? A composição já está zerada (título e baixa se compensam) — isso marca as linhas como revisadas com justificativa, sem abrir uma a uma.`)) return
    const id = await getCompetenciaId()
    const { error } = await supabase.from('auditoria').insert(alvo.map(l => linhaAuditoria(l, id, nome)))
    if (error) { setMsg('Não consegui confirmar em lote: ' + error.message); return }
    marcarTratadas(alvo)
    setMsg(`${alvo.length} lançamento(s) de "${nome}" confirmado(s).`)
    carregarTratados()
  }

  // Confirma que o NOME do fornecedor/cliente está certo numa linha "revisar" (mesmo sem
  // zerar): tira o "revisar", marca conferido (com usuário e data). NÃO tira do em aberto
  // (o saldo pode seguir aberto) — é uma justificativa individual, não baixa em lote.
  async function confirmarNome(l) {
    if (!l?.id || l.acerto || jaTratada(l)) return
    const id = await getCompetenciaId()
    const nome = l.leitura?.entidade || ''
    const row = {
      competencia_id: id, modulo: 'Conciliação',
      item: l._abertura ? chaveAbertura(l) : `${conta.conta} · ${l.data || ''} · NF ${l.leitura?.nf || '—'}`,
      tipo: 'Justificativa', detalhe: `Nome conferido — ${nome} (${lab} correto).`,
      razao_id: l._abertura ? null : l.id, usuario,
    }
    const { error } = await supabase.from('auditoria').insert(row)
    if (error) { setMsg('Não consegui confirmar: ' + error.message); return }
    marcarTratadas([l])
    // APRENDE: o nome vira confiável do cliente — não pede revisão dele nos próximos meses.
    if (nome) await marcarConfiavel(nome)
    setMsg(`Nome conferido e aprendido — ${nome}. Não vou mais pedir revisão dele.`)
    carregarTratados(); carregarLanc()
  }

  // Conecta (baixa manual) os lançamentos SELECIONADOS — nota + pagamento que o sistema
  // não casou sozinho (NF diferente, sem NF, ou nomes separados). Vão para Conciliados.
  const toggleSelLin = l => setSelLin(prev => { const s = new Set(prev); s.has(l.id) ? s.delete(l.id) : s.add(l.id); return s })
  async function conectarSelecionados() {
    const alvo = lanc.filter(l => selLin.has(l.id) && l.id != null)
    if (alvo.length < 2) { setMsg('Selecione ao menos 2 lançamentos (a nota e o pagamento) para conectar.'); return }
    const net = alvo.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
    // Se NÃO zera, é obrigatório apontar se a diferença é DESCONTO ou JUROS/MULTA (com a
    // conta) — abre o passo dedicado. Só zerando conecta direto.
    if (Math.abs(net) >= 0.005) { setConectarDif({ alvo, net }); return }
    if (!window.confirm(`Conectar ${alvo.length} lançamento(s)? Eles zeram entre si e vão para Conciliados.`)) return
    await baixarConexao(alvo)
  }
  // Ao CONECTAR lançamentos com nomes lidos diferentes (ex.: o título lido como "ELETROLAR"
  // e o pagamento como "LIKE DISTRIBUICAO E LOGISTICA"), UNIFICA o fornecedor: adota o nome
  // mais COMPLETO como o "fornecedor final" e APRENDE que os outros são o mesmo (apelido) —
  // vale para os próximos meses e agrupa sozinho. Assim a plataforma vai aprendendo.
  async function unificarNomesConectados(alvo) {
    const nomes = [...new Set((alvo || []).filter(l => l.leitura?.ident && String(l.leitura.entidade || '').trim()).map(l => l.leitura.entidade.trim()))]
    if (nomes.length < 2) return null
    const canonical = nomes.slice().sort((a, b) => b.length - a.length)[0] // o mais completo
    const aliases = { ...nomesAlias }
    let mudou = false
    for (const n of nomes) { const k = chaveNome(n); if (k && k !== chaveNome(canonical)) { aliases[k] = canonical; mudou = true } }
    if (!mudou) return null
    setNomesAlias(aliases)
    await salvarNomes(nomesConf, nomesIsolados, aliases)
    return canonical
  }
  // Marca as linhas da conexão como confirmadas (saem para Conciliados). `extraRazaoId` é o
  // lançamento de acerto da diferença (desconto/juros), que também deve sair do em aberto.
  async function baixarConexao(alvo, extraRazaoId) {
    const id = await getCompetenciaId()
    const rows = alvo.map(l => ({
      competencia_id: id, modulo: 'Conciliação',
      item: l._abertura ? chaveAbertura(l) : `${conta.conta} · ${l.data || ''} · NF ${l.leitura?.nf || '—'}`,
      tipo: 'Justificativa',
      detalhe: `Confirmado em lote — conexão manual (nota + pagamento).`,
      // Acerto (estorno/lançamento) é identificado pelo uuid do próprio lançamento (sem "ac_").
      razao_id: l._abertura ? null : (l.acerto ? String(l.id).replace(/^ac_/, '') : l.id), usuario,
    }))
    if (extraRazaoId) rows.push({ competencia_id: id, modulo: 'Conciliação', item: `${conta.conta} · acerto`, tipo: 'Justificativa', detalhe: 'Confirmado em lote — conexão manual (diferença).', razao_id: extraRazaoId, usuario })
    const { error } = await supabase.from('auditoria').insert(rows)
    if (error) { setMsg('Não consegui conectar: ' + error.message); return false }
    marcarTratadas(alvo)
    // Unifica e APRENDE o fornecedor final (nomes lidos diferentes → um só, nos próximos meses).
    const canonical = await unificarNomesConectados(alvo)
    setSelLin(new Set()); setConectarDif(null)
    carregarTratados(); carregarLanc(); onMudou && onMudou()
    if (!extraRazaoId) setMsg(`${alvo.length} lançamento(s) conectado(s) — foram para Conciliados.${canonical ? ` Fornecedor unificado como "${canonical}" e aprendido para os próximos meses.` : ''}`)
    return true
  }
  // Aplica a diferença como desconto/juros: gera o lançamento de acerto que ZERA a conta e
  // conecta tudo (par + acerto) para Conciliados.
  async function aplicarConexaoDif(alvo, net, kind, contaDif) {
    if (!contaDif) { setMsg('Escolha a conta do desconto/juros.'); return }
    const eSint = erroContaSintetica(plano, net > 0 ? contaDif : conta.conta, net > 0 ? conta.conta : contaDif)
    if (eSint) { setMsg(eSint); return }
    const dif = Math.abs(net)
    const id = await getCompetenciaId()
    // net>0 (débito residual na conta) → credita a conta p/ zerar; net<0 → debita a conta.
    const { data: lan, error: e1 } = await supabase.from('lancamentos').insert({
      competencia_id: id, data: null,
      conta_debito: net > 0 ? contaDif : conta.conta,
      conta_credito: net > 0 ? conta.conta : contaDif,
      valor: dif, historico: `${kind === 'juros' ? 'Juros/multa' : 'Desconto financeiro'} — conexão manual · ${conta.nome}`,
      origem: 'correcao', razao_id: null, usuario,
    }).select('id').single()
    if (e1) { setMsg('Não consegui gerar o acerto: ' + e1.message); return }
    await baixarConexao(alvo, lan.id)
    setMsg(`Conectado com ${kind === 'juros' ? 'juros/multa' : 'desconto'} de ${money(dif)} — foi para Conciliados e o acerto para o Contabilizar.`)
  }

  // Cria um lançamento novo DENTRO desta conta (ex.: uma tarifa/ajuste que faltou no razão).
  // Uma das pernas já vem preenchida com a conta atual. Entra em Lançamentos (Status → Domínio),
  // aparece na composição como acerto e atualiza o saldo. Fica na tela para lançar outro.
  async function criarLancamento(form) {
    const deb = String(form.conta_debito || '').trim(), cred = String(form.conta_credito || '').trim()
    if (!deb || !cred) { setMsg('Informe a conta de débito e a de crédito.'); return }
    if (deb === cred) { setMsg('Débito e crédito precisam ser contas diferentes.'); return }
    const val = Number(form.valor) || 0
    if (!(val > 0)) { setMsg('Informe um valor maior que zero.'); return }
    const eSint = erroContaSintetica(plano, deb, cred)
    if (eSint) { setMsg(eSint); return }
    const id = await getCompetenciaId()
    if (!id) { setMsg('Abra um fechamento para esta competência.'); return }
    const { error } = await supabase.from('lancamentos').insert({
      competencia_id: id, data: form.data || null, conta_debito: deb, conta_credito: cred,
      valor: val, historico: form.historico || null, origem: 'manual', razao_id: null, usuario,
    })
    if (error) { setMsg('Não consegui gerar o lançamento: ' + error.message); return }
    setNovoLanc(false)
    setMsg(`Lançamento de ${money(val)} gerado nesta conta — entrou no Contabilizar e atualizou o saldo.`)
    carregarLanc()
  }

  // Desvincula EM LOTE os nomes dos lançamentos selecionados (não unir com parecidos) —
  // vale para todos os meses. Útil quando o sistema juntou vários nomes distintos por engano.
  async function desvincularLote(lines) {
    const nomes = [...new Set((lines || []).filter(l => !l.acerto && (l.leitura?.entidade || '').trim()).map(l => l.leitura.entidade.trim()))]
    if (!nomes.length) { setMsg('Marque linhas com nome identificado para desvincular.'); return }
    const iso = new Set(nomesIsolados)
    for (const n of nomes) { const k = chaveNome(n); if (k) iso.add(k) }
    setNomesIsolados(iso)
    await salvarNomes(nomesConf, iso)
    setSelLin(new Set())
    setMsg(`${nomes.length} ${lab}(s) desvinculado(s) — não vou mais unir com nomes parecidos.`)
    carregarLanc()
  }

  // Corrige o FORNECEDOR/CLIENTE de vários lançamentos de uma vez (ajuste de leitura em
  // lote): útil quando o sistema leu o nome errado em várias linhas do mesmo fornecedor.
  async function aplicarFornecedorLote(lines, nome, aprender) {
    const nm = String(nome || '').trim()
    if (!nm) { setLoteForn(null); return }
    const razaoLinhas = (lines || []).filter(l => !l.acerto) // razão + saldo anterior
    const acertoLinhas = (lines || []).filter(l => l.acerto)  // lançamentos gerados (sem nome de origem)
    // Renomeia por APELIDO: cada nome atual dos selecionados vira o nome correto — vale para
    // saldo inicial E razão, e em todos os meses. Precisão por linha (razão) via ajuste_leitura.
    const aliases = { ...nomesAlias }
    for (const l of razaoLinhas) { const k = chaveNome(l.leitura?.entidade || ''); if (k && k !== chaveNome(nm)) aliases[k] = nm }
    // Acerto (lançamento gerado): não tem nome de origem para apelido → guarda o nome por
    // uuid do lançamento (aplicado ao recarregar). Assim a linha "não identificada" passa a
    // aparecer com o fornecedor.
    const acMap = { ...acertoNomes }
    for (const l of acertoLinhas) { const rid = String(l.id).replace(/^ac_/, ''); if (rid) acMap[rid] = nm }
    const conf = new Set(nomesConf); if (aprender) conf.add(chaveNome(nm))
    await salvarNomes(conf, nomesIsolados, aliases, aberturaAj, acMap)
    // Razão: também grava ajuste_leitura (força o nome na linha, mesmo "não identificada").
    const razaoIds = razaoLinhas.filter(l => !l._abertura && l.id).map(l => l.id)
    if (razaoIds.length) {
      const id = await getCompetenciaId()
      await supabase.from('ajuste_leitura').upsert(razaoIds.map(rid => ({ competencia_id: id, razao_id: rid, entidade: nm, usuario })), { onConflict: 'razao_id' })
    }
    setNomesConf(conf); setNomesAlias(aliases); setAcertoNomes(acMap); setSelLin(new Set()); setLoteForn(null)
    setMsg(`Nome "${nm}" aplicado a ${lines.length} lançamento(s)${aprender ? ' e aprendido' : ''}.`)
    carregarLanc()
  }

  // Confirma DE UMA VEZ todas as entidades zeradas/identificadas (uma pergunta só).
  async function confirmarTodos(grupos) {
    const items = []
    for (const g of (grupos || [])) for (const l of g.lancs) { if (l.id && !l.acerto && !jaTratada(l)) items.push({ nome: g.nome, l }) }
    if (!items.length) return
    if (!window.confirm(`Confirmar ${items.length} lançamento(s) de ${grupos.length} ${lab}(s) que já zeraram e estão identificados (sem NF)? Marca todas as linhas como conferidas, com justificativa (usuário e data). Você pode desfazer linha a linha depois.`)) return
    const id = await getCompetenciaId()
    const rows = items.map(({ nome, l }) => linhaAuditoria(l, id, nome))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('auditoria').insert(rows.slice(i, i + 500))
      if (error) { setMsg('Não consegui confirmar em lote: ' + error.message); return }
    }
    marcarTratadas(items.map(x => x.l))
    setSelEnt(prev => { const s = new Set(prev); grupos.forEach(g => s.delete(g.nome)); return s })
    setFiltroSit('')
    setMsg(`${items.length} lançamento(s) de ${grupos.length} ${lab}(s) confirmado(s).`)
    carregarTratados()
  }

  // Reabre lançamentos CONFIRMADOS em lote: apaga só o registro de confirmação (mantém
  // qualquer justificativa individual) e devolve as linhas para "em aberto".
  async function reabrirConferidos(lancs) {
    if (!lancs?.length) return
    if (!window.confirm(`Reabrir ${lancs.length} lançamento(s)? Eles voltam para "em aberto" para você revisar/corrigir de novo.`)) return
    for (const l of lancs) {
      // Par de correção auto-conciliado (estorno ↔ origem): reabrir = DESFAZER a correção —
      // remove o lançamento de acerto, a auditoria e o ajuste de leitura (pela origem).
      if (autoConc.has(l)) {
        const rid = l.acerto ? (l.razaoRef || String(l.id).replace(/^ac_/, '')) : l.id
        await supabase.from('lancamentos').delete().eq('competencia_id', compId).eq('razao_id', rid)
        await supabase.from('auditoria').delete().eq('competencia_id', compId).eq('modulo', 'Conciliação').eq('razao_id', rid)
        await supabase.from('ajuste_leitura').delete().eq('competencia_id', compId).eq('razao_id', rid)
        continue
      }
      // Remove o registro que fez a linha sair (confirmação em lote OU conferência individual).
      let q = supabase.from('auditoria').delete().eq('competencia_id', compId).eq('modulo', 'Conciliação')
      q = l._abertura ? q.eq('item', chaveAbertura(l)) : (l.acerto ? q.eq('razao_id', String(l.id).replace(/^ac_/, '')) : q.eq('razao_id', l.id))
      await q
    }
    setMsg(`${lancs.length} lançamento(s) reaberto(s) — voltaram para o em aberto.`)
    carregarTratados(); carregarLanc(); onMudou && onMudou()
  }

  // Desfazer uma correção/estorno: remove o lançamento de acerto e o registro de
  // auditoria daquela linha; a linha volta a ficar pendente e o saldo se reverte.
  async function desfazerCorrecao(alvo) {
    const linha = (alvo && typeof alvo === 'object') ? alvo : null
    // Linha de ABERTURA: a conferência está na auditoria pela chave "AB·…" (sem razao_id).
    if (linha && linha._abertura) {
      const chave = chaveAbertura(linha)
      await supabase.from('auditoria').delete().eq('competencia_id', compId).eq('modulo', 'Conciliação').eq('item', chave)
      setTratadosAb(prev => { const s = new Set(prev); s.delete(chave); return s })
      setVerCorr(null); setMsg('Conferência desfeita — a linha voltou a ficar pendente.')
      carregarTratados(); carregarLanc(); return
    }
    const razaoId = linha ? linha.id : alvo
    await supabase.from('lancamentos').delete().eq('competencia_id', compId).eq('razao_id', razaoId)
    await supabase.from('auditoria').delete().eq('competencia_id', compId).eq('modulo', 'Conciliação').eq('razao_id', razaoId)
    await supabase.from('ajuste_leitura').delete().eq('competencia_id', compId).eq('razao_id', razaoId)
    setTratados(prev => { const s = new Set(prev); s.delete(razaoId); return s })
    setVerCorr(null)
    setMsg('Correção desfeita — a linha voltou a ficar pendente.')
    carregarLanc()
    onMudou && onMudou()
  }

  // Clique numa linha: acerto → ver/desfazer (pelo lançamento de origem); linha já
  // tratada → ver/desfazer; senão → tela de justificar/corrigir.
  function abrirLinha(l) {
    setMsg('')
    if (l.acerto) { if (l.razaoRef) setVerCorr({ ...l, id: l.razaoRef }); return }
    jaTratada(l) ? setVerCorr(l) : setAcao(l)
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span onClick={onVoltar} style={{ color: '#8FB0FF', fontSize: 13, cursor: 'pointer' }}><i className="ti ti-chevron-left" /> Conciliação</span>
          <span style={{ color: theme.sub }}>/</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{conta.conta} · {conta.nome}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-click" /> Clique num lançamento para justificar ou corrigir.</span>
          <button className="btn" style={{ fontSize: 12.5, padding: '6px 12px' }} onClick={() => setNovoLanc(true)}
            title="Incluir um lançamento novo nesta conta (ex.: tarifa/ajuste que faltou no razão)">
            <i className="ti ti-file-plus" /> Novo lançamento
          </button>
        </div>
      </div>

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 12 }}><i className="ti ti-circle-check" /> {msg}</p>}

      {/* Resumo + amarração — débito/crédito/saldo já incluem as correções pendentes. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: Math.abs(ajNet) > 0.005 ? 6 : 16 }}>
        <Tile label="Saldo inicial" v={moneyDC(conta.saldo_inicial)} hint="Ver a composição de abertura (arrastada do mês anterior)"
          onClick={() => setVerComposic({ titulo: `Composição do saldo inicial · ${conta.conta} ${conta.nome}`, itens: lanc.filter(l => l._abertura) })} />
        <Tile label="Débito" v={money((Number(conta.debito) || 0) + ajDeb)} cor={theme.green} />
        <Tile label="Crédito" v={money((Number(conta.credito) || 0) + ajCred)} cor={theme.red} />
        <Tile label="Saldo atual" v={moneyDC((Number(conta.saldo_final) || 0) + ajNet)} hint="Ver a composição do saldo final (o que segue em aberto — arrasta para o próximo mês)"
          onClick={() => setVerComposic({ titulo: `Composição do saldo final · ${conta.conta} ${conta.nome}`, itens: emAbertoTodos })} />
        <Tile label="Diferença (amarração)" v={money(dif)} cor={Math.abs(dif) < 0.01 ? theme.green : theme.yellow} />
      </div>
      {Math.abs(ajNet) > 0.005 && <p style={{ color: theme.accent, fontSize: 11.5, margin: '0 0 16px' }}>
        <i className="ti ti-adjustments-alt" /> Débito, crédito e saldo já incluem {moneyDC(ajNet)} de correções pendentes de contabilização (balancete: débito {money(conta.debito)} · crédito {money(conta.credito)} · saldo {moneyDC(conta.saldo_final)}).
      </p>}

      {/* Natureza do saldo: Ativo credor / Passivo devedor (sem ser redutora) */}
      {(() => {
        const inv = saldoInvertido(conta.classifRaw, conta.nome, (Number(conta.saldo_final) || 0) + ajNet, herdaRedutoraConta(conta))
        if (!inv) return null
        const classe = inv === 'credor' ? 'Ativo' : 'Passivo'
        return (
          <div style={{ background: 'rgba(229,72,77,0.10)', border: `1px solid ${theme.red}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 14 }}>
            <i className="ti ti-alert-octagon" style={{ color: theme.red, fontSize: 18, marginTop: 1 }} />
            <span style={{ color: theme.text, fontSize: 13 }}>Esta conta do <b>{classe}</b> está com <b>saldo {inv}</b> e não é redutora — confira os lançamentos abaixo e corrija o que estiver invertido.</span>
          </div>
        )
      })()}

      {/* Conferência (documento → verde; confirmar + justificar → amarelo) */}
      <CardConferencia conta={conta} reg={reg} compId={compId} usuario={usuario} saldoAjuste={ajNet} composicao={tipoCta !== 'saldo'} onSalvo={onSalvarConf} />

      {tipoCta !== 'saldo' && (
        <RelatoriosComposicao conta={conta} emAberto={emAbertoTodos} zerados={zerados} contraDe={contraDe} />
      )}

      {/* Impostos: baixa do mês anterior + memória de cálculo */}
      {tipoConta(conta.nome) === 'Imposto' && <ImpostoCards conta={conta} />}

      {(ehPorEntidade(conta.nome) && tipoCta !== 'saldo') ? (
      <>
      {/* Composição agrupada por cliente/fornecedor */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: 0 }}>
          O que compõe o saldo — por {lab}
        </p>
        <div style={{ position: 'relative', minWidth: 240 }}>
          <i className="ti ti-search" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: theme.sub, fontSize: 14 }} />
          <input className="input" value={buscaNome} onChange={e => setBuscaNome(e.target.value)}
            placeholder={`Buscar ${lab} por nome…`} style={{ fontSize: 12.5, padding: '6px 28px 6px 30px', width: '100%' }} />
          {buscaNome && <i className="ti ti-x" onClick={() => setBuscaNome('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: theme.sub, cursor: 'pointer', fontSize: 14 }} />}
        </div>
      </div>
      {termoBusca && <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 10px' }}><i className="ti ti-filter" style={{ color: theme.accent }} /> {listaVis.length} {lab}(s) com “{buscaNome}”. <span onClick={() => setBuscaNome('')} style={{ color: theme.accent, cursor: 'pointer' }}>limpar</span></p>}

      {/* Avisos da composição em CHIPS compactos (uma linha), agrupados por prioridade.
          Clicar num chip mostra o detalhe e filtra a lista (aproximada é só informativa). */}
      {(() => {
        const avisos = [
          anomalos.length > 0 && { key: 'devedor', sev: 'red', grupo: 'acao', n: anomalos.length, rot: `Saldo ${natAnom}`, filtra: true,
            full: <>{anomalos.length} {lab}(s) com saldo <b>{natAnom}</b> (natureza invertida) — verifique{anomalos.length <= 4 ? `: ${anomalos.join(', ')}` : ''}.</> },
          totalSemTitulo > 0 && { key: 'semtitulo', sev: 'red', grupo: 'acao', n: totalSemTitulo, rot: 'NF não confere', filtra: true,
            full: <>{totalSemTitulo} baixa(s) com NF que não confere com nenhum título deste {lab} — para o saldo zerar, a NF do recebimento tem que ser a mesma do faturamento.</> },
          revs > 0 && { key: 'incerta', sev: 'yellow', grupo: 'acao', n: revs, rot: 'Leitura incerta', filtra: true,
            full: <>{revs} lançamento(s) com leitura incerta — corrija o {lab} para o sistema aprender.</> },
          aproximadas.length > 0 && { key: 'aproximadas', sev: 'blue', grupo: 'conferir', n: aproximadas.length, rot: 'NF aproximada', filtra: false,
            full: <>{aproximadas.length} baixa(s) conciliada(s) por <b>NF aproximada</b> (mesmo número ignorando zeros à esquerda) — confirme: {aproximadas.slice(0, 4).join('; ')}. Veja no relatório “Conciliados”.</> },
          unificados > 0 && { key: 'unificados', sev: 'blue', grupo: 'conferir', n: unificados, rot: 'Nomes unificados', filtra: true,
            full: <>{unificados} {lab}(s) com nomes parecidos foram <b>unificados</b> — confira se é mesmo o mesmo {lab} (veja “nomes unidos” em cada card).</> },
        ].filter(Boolean)
        if (!avisos.length) return null
        const cor = { red: theme.red, yellow: theme.yellow, blue: theme.accent }
        const bgA = { red: 'rgba(229,72,77,0.13)', yellow: 'rgba(245,166,35,0.14)', blue: 'rgba(74,124,255,0.14)' }
        const grupos = [{ g: 'acao', label: 'Precisa de ação' }, { g: 'conferir', label: 'Conferir' }]
        const ativoAviso = avisos.find(a => a.key === filtroSit)
        const chip = a => {
          const on = filtroSit === a.key
          return (
            <button key={a.key} onClick={() => setFiltroSit(f => f === a.key ? '' : a.key)}
              title={on ? 'Clique para limpar' : 'Ver detalhe e filtrar'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px 6px 10px', borderRadius: 22, border: `1px solid ${on ? cor[a.sev] : theme.cb}`, background: on ? bgA[a.sev] : theme.input, color: theme.text, cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap', boxShadow: on ? `0 0 0 1px ${cor[a.sev]} inset` : 'none' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: cor[a.sev], flexShrink: 0 }} />
              <b style={{ color: cor[a.sev], fontVariantNumeric: 'tabular-nums' }}>{a.n}</b> {a.rot}
            </button>
          )
        }
        return (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {grupos.map((grp, gi) => {
                const items = avisos.filter(a => a.grupo === grp.g)
                if (!items.length) return null
                return (
                  <div key={grp.g} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    {gi > 0 && <div style={{ width: 1, alignSelf: 'stretch', background: theme.border, marginTop: 4 }} />}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .6, textTransform: 'uppercase', color: theme.sub, paddingLeft: 2 }}>{grp.label}</span>
                      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{items.map(chip)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
            {ativoAviso && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, padding: '10px 13px', background: theme.input, borderRadius: 10, borderLeft: `3px solid ${cor[ativoAviso.sev]}` }}>
                <i className="ti ti-info-circle" style={{ color: cor[ativoAviso.sev], fontSize: 16, marginTop: 1, flexShrink: 0 }} />
                <span style={{ color: theme.text, fontSize: 12.5, flex: 1 }}>
                  {ativoAviso.full}
                  {ativoAviso.filtra && <span style={{ color: theme.sub }}> · mostrando <b>{listaVis.length}</b> de {lista.length} {lab}(s).</span>}
                </span>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '3px 10px', flexShrink: 0 }} onClick={() => setFiltroSit('')}><i className="ti ti-x" /> limpar</button>
              </div>
            )}
          </div>
        )
      })()}

      {carregando ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : lanc.length === 0 ? (
        <Aviso icon="ti-inbox" texto="Sem lançamentos nesta conta." />
      ) : !algoEmAberto ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <i className="ti ti-circle-check" style={{ fontSize: 22, color: theme.green }} />
          <p style={{ fontSize: 13.5, color: theme.text, margin: 0 }}>Nada em aberto — débitos e créditos se conciliaram por NF (saldo zerado). Anexe o relatório de {natCredito ? 'contas a pagar' : 'contas a receber'} ou justifique no card acima.</p>
        </div>
      ) : (<>
      {confirmaveis.length > 0 && (() => {
        const selConf = confirmaveis.filter(g => selEnt.has(g.nome))
        const todosSel = selConf.length === confirmaveis.length && confirmaveis.length > 0
        return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, background: 'rgba(48,164,108,0.10)', border: `1px solid ${theme.green}`, borderRadius: 12 }}>
          <i className="ti ti-checks" style={{ color: theme.green, fontSize: 18 }} />
          <span style={{ color: theme.text, fontSize: 13, flex: 1, minWidth: 200 }}><b>{confirmaveis.length}</b> {lab}(s) identificado(s) e <b>zerado(s) sem NF</b> — marque quais quer baixar em lote.</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.sub, cursor: 'pointer' }}>
            <input type="checkbox" checked={todosSel} ref={el => { if (el) el.indeterminate = selConf.length > 0 && !todosSel }}
              onChange={e => setSelEnt(e.target.checked ? new Set(confirmaveis.map(g => g.nome)) : new Set())} /> Selecionar todos
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.sub, cursor: 'pointer' }}>
            <input type="checkbox" checked={filtroSit === 'confirmaveis'} onChange={e => setFiltroSit(e.target.checked ? 'confirmaveis' : '')} /> Mostrar só esses
          </label>
          <button className="btn" disabled={!selConf.length} style={{ fontSize: 12.5, background: selConf.length ? theme.green : undefined, borderColor: selConf.length ? theme.green : undefined, opacity: selConf.length ? 1 : 0.5 }}
            onClick={() => confirmarTodos(selConf)}>
            <i className="ti ti-checks" /> Confirmar selecionados ({selConf.length})
          </button>
        </div>
        )
      })()}
      {filtroSit === 'confirmaveis' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', marginBottom: 12, background: theme.input, borderRadius: 10, fontSize: 12.5, color: theme.sub }}>
          <i className="ti ti-filter" style={{ color: theme.accent }} />
          <span>Filtrando por <b style={{ color: theme.text }}>identificado e zerado sem NF</b> · mostrando <b style={{ color: theme.text }}>{listaVis.length}</b> de {lista.length} {lab}(s).</span>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '3px 10px', marginLeft: 'auto' }} onClick={() => setFiltroSit('')}><i className="ti ti-x" /> Limpar filtro</button>
        </div>
      )}
      {listaVis.map((g, gi) => {
        const grp = g.lancs
        const gt = g.total
        const unk = g.unk
        const semTit = baixaSemTitulo(g) // baixas com NF que não casa com título
        const hasRev = grp.some(l => l.leitura.conf !== 'alta' && !jaTratada(l))
        const anom = gt < -0.005 // natureza invertida (cliente credor / fornecedor devedor)
        const borda = (anom || semTit.size > 0) ? theme.red : hasRev ? theme.yellow : theme.cb
        // Confirmar em lote: só quando a composição já ZEROU, o nome está identificado e não
        // há erro de NF/natureza — e ainda restam linhas pendentes (não tratadas).
        const podeConfirmar = podeConfirmarEnt(g)
        return (
          <div key={gi} style={{ background: theme.card, border: `1px solid ${borda}`, borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', background: theme.input, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {podeConfirmar && (
                  <input type="checkbox" title="Marcar para baixar em lote" checked={selEnt.has(g.nome)}
                    onClick={e => e.stopPropagation()}
                    onChange={e => setSelEnt(prev => { const s = new Set(prev); e.target.checked ? s.add(g.nome) : s.delete(g.nome); return s })}
                    style={{ cursor: 'pointer', width: 16, height: 16 }} />
                )}
                <span style={{ color: unk ? theme.yellow : theme.text, fontSize: 14, fontWeight: 600, fontStyle: unk ? 'italic' : 'normal' }}>{g.nome}</span>
                {g.unido && <span title={`Nomes unidos: ${g.variacoes.join(' · ')}`} style={{ background: 'rgba(74,124,255,0.18)', color: theme.accent, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3, cursor: 'help' }}><i className="ti ti-arrows-join" /> {g.variacoes.length} nomes unidos</span>}
                {anom && <span style={{ background: 'rgba(229,72,77,0.18)', color: theme.red, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3 }}><i className="ti ti-alert-octagon" /> saldo {natAnom}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {podeConfirmar && (
                  <button className="btn" style={{ fontSize: 12, padding: '5px 11px', background: theme.green, borderColor: theme.green }}
                    title="A composição já zerou — confirma todas as linhas de uma vez (justificativa de compensação sem NF), sem abrir uma a uma."
                    onClick={e => { e.stopPropagation(); confirmarEntidade(grp, g.nome) }}>
                    <i className="ti ti-checks" /> Confirmar ({pendentesEnt(g).length})
                  </button>
                )}
                <span style={{ color: anom ? theme.red : theme.text, fontSize: 14, fontWeight: 600 }}>{money(gt)}</span>
              </span>
            </div>
            {g.unido && (
              <div style={{ padding: '8px 16px', borderTop: `1px solid ${theme.border}`, background: 'rgba(74,124,255,0.05)', fontSize: 11.5, color: theme.sub }}>
                <i className="ti ti-arrows-join" style={{ color: theme.accent, marginRight: 6 }} />
                Unificado de: {g.variacoes.join(' · ')}
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ borderTop: `1px solid ${theme.border}` }}>
                  <th style={{ ...th, width: 26 }} title="Marcar para conectar (baixa manual)"></th>
                  <th style={th}>Data</th><th style={th}>NF</th><th style={th}>Histórico</th><th style={th}>Contrapartida</th>
                  <th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={{ ...th, textAlign: 'center' }}>Conf.</th>
                </tr>
              </thead>
              <tbody>
                {grp.map((l, i) => {
                  const rev = l.leitura.conf !== 'alta'
                  const semNF = semTit.has(l)
                  const contras = contraDe(l)
                  return (
                    <tr key={i} onClick={() => abrirLinha(l)}
                      style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', opacity: (l.acerto || jaTratada(l)) ? 0.7 : 1, background: (l.acerto || jaTratada(l)) ? 'rgba(48,164,108,0.08)' : semNF ? 'rgba(229,72,77,0.08)' : 'transparent' }}
                      title={l.acerto ? `${tagAcertoLanc(l).titulo} — clique para ver ou desfazer` : jaTratada(l) ? 'Já conferido — clique para ver ou desfazer' : semNF ? 'Baixa com NF que não confere com o título — justifique ou corrija' : 'Justificar ou corrigir este lançamento'}>
                      <td style={{ ...td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" title="Conectar com outro (baixa manual)" checked={selLin.has(l.id)} onChange={() => toggleSelLin(l)} style={{ cursor: 'pointer', width: 15, height: 15 }} />
                      </td>
                      <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{l.data || '—'}</td>
                      <td style={{ ...td, color: semNF ? theme.red : theme.sub, fontWeight: 600 }}>NF {l.leitura.nf || '—'}</td>
                      <td style={{ ...td, color: theme.sub, fontFamily: 'monospace', fontSize: 11, maxWidth: 280 }}>{l.historico}</td>
                      <td style={{ ...td, fontSize: 11.5, whiteSpace: 'nowrap' }} title={contras.map(c => `${c}${planoMap[c] ? ' · ' + planoMap[c] : ''}`).join('\n')}>
                        {contras.length === 0 ? <span style={{ color: theme.sub }}>—</span>
                          : contras.length === 1 ? <span><b>{contras[0]}</b>{planoMap[contras[0]] && <span style={{ color: theme.sub }}> · {planoMap[contras[0]]}</span>}</span>
                          : <span><b>{contras[0]}</b><span style={{ color: theme.sub }}> +{contras.length - 1}</span></span>}
                      </td>
                      <td style={{ ...tdR, color: theme.green }}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                      <td style={{ ...tdR, color: theme.red }}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        {l.acerto
                          ? <span title={tagAcertoLanc(l).titulo} style={{ color: theme.accent, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className={`ti ${tagAcertoLanc(l).icon}`} /> {tagAcertoLanc(l).txt}</span>
                          : jaTratada(l)
                            ? <span title="Já conferido" style={{ color: theme.green, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-circle-check" /> {l._abertura ? 'conferido' : 'corrigido'}</span>
                            : semNF
                              ? <span title="NF não confere com nenhum título" style={{ color: theme.red, fontSize: 10.5, fontWeight: 700 }}>NF s/ título</span>
                              : rev
                                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                                    <span style={{ color: theme.yellow, fontSize: 11, fontWeight: 600 }}>revisar</span>
                                    {l.leitura.ident && l.leitura.entidade && (
                                      <button title="O nome está certo — confirmar (tira o 'revisar' e registra a conferência)" onClick={e => { e.stopPropagation(); confirmarNome(l) }}
                                        style={{ background: 'none', border: `1px solid ${theme.green}`, color: theme.green, borderRadius: 12, fontSize: 10, fontWeight: 700, padding: '1px 7px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                        <i className="ti ti-check" /> está certo
                                      </button>
                                    )}
                                  </span>
                                : <span style={{ color: theme.green, fontSize: 14 }}><i className="ti ti-circle-check" /></span>}
                        {l._abertura && abertura.inicial && (
                          <button title={abertura.fechada ? 'Abertura fechada — reabra para excluir' : 'Excluir esta linha do saldo inicial'}
                            disabled={abertura.fechada} onClick={e => { e.stopPropagation(); excluirAbertura(l) }}
                            style={{ marginLeft: 8, background: 'none', border: 'none', color: abertura.fechada ? theme.sub : theme.red, cursor: abertura.fechada ? 'not-allowed' : 'pointer', fontSize: 14, verticalAlign: 'middle' }}>
                            <i className="ti ti-trash" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>
        )
      })}
      {conferidosGrupos.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button onClick={() => setVerConferidos(v => !v)} style={{ background: 'none', border: 'none', color: theme.sub, cursor: 'pointer', fontSize: 12.5, padding: '6px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className={`ti ${verConferidos ? 'ti-chevron-down' : 'ti-chevron-right'}`} /> <i className="ti ti-circle-check" style={{ color: theme.green }} /> Conferidos neste mês ({conferidosLancs.length}) — {verConferidos ? 'clique para ocultar' : 'clique para ver e reabrir'}
          </button>
          {verConferidos && conferidosGrupos.map((g, gi) => (
            <div key={gi} style={{ background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden', marginBottom: 10, opacity: 0.9 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: theme.input, gap: 8 }}>
                <span style={{ color: theme.text, fontSize: 13, fontWeight: 600 }}><i className="ti ti-circle-check" style={{ color: theme.green, marginRight: 6 }} />{g.nome}</span>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: theme.yellow, borderColor: theme.yellow }} onClick={() => reabrirConferidos(g.lancs)}><i className="ti ti-rotate-2" /> Reabrir ({g.lancs.length})</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                  <tbody>
                    {g.lancs.map((l, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, fontSize: 12 }}>
                        <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{l.data || '—'}</td>
                        <td style={{ ...td, color: theme.sub }}>NF {l.leitura?.nf || '—'}</td>
                        <td style={{ ...td, color: theme.sub, fontFamily: 'monospace', fontSize: 11, maxWidth: 320 }}>{l.historico}</td>
                        <td style={{ ...tdR, color: theme.green }}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                        <td style={{ ...tdR, color: theme.red }}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
      </>
      ) : (
        <>
        <ListaLancamentos lanc={emAbertoTodos} carregando={carregando} contraDe={contraDe} planoMap={planoMap} tratados={tratados} onTratar={abrirLinha}
          selLin={selLin} onToggleSel={toggleSelLin} onExcluirAbertura={excluirAbertura} podeExcluirAbertura={abertura.inicial} aberturaFechada={abertura.fechada} />
        {conferidosGrupos.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button onClick={() => setVerConferidos(v => !v)} style={{ background: 'none', border: 'none', color: theme.sub, cursor: 'pointer', fontSize: 12.5, padding: '6px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className={`ti ${verConferidos ? 'ti-chevron-down' : 'ti-chevron-right'}`} /> <i className="ti ti-circle-check" style={{ color: theme.green }} /> Conferidos neste mês ({conferidosLancs.length}) — {verConferidos ? 'clique para ocultar' : 'clique para ver e reabrir'}
            </button>
            {verConferidos && conferidosGrupos.map((g, gi) => (
              <div key={gi} style={{ background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden', marginBottom: 10, opacity: 0.9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: theme.input, gap: 8 }}>
                  <span style={{ color: theme.text, fontSize: 13, fontWeight: 600 }}><i className="ti ti-circle-check" style={{ color: theme.green, marginRight: 6 }} />{g.nome}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: theme.yellow, borderColor: theme.yellow }} onClick={() => reabrirConferidos(g.lancs)}><i className="ti ti-rotate-2" /> Reabrir ({g.lancs.length})</button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                    <tbody>
                      {g.lancs.map((l, i) => (
                        <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, fontSize: 12 }}>
                          <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{l.data || '—'}</td>
                          <td style={{ ...td, color: theme.sub, fontFamily: 'monospace', fontSize: 11, maxWidth: 320 }}>{l.historico}</td>
                          <td style={{ ...tdR, color: theme.green }}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                          <td style={{ ...tdR, color: theme.red }}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
        </>
      )}

      {(() => {
        const selLancs = lanc.filter(l => selLin.has(l.id) && l.id != null)
        if (!selLancs.length) return null
        const net = selLancs.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
        const zera = Math.abs(net) < 0.005
        // Corrigir fornecedor vale para QUALQUER linha (título, saldo anterior e também os
        // lançamentos gerados/"não identificados" — nesses o nome fica salvo por lançamento).
        // Desvincular só faz sentido em quem já tem nome (título/saldo anterior).
        const desvincaveis = selLancs.filter(l => !l.acerto && (l.leitura?.entidade || '').trim())
        return (
          <div style={{ position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 16px', background: theme.card, border: `1px solid ${theme.accent}`, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.4)' }}>
            <span style={{ color: theme.text, fontSize: 13 }}><b>{selLancs.length}</b> selecionado(s) · líquido <b style={{ color: zera ? theme.green : theme.yellow }}>{money(Math.abs(net))} {net < 0 ? 'C' : net > 0 ? 'D' : ''}</b> {zera ? '(zera)' : '(não zera)'}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => setLoteForn({ lines: selLancs })}>
              <i className="ti ti-user-edit" /> Corrigir {lab}
            </button>
            <button className="btn btn-ghost" disabled={!desvincaveis.length} title={!desvincaveis.length ? 'Selecione um título ou o saldo anterior (com nome).' : 'Manter estes nomes separados (não unir com parecidos) — vale para todos os meses'} style={{ fontSize: 12.5, color: theme.yellow, borderColor: theme.yellow, opacity: desvincaveis.length ? 1 : 0.5, cursor: desvincaveis.length ? 'pointer' : 'not-allowed' }} onClick={() => desvincaveis.length && desvincularLote(desvincaveis)}>
              <i className="ti ti-arrows-split" /> Desvincular
            </button>
            <button className="btn" disabled={selLancs.length < 2} style={{ fontSize: 12.5, background: selLancs.length >= 2 ? theme.green : undefined, borderColor: selLancs.length >= 2 ? theme.green : undefined, opacity: selLancs.length >= 2 ? 1 : 0.5 }} onClick={conectarSelecionados}>
              <i className="ti ti-link" /> Conectar (baixar)
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => setSelLin(new Set())}><i className="ti ti-x" /> Limpar</button>
          </div>
        )
      })()}

      {novoLanc && (
        <ModalNovoLancamento conta={conta} competencia={competencia} plano={plano} onClose={() => setNovoLanc(false)} onCriar={criarLancamento} />
      )}

      {loteForn && (
        <ModalLoteForn lines={loteForn.lines} lab={lab} onClose={() => setLoteForn(null)} onAplicar={aplicarFornecedorLote} />
      )}

      {conectarDif && (
        <ModalConectarDif net={conectarDif.net} plano={plano} onClose={() => setConectarDif(null)}
          onAplicar={(kind, contaDif) => aplicarConexaoDif(conectarDif.alvo, conectarDif.net, kind, contaDif)} />
      )}

      {acao && (
        <ModalLancamento lanc={acao} conta={conta} lab={lab} plano={plano} natCredito={natCredito}
          residuo={ehEntidadeConta ? residuoNF(acao) : 0}
          onClose={() => setAcao(null)} onRegistrar={registrar}
          onDesvincular={async nome => { setAcao(null); await marcarIsolado(nome); setMsg(`"${nome}" desvinculado — não vou mais unir com nomes parecidos.`) }} />
      )}
      {verCorr && (
        <ModalCorrigido linha={verCorr} conta={conta} compId={compId} planoMap={planoMap}
          onClose={() => setVerCorr(null)} onDesfazer={() => desfazerCorrecao(verCorr)} />
      )}
      {verComposic && (
        <ModalComposicao titulo={verComposic.titulo} itens={verComposic.itens} onClose={() => setVerComposic(null)} />
      )}
    </Wrapper>
  )
}

// Composição de um saldo (inicial ou final): lista os títulos/lançamentos que o compõem,
// com saldo acumulado. O saldo inicial traz a abertura (arrastada do mês anterior); o saldo
// final, o que segue em aberto (arrasta para o próximo mês). Sem movimento no mês, são iguais.
function ModalComposicao({ titulo, itens, onClose }) {
  let saldo = 0
  const totD = itens.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totC = itens.reduce((s, l) => s + (Number(l.credito) || 0), 0)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 70 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, width: 'min(840px, 96vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>{titulo}</h3>
          <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="ti ti-x" /> Fechar</button>
        </div>
        <div style={{ overflow: 'auto' }}>
          {itens.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 20px' }}>Sem composição de títulos em aberto (conta de saldo, sem itens a compor).</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Data</th><th style={th}>Histórico / NF</th>
                  <th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={thR}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((l, i) => {
                  saldo += (Number(l.debito) || 0) - (Number(l.credito) || 0)
                  const nf = l.leitura?.nf
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: l._abertura ? 'rgba(74,124,255,0.06)' : undefined }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                      <td style={{ ...td, maxWidth: 400, whiteSpace: 'normal' }}>
                        {l._abertura && <span style={{ color: theme.accent, fontSize: 10, fontWeight: 700, marginRight: 6 }}>SALDO ANT.</span>}
                        {l.historico || ''}
                        {nf && !String(l.historico || '').replace(/\D/g, '').includes(String(nf).replace(/\D/g, '')) ? <span style={{ color: theme.sub }}> · NF {nf}</span> : null}
                      </td>
                      <td style={{ ...tdR }}>{Number(l.debito) ? money(l.debito) : ''}</td>
                      <td style={{ ...tdR }}>{Number(l.credito) ? money(l.credito) : ''}</td>
                      <td style={{ ...tdR, color: saldo < 0 ? theme.red : theme.text }}>{money(saldo)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{money(totD)}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{money(totC)}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{money(totD - totC)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// Lista simples dos lançamentos de uma conta de composição que NÃO é por entidade
// (ex.: IRRF s/ aplicação): sem nome/NF/agrupamento; cada lançamento é clicável.
function ListaLancamentos({ lanc, carregando, contraDe, planoMap, tratados = new Set(), onTratar, selLin, onToggleSel, onExcluirAbertura, podeExcluirAbertura, aberturaFechada }) {
  const selectable = !!onToggleSel // permite marcar linhas p/ conectar (baixa manual)
  const nCols = selectable ? 7 : 6
  return (
    <>
      <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '4px 0 10px' }}>Lançamentos da conta</p>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              {selectable && <th style={{ ...th, width: 26 }} title="Marcar para conectar (baixa manual)"></th>}
              <th style={th}>Data</th><th style={th}>Histórico</th><th style={th}>Contrapartida</th>
              <th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={{ ...th, textAlign: 'center' }}>Ação</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr><td colSpan={nCols} style={{ ...td, color: theme.sub }}>Carregando…</td></tr>
            ) : lanc.length === 0 ? (
              <tr><td colSpan={nCols} style={{ ...td, color: theme.sub }}>Sem lançamentos nesta conta.</td></tr>
            ) : lanc.map((l, i) => {
              const contras = contraDe(l)
              return (
                <tr key={i} onClick={() => onTratar(l)} style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', opacity: (l.acerto || tratados.has(l.id)) ? 0.7 : 1, background: (l.acerto || tratados.has(l.id)) ? 'rgba(48,164,108,0.08)' : 'transparent' }} title={l.acerto ? `${tagAcertoLanc(l).titulo} — clique para ver ou desfazer` : tratados.has(l.id) ? 'Já tratado — clique para ver ou desfazer' : 'Justificar ou corrigir este lançamento'}>
                  {selectable && (
                    <td style={{ ...td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                      {l.id != null && <input type="checkbox" title="Conectar com outro (baixa manual)" checked={selLin?.has(l.id)} onChange={() => onToggleSel(l)} style={{ cursor: 'pointer', width: 15, height: 15 }} />}
                    </td>
                  )}
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{l.data || '—'}</td>
                  <td style={{ ...td, color: theme.sub, fontFamily: 'monospace', fontSize: 11, maxWidth: 320 }}>{l.historico}</td>
                  <td style={{ ...td, fontSize: 11.5, whiteSpace: 'nowrap' }} title={contras.map(c => `${c}${planoMap[c] ? ' · ' + planoMap[c] : ''}`).join('\n')}>
                    {contras.length === 0 ? <span style={{ color: theme.sub }}>—</span>
                      : contras.length === 1 ? <span><b>{contras[0]}</b>{planoMap[contras[0]] && <span style={{ color: theme.sub }}> · {planoMap[contras[0]]}</span>}</span>
                      : <span><b>{contras[0]}</b><span style={{ color: theme.sub }}> +{contras.length - 1}</span></span>}
                  </td>
                  <td style={{ ...tdR, color: theme.green }}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                  <td style={{ ...tdR, color: theme.red }}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{l.acerto
                    ? <span title={tagAcertoLanc(l).titulo} style={{ color: theme.accent, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className={`ti ${tagAcertoLanc(l).icon}`} /> {tagAcertoLanc(l).txt}</span>
                    : tratados.has(l.id)
                      ? <span title="Já tratado" style={{ color: theme.green, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-arrow-back-up" /> corrigido</span>
                      : l._abertura && podeExcluirAbertura
                        ? <button title={aberturaFechada ? 'Abertura fechada — reabra para excluir' : 'Excluir esta linha do saldo inicial'}
                            disabled={aberturaFechada} onClick={e => { e.stopPropagation(); onExcluirAbertura(l) }}
                            style={{ background: 'none', border: 'none', color: aberturaFechada ? theme.sub : theme.red, cursor: aberturaFechada ? 'not-allowed' : 'pointer', fontSize: 14 }}>
                            <i className="ti ti-trash" />
                          </button>
                        : <i className="ti ti-dots" style={{ color: theme.sub }} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// Quando o extrato NÃO bate com o saldo contábil, sugere o que no razão do banco
// pode explicar a diferença: lançamentos com valor igual à diferença, ou pares
// que somam a diferença. Ancorado no razão (dado confiável, já importado).
function SugestoesDiferenca({ conta, compId, dif }) {
  const [lancs, setLancs] = useState(null)
  const [aberto, setAberto] = useState(false)
  const [carregando, setCarregando] = useState(false)
  const alvo = Math.round(Math.abs(dif) * 100) / 100

  async function abrir() {
    setAberto(a => !a)
    if (lancs != null) return
    setCarregando(true)
    const { data } = await supabase.from('razao')
      .select('id, data, historico, contrapartida, debito, credito')
      .eq('competencia_id', compId).eq('conta', conta.conta).order('data')
    setLancs(data || [])
    setCarregando(false)
  }

  const val = l => Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100) / 100
  // Agrupa por valor (em módulo) para detectar VALORES REPETIDOS (duplicidade).
  const grupos = {}
  for (const l of (lancs || [])) { const k = Math.abs(val(l)).toFixed(2); (grupos[k] = grupos[k] || []).push(l) }
  const exatos = grupos[alvo.toFixed(2)] || []   // lançamentos com valor == diferença
  const duplicado = exatos.length >= 2           // 2+ com esse valor → provável duplicidade
  // Se nenhum lançamento sozinho bate, procura PARES que somam a diferença.
  const pares = []
  if (lancs && exatos.length === 0 && alvo > 0.005) {
    const arr = lancs.map(l => ({ l, v: Math.abs(val(l)) })).filter(o => o.v > 0.005)
    for (let i = 0; i < arr.length && pares.length < 6; i++)
      for (let j = i + 1; j < arr.length && pares.length < 6; j++)
        if (Math.abs(arr[i].v + arr[j].v - alvo) < 0.005) pares.push([arr[i].l, arr[j].l])
  }

  const Linha = ({ l }) => (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '4px 0', borderTop: `0.5px solid ${theme.cb}` }}>
      <span style={{ color: theme.sub, minWidth: 78 }}>{l.data || '—'}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{l.historico || '(sem histórico)'}{l.contrapartida ? ` · contra ${l.contrapartida}` : ''}</span>
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', color: val(l) < 0 ? theme.red : theme.text }}>{money(Math.abs(val(l)))} {val(l) < 0 ? 'C' : 'D'}</span>
    </div>
  )

  return (
    <div style={{ marginTop: 12 }}>
      <button className="btn btn-ghost" style={{ padding: '5px 11px', fontSize: 12.5 }} onClick={abrir}>
        <i className={`ti ti-${aberto ? 'chevron-down' : 'search'}`} /> Lançamentos que podem explicar a diferença
      </button>
      {aberto && <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: 12, marginTop: 10 }}>
        {carregando ? <p style={{ color: theme.sub, fontSize: 12.5, margin: 0 }}>Buscando no razão…</p> : <>
          {duplicado && <>
            <div style={{ background: 'rgba(245,166,35,0.10)', border: `1px solid ${theme.yellow}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
              <p style={{ fontSize: 12.5, margin: 0, color: theme.text }}>
                <i className="ti ti-copy" style={{ color: theme.yellow, marginRight: 6 }} />
                <b>Provável duplicidade.</b> No razão há <b>{exatos.length} lançamentos de {money(alvo)}</b>, e a diferença é exatamente esse valor. Se no extrato o valor aparece só <b>uma vez</b>, um deles está a mais — <b>estorne o excedente</b>.
              </p>
            </div>
            {exatos.map(l => <Linha key={l.id} l={l} />)}
            <p style={{ color: theme.sub, fontSize: 11.5, margin: '8px 0 0' }}>Confira no extrato quantas vezes o valor aparece; para tirar o excedente, clique no lançamento e use “Estornar”.</p>
          </>}
          {!duplicado && exatos.length === 1 && <>
            <p style={{ fontSize: 12.5, fontWeight: 600, margin: '0 0 4px' }}>Lançamento com valor igual à diferença ({money(alvo)}):</p>
            {exatos.map(l => <Linha key={l.id} l={l} />)}
            <p style={{ color: theme.sub, fontSize: 11.5, margin: '8px 0 0' }}>Provável causa — confira se ele consta no extrato e, se preciso, estorne/corrija.</p>
          </>}
          {exatos.length === 0 && pares.length > 0 && <>
            <p style={{ fontSize: 12.5, fontWeight: 600, margin: '0 0 4px' }}>Pares de lançamentos que somam a diferença ({money(alvo)}):</p>
            {pares.map((par, i) => <div key={i} style={{ marginBottom: 8 }}>{par.map(l => <Linha key={l.id} l={l} />)}</div>)}
          </>}
          {exatos.length === 0 && pares.length === 0 && <p style={{ color: theme.sub, fontSize: 12.5, margin: 0 }}>
            Nenhum lançamento (nem par) do razão bate exatamente com a diferença de {money(alvo)}. A diferença pode estar diluída em vários lançamentos, em transações do extrato ainda não contabilizadas, ou no saldo lido do extrato.
          </p>}
        </>}
      </div>}
    </div>
  )
}

// Card de conferência da conta (toda conta começa VERMELHA):
// - Verde:   documento suporte importado que BATE com o saldo.
// - Amarelo: confirmada ("está certo") + justificativa da falta de documento
//            (marcando "pendência do cliente", entra no Relatório de Pendências).
// Lançamento JÁ TRATADO: mostra o que foi feito (correção/estorno/justificativa)
// e o lançamento de acerto gerado — e permite DESFAZER. Não reabre a tela de tratar.
function ModalCorrigido({ linha, compId, planoMap = {}, onClose, onDesfazer }) {
  const [dados, setDados] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let vivo = true
    ;(async () => {
      const [{ data: aud }, { data: lan }] = await Promise.all([
        supabase.from('auditoria').select('tipo, detalhe, usuario, created_at').eq('competencia_id', compId).eq('modulo', 'Conciliação').eq('razao_id', linha.id).order('created_at'),
        supabase.from('lancamentos').select('id, conta_debito, conta_credito, valor, historico').eq('competencia_id', compId).eq('razao_id', linha.id),
      ])
      if (vivo) setDados({ aud: aud || [], lan: lan || [] })
    })()
    return () => { vivo = false }
  }, [linha.id, compId])

  const valor = Number(linha.debito) ? `D ${money(linha.debito)}` : Number(linha.credito) ? `C ${money(linha.credito)}` : ''
  const nomeConta = c => c ? `${c}${planoMap[c] ? ' · ' + planoMap[c] : ''}` : '—'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Lançamento já tratado</h2>
        <div style={{ background: theme.input, borderRadius: 10, padding: '10px 12px', margin: '8px 0 14px', fontSize: 12.5 }}>
          <span style={{ color: theme.sub }}>{linha.data || '—'} · NF {linha.leitura?.nf || '—'} · {valor}</span>
          <div style={{ color: theme.sub, fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>{linha.historico}</div>
        </div>

        {!dados ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Carregando…</p> : <>
          {dados.aud.map((a, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <span style={{ display: 'inline-block', background: 'rgba(48,164,108,0.15)', color: theme.green, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{a.tipo}</span>
              {a.detalhe && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{a.detalhe}</p>}
              <p style={{ color: theme.sub, fontSize: 11, margin: '2px 0 0' }}>{a.usuario || '—'}{a.created_at ? ` · ${new Date(a.created_at).toLocaleString('pt-BR')}` : ''}</p>
            </div>
          ))}
          {dados.lan.length > 0 && <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 10, marginTop: 6 }}>
            <p style={{ fontSize: 12, color: theme.sub, margin: '0 0 6px' }}>Lançamento de acerto gerado (no painel Contabilizar):</p>
            {dados.lan.map(l => (
              <div key={l.id} style={{ fontSize: 12.5, marginBottom: 8 }}>
                <div><b>D</b> {nomeConta(l.conta_debito)}</div>
                <div><b>C</b> {nomeConta(l.conta_credito)}</div>
                <div style={{ color: theme.sub }}>{money(l.valor)}{l.historico ? ` · ${l.historico}` : ''}</div>
              </div>
            ))}
          </div>}
          {dados.aud.length === 0 && dados.lan.length === 0 && <p style={{ color: theme.sub, fontSize: 12.5 }}>Sem detalhes registrados para esta linha.</p>}
        </>}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" style={{ color: theme.red, borderColor: theme.red }} disabled={busy} onClick={async () => { setBusy(true); await onDesfazer() }}><i className="ti ti-rotate-2" /> Desfazer correção</button>
          <button className="btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

function CardConferencia({ conta, reg, compId, usuario, saldoAjuste = 0, composicao, onSalvo }) {
  const { empresaId } = useAppData()
  const [doc, setDoc] = useState(reg?.documento || '')
  const [saldoDoc, setSaldoDoc] = useState(reg?.saldo_documento != null ? String(reg.saldo_documento) : '')
  const [conciliada, setConciliada] = useState(!!reg?.conciliada)
  const [just, setJust] = useState(reg?.justificativa || '')
  const [pend, setPend] = useState(!!reg?.pendencia_cliente)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [arquivo, setArquivo] = useState(null)          // arquivo selecionado, pendente de upload
  const [path, setPath] = useState(reg?.documento_path || '') // caminho no Storage (arquivo armazenado)
  const [savedId, setSavedId] = useState(reg?.id || null)     // id da linha de conciliação (evita duplicar)
  const [ocr, setOcr] = useState({ ativo: false, pct: 0 })    // progresso do OCR (PDF-imagem)

  // Saldo efetivo = balancete + correções pendentes (estornos/acertos). Assim, ao
  // corrigir, o saldo já reconfere com o extrato e a conta fica verde na hora.
  const saldo = (Number(conta.saldo_final) || 0) + (Number(saldoAjuste) || 0)
  const validadoPatrimonio = /patrim/i.test(doc || '') // validada pela integração de Patrimônio
  const temDoc = doc && saldoDoc !== ''
  const temSaldoDoc = saldoDoc !== ''
  // Diferença pela NATUREZA da conta: o documento vem positivo; numa devedora é
  // saldo − documento, numa credora é saldo + documento. Se |saldo| == |documento|,
  // fecha em zero. Ex.: FGTS a pagar 1.600 C com guia de 1.600 → zero.
  const dif = difConciliacao(saldo, Number(saldoDoc) || 0)
  const bateSaldo = temDoc && Math.abs(dif) < 0.05 // até 5 centavos é irrelevante (arredondamento)
  // VERDE só quando o arquivo está armazenado E o saldo bate. Se o arquivo for
  // excluído (path some), volta ao vermelho mesmo que o saldo continue batendo.
  const bate = bateSaldo && !!path
  const cor = bate ? theme.green : (conciliada && just.trim()) ? theme.yellow : theme.red
  const statusTxt = bate ? 'Verde — documento armazenado e bate com o saldo' : (conciliada && just.trim()) ? 'Amarelo — conferida e justificada (sem documento)' : 'Vermelho — pendente'

  async function lerArquivo(file) {
    if (!file) return; setErro(''); setMsg('')
    const ehPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
    let saldoLido = null
    try {
      if (ehPdf) {
        // Extrato/guia em PDF (ex.: extrato bancário, guia do INSS).
        const { extrairTextoPdf, palpiteSaldo, ocrPdf, somaDestaquesPdf } = await import('../lib/pdfText')
        setDoc(file.name)
        // 1º) Valores destacados em AMARELO (anotação Highlight): o cliente pinta tudo o
        //     que compõe o saldo (ex.: guia com vários valores). O saldo = a SOMA deles.
        let destaque = null
        try { destaque = await somaDestaquesPdf(file) } catch { destaque = null }
        let s = null
        if (destaque && destaque.valores.length) {
          s = destaque.soma
          setSaldoDoc(String(s))
          setMsg(destaque.valores.length > 1
            ? `Saldo = soma de ${destaque.valores.length} valores destacados em amarelo = ${money(s)}. Confira.`
            : 'Saldo lido do valor destacado em amarelo — confira se está correto.')
        } else {
          const texto = await extrairTextoPdf(file)
          s = palpiteSaldo(texto, saldo)
          if (s != null) { setSaldoDoc(String(s)) }
          else if (texto.replace(/\s/g, '').length < 20) {
            // PDF sem texto (imagem/print) → tenta ler por OCR (reconhecimento de imagem).
            setOcr({ ativo: true, pct: 0 })
            try {
              const textoOcr = await ocrPdf(file, pct => setOcr({ ativo: true, pct }))
              s = palpiteSaldo(textoOcr, saldo)
              if (s != null) { setSaldoDoc(String(s)); setMsg('Saldo lido por reconhecimento de imagem (OCR) — confira se está correto.') }
              else setErro('Este PDF é uma imagem e o reconhecimento (OCR) não achou o saldo. Baixe o extrato digital direto do banco — ou digite o saldo abaixo.')
            } catch (eo) {
              setErro('Não consegui ler a imagem por OCR (' + eo.message + '). Baixe o extrato digital do banco ou digite o saldo abaixo.')
            } finally { setOcr({ ativo: false, pct: 0 }) }
          }
          else
            setErro('Li o PDF, mas não identifiquei o saldo automaticamente — se for uma guia com vários valores, pinte-os de amarelo (destaque) para eu somar; senão digite o saldo abaixo.')
        }
        saldoLido = s
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellStyles: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
        setDoc(file.name)
        const amarelo = saldoCelulaAmarela(ws, XLSX)
        const comentario = amarelo == null ? saldoCelulaComentario(ws, XLSX) : null
        if (amarelo != null) { setSaldoDoc(String(amarelo)); setMsg('Saldo lido da célula destacada em amarelo — confira se está correto.'); saldoLido = amarelo }
        else if (comentario != null) { setSaldoDoc(String(comentario)); setMsg('Saldo lido da célula com comentário — confira se está correto.'); saldoLido = comentario }
        else {
          const r = lerSaldoDocumento(arr, saldo)
          if (r) { setSaldoDoc(String(r.valor)); setMsg(`Saldo lido: ${r.via} — confira se está correto.`); saldoLido = r.valor }
          else setErro('Não identifiquei o saldo. Destaque a célula do saldo em amarelo, coloque um comentário nela, use uma célula escrita "SALDO", ou digite o saldo abaixo.')
        }
      }
      setArquivo(file)
      await armazenar(file, saldoLido) // grava na hora — não perde ao atualizar a página
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  // Armazena o arquivo no Storage e grava a linha de conciliação NA HORA (ao escolher),
  // para não perder o anexo se a página for atualizada sem clicar em Salvar.
  async function armazenar(file, saldoValor) {
    if (!file || !compId) return
    setSalvando(true)
    try {
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
      const base = `${compId}/${conta.conta}`.replace(/[^a-zA-Z0-9/_-]/g, '_')
      const novoPath = `${base}/extrato${ext}`
      const { error: eUp } = await supabase.storage.from('extratos').upload(novoPath, file, { upsert: true, contentType: file.type || undefined })
      if (eUp) { setErro('Não consegui armazenar o arquivo: ' + eUp.message); return }
      if (path && path !== novoPath) await supabase.storage.from('extratos').remove([path])
      const campos = { competencia_id: compId, conta: conta.conta, documento: file.name, documento_path: novoPath, usuario }
      if (saldoValor != null) campos.saldo_documento = saldoValor
      const id = reg?.id || savedId
      let error, novo
      if (id) ({ error } = await supabase.from('conciliacao_conta').update(campos).eq('id', id))
      else ({ data: novo, error } = await supabase.from('conciliacao_conta').insert(campos).select('id').single())
      if (error) { setErro('Não consegui salvar: ' + error.message); return }
      if (novo?.id) setSavedId(novo.id)
      setPath(novoPath); setArquivo(null); setMsg('Arquivo anexado e salvo — fica guardado mesmo atualizando a página.')
      onSalvo && onSalvo()
    } finally { setSalvando(false) }
  }

  // Abre o arquivo armazenado (link assinado, válido por 5 min).
  async function verArquivo() {
    setErro('')
    if (path) {
      const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300)
      if (error) { setErro('Não consegui abrir o arquivo: ' + error.message); return }
      window.open(data.signedUrl, '_blank', 'noopener')
    } else if (arquivo) {
      // Arquivo recém-escolhido, ainda não salvo — abre a cópia local.
      window.open(URL.createObjectURL(arquivo), '_blank', 'noopener')
    }
  }

  // Relê o documento JÁ ARMAZENADO com a lógica atual (sem precisar subir de novo).
  // Útil para corrigir saldos lidos por versões antigas do leitor.
  async function relerDocumento() {
    if (!path) return
    setErro(''); setMsg('')
    const { data, error } = await supabase.storage.from('extratos').download(path)
    if (error) { setErro('Não consegui baixar o arquivo salvo: ' + error.message); return }
    const nome = doc || path.split('/').pop() || 'documento'
    const ehPdf = /\.pdf$/i.test(nome)
    const file = new File([data], nome, { type: data.type || (ehPdf ? 'application/pdf' : '') })
    await lerArquivo(file) // relê e regrava o saldo (armazenar no fim)
  }

  // Exclui o arquivo armazenado → a conta volta ao vermelho.
  async function excluirArquivo() {
    if (!path) return
    if (!window.confirm('Excluir o arquivo armazenado? A conta volta a ficar vermelha até você subir um novo.')) return
    setSalvando(true); setErro(''); setMsg('')
    const { error: eRm } = await supabase.storage.from('extratos').remove([path])
    if (eRm) { setSalvando(false); setErro('Não consegui excluir o arquivo: ' + eRm.message); return }
    let error
    const id = reg?.id || savedId
    if (id) ({ error } = await supabase.from('conciliacao_conta').update({ documento_path: null, documento: null, usuario }).eq('id', id))
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setPath(''); setArquivo(null); setDoc('')
    setMsg('Arquivo excluído — a conta voltou ao vermelho.'); onSalvo && onSalvo()
  }

  async function salvar() {
    setSalvando(true); setErro(''); setMsg('')
    let novoPath = path
    // Se há um arquivo novo selecionado, armazena no Storage (bucket privado).
    if (arquivo) {
      const ext = (arquivo.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
      const base = `${compId}/${conta.conta}`.replace(/[^a-zA-Z0-9/_-]/g, '_')
      novoPath = `${base}/extrato${ext}`
      const { error: eUp } = await supabase.storage.from('extratos')
        .upload(novoPath, arquivo, { upsert: true, contentType: arquivo.type || undefined })
      if (eUp) { setSalvando(false); setErro('Não consegui armazenar o arquivo: ' + eUp.message); return }
      // Remove um arquivo anterior de nome diferente (garante só um ativo).
      if (path && path !== novoPath) await supabase.storage.from('extratos').remove([path])
    }
    const payload = {
      competencia_id: compId, conta: conta.conta,
      documento: doc || null, saldo_documento: saldoDoc === '' ? null : Number(saldoDoc),
      documento_path: novoPath || null,
      conciliada, justificativa: just || null, pendencia_cliente: pend, usuario,
    }
    const id = reg?.id || savedId
    let error, novo
    if (id) ({ error } = await supabase.from('conciliacao_conta').update(payload).eq('id', id))
    else ({ data: novo, error } = await supabase.from('conciliacao_conta').insert(payload).select('id').single())
    setSalvando(false)
    if (error) { setErro(error.message); return }
    if (novo?.id) setSavedId(novo.id)
    setPath(novoPath); setArquivo(null)
    setMsg('Conferência salva.'); onSalvo && onSalvo()
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ background: theme.card, border: `1px solid ${cor}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Dot c={cor} /><p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Conferência da conta</p>
          <span style={{ color: cor, fontSize: 12, fontWeight: 600 }}>· {statusTxt}</span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 14px' }}>{composicao
          ? 'Importe o documento suporte (ex.: relatório de aberto) e confira com o saldo. Sem documento, confirme que está certo e justifique.'
          : 'Conta de saldo (sem composição). Importe o extrato e confira com o saldo. Sem documento, confirme que está certo e justifique.'}</p>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: Math.abs(Number(saldoAjuste) || 0) > 0.005 ? 4 : 12 }}>
          <Mini label="Saldo da conta" v={moneyDC(saldo)} />
          <Mini label="Saldo do documento" v={saldoDoc === '' ? '—' : money(Number(saldoDoc))} />
          <Mini label="Diferença" v={temSaldoDoc ? money(dif) : '—'} cor={!temSaldoDoc ? theme.sub : Math.abs(dif) < 0.05 ? theme.green : theme.red} />
        </div>
        {Math.abs(Number(saldoAjuste) || 0) > 0.005 && <p style={{ color: theme.accent, fontSize: 11.5, margin: '0 0 12px' }}>
          <i className="ti ti-adjustments-alt" /> Inclui {moneyDC(saldoAjuste)} de correções pendentes (balancete: {moneyDC(conta.saldo_final)}).
        </p>}
        {validadoPatrimonio && <p style={{ color: theme.green, fontSize: 12.5, margin: '0 0 10px', fontWeight: 500 }}>
          <i className="ti ti-shield-check" /> Validado pela <b>Integração de Patrimônio</b> (Resumo da Depreciação). O arquivo que valida está lá, na aba <b>Patrimônio</b> — não precisa importar aqui.
        </p>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label>Documento suporte <span style={{ color: theme.sub, fontWeight: 400 }}>{validadoPatrimonio ? '(ou troque pelo extrato próprio)' : '(Excel ou PDF do extrato)'}</span></label><input type="file" accept=".xlsx,.xls,.csv,.pdf" onChange={e => lerArquivo(e.target.files?.[0])} style={{ fontSize: 13, color: theme.sub, display: 'block' }} /></div>
          <div><label>Saldo conforme o documento</label><input className="input" type="number" step="0.01" style={{ maxWidth: 200 }} value={saldoDoc} onChange={e => setSaldoDoc(e.target.value)} placeholder="0,00" /></div>
        </div>
        {ocr.ativo && <p style={{ color: theme.sub, fontSize: 12.5, margin: '10px 0 0', fontWeight: 500 }}>
          <i className="ti ti-scan" /> Lendo a imagem do extrato (OCR){ocr.pct ? ` — ${Math.round(ocr.pct * 100)}%` : '…'} — pode levar alguns segundos.
        </p>}
        {doc && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '10px 0 0' }}>
          <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-file" /> {doc}{path ? '' : arquivo ? ' (será armazenado ao salvar)' : ''}</span>
          {(path || arquivo) && <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={verArquivo}><i className="ti ti-eye" /> Ver arquivo</button>}
          {path && <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={salvando || ocr.ativo} onClick={relerDocumento} title="Relê o arquivo já salvo com a leitura atual (sem precisar subir de novo)"><i className="ti ti-refresh" /> Reler documento</button>}
          {path && <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12, color: theme.red, borderColor: theme.red }} disabled={salvando} onClick={excluirArquivo}><i className="ti ti-trash" /> Excluir arquivo</button>}
        </div>}
        {temSaldoDoc && <p style={{ color: bate ? theme.green : bateSaldo ? theme.sub : theme.red, fontSize: 12.5, margin: '10px 0 0', fontWeight: 500 }}>
          <i className={`ti ${bate ? 'ti-circle-check' : bateSaldo ? 'ti-cloud-upload' : 'ti-alert-triangle'}`} /> {bate ? 'Arquivo armazenado e bate com o saldo — fica verde.' : bateSaldo ? 'Bate com o saldo — salve para armazenar o arquivo e ficar verde.' : `Diferença de ${money(Math.abs(dif))} entre o saldo da conta e o documento.`}
        </p>}
        {temSaldoDoc && !bateSaldo && Math.abs(dif) > 0.005 && <SugestoesDiferenca conta={conta} compId={compId} dif={dif} />}
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Sem o documento? Confirme e justifique (fica amarela)</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={conciliada} onChange={e => setConciliada(e.target.checked)} /> Confirmo que esta conta está conciliada (está certo)
        </label>
        <textarea className="input" rows={2} value={just} onChange={e => setJust(e.target.value)} placeholder="Justifique a falta do documento (ex.: aguardando extrato / cliente não enviou)…" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={pend} onChange={e => setPend(e.target.checked)} /> É pendência do cliente (cobrar — vai para o Relatório de Pendências)
        </label>
        <button className="btn" disabled={salvando} onClick={salvar}><i className="ti ti-device-floppy" /> Salvar conferência</button>
        {msg && <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msg}</p>}
        {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}
      </div>

      <ComentariosConta clienteId={empresaId} conta={conta.conta} usuario={usuario} />
    </div>
  )
}

// Relatórios da composição (em aberto / conciliados) em Excel ou PDF.
function RelatoriosComposicao({ conta, emAberto, zerados, contraDe }) {
  const cols = ['Data', 'NF', 'Histórico', 'Contrapartida', 'Débito', 'Crédito']
  const linhaArr = l => [l.data || '', l.leitura?.nf || '', l.historico || '', contraDe(l).join(', '), Number(l.debito) || 0, Number(l.credito) || 0]
  const linhaTxt = l => [l.data || '', l.leitura?.nf || '', l.historico || '', contraDe(l).join(', '), Number(l.debito) ? money(l.debito) : '', Number(l.credito) ? money(l.credito) : '']
  const titulo = sub => `Conciliação · ${conta.conta} · ${conta.nome} — ${sub}`
  const somaDeb = ls => ls.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const somaCred = ls => ls.reduce((s, l) => s + (Number(l.credito) || 0), 0)

  // Em blocos por cliente/fornecedor, no papel timbrado da Attentive.
  async function excel(linhas, sub) {
    const blocos = agruparPorCliente(linhas)
    await gerarExcelTimbrado({
      titulo: titulo(sub),
      sub: `${blocos.length} ${blocos.length === 1 ? 'cliente/fornecedor' : 'clientes/fornecedores'} · ${linhas.length} lançamento(s)`,
      colunas: [
        { nome: 'Data', largura: 12 }, { nome: 'NF', largura: 12 }, { nome: 'Histórico', largura: 60, wrap: true },
        { nome: 'Contrapartida', largura: 26 }, { nome: 'Débito', alinhar: 'right', moeda: true }, { nome: 'Crédito', alinhar: 'right', moeda: true },
      ],
      secoes: blocos.map(b => ({
        titulo: b.cliente,
        linhas: b.lancs.map(linhaArr),
        totais: ['', '', '', 'Subtotal', somaDeb(b.lancs), somaCred(b.lancs)],
      })),
      totais: ['', '', '', 'TOTAL GERAL', somaDeb(linhas), somaCred(linhas)],
      arquivo: `conciliacao_${conta.conta}_${sub.replace(/\s+/g, '-').toLowerCase()}.xlsx`,
      aba: sub,
    })
  }

  function pdf(linhas, sub) {
    const blocos = agruparPorCliente(linhas)
    abrePdfTimbrado({
      titulo: titulo(sub),
      sub: `${blocos.length} ${blocos.length === 1 ? 'cliente/fornecedor' : 'clientes/fornecedores'} · ${linhas.length} lançamento(s)`,
      colunas: [{ nome: 'Data' }, { nome: 'NF' }, { nome: 'Histórico' }, { nome: 'Contrapartida' }, { nome: 'Débito', alinhar: 'right' }, { nome: 'Crédito', alinhar: 'right' }],
      secoes: blocos.map(b => ({
        titulo: b.cliente,
        linhas: b.lancs.map(linhaTxt),
        totais: ['Subtotal', '', '', '', money(somaDeb(b.lancs)), money(somaCred(b.lancs))],
      })),
      totais: ['TOTAL GERAL', '', '', '', money(somaDeb(linhas)), money(somaCred(linhas))],
    })
  }

  const Grupo = ({ rotulo, linhas, icon, cor }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: theme.text, minWidth: 150 }}><i className={`ti ${icon}`} style={{ color: cor, marginRight: 6 }} />{rotulo} <span style={{ color: theme.sub }}>({linhas.length})</span></span>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} disabled={!linhas.length} onClick={() => excel(linhas, rotulo)}><i className="ti ti-file-spreadsheet" /> Excel</button>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} disabled={!linhas.length} onClick={() => pdf(linhas, rotulo)}><i className="ti ti-file-type-pdf" /> PDF</button>
    </div>
  )

  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}><i className="ti ti-report" style={{ color: theme.accent, marginRight: 6 }} />Relatórios da composição</p>
      <div style={{ display: 'grid', gap: 10 }}>
        <Grupo rotulo="Composição atual (em aberto)" linhas={emAberto} icon="ti-folder-open" cor={theme.accent} />
        <Grupo rotulo="Conciliados (o que zerou)" linhas={zerados} icon="ti-circle-check" cor={theme.green} />
      </div>
    </div>
  )
}

// Menu de ação de um lançamento: Justificar (texto) ou Corrigir (já informa a partida
// contábil de acerto, que vai para o painel Contabilizar gerar o arquivo do Domínio).
// Ao conectar com diferença: apontar se é DESCONTO ou JUROS/MULTA e a conta. Obrigatório.
// Novo lançamento manual DENTRO de uma conta da conciliação. A conta atual já vem em um
// dos lados (D por padrão) — dá para trocar. Ao criar, entra no Contabilizar e atualiza o saldo.
function ModalNovoLancamento({ conta, competencia, plano, onClose, onCriar }) {
  const dataPadrao = (() => {
    const [m, a] = String(competencia || '').split('/').map(Number)
    if (!m || !a) return ''
    const d = new Date(a, m, 0).getDate()
    return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  })()
  const [f, setF] = useState({ data: dataPadrao, conta_debito: String(conta.conta || ''), conta_credito: '', valor: '', historico: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const estaNesta = f.conta_debito === String(conta.conta) ? 'D' : f.conta_credito === String(conta.conta) ? 'C' : ''
  const trocarLado = () => setF(x => ({ ...x, conta_debito: x.conta_credito, conta_credito: x.conta_debito }))
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 95 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 4px' }}><i className="ti ti-file-plus" style={{ color: theme.accent, marginRight: 6 }} />Novo lançamento — {conta.conta} · {conta.nome}</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 14px' }}>Inclua um lançamento nesta conta (ex.: tarifa, IOF ou ajuste que faltou no razão). Entra no <b style={{ color: theme.text }}>Contabilizar</b> e atualiza o saldo. A conta atual já vem preenchida{estaNesta ? ` no ${estaNesta === 'D' ? 'débito' : 'crédito'}` : ''}.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Data</label><input className="input" type="date" value={f.data} onChange={e => set('data', e.target.value)} /></div>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Valor</label><input className="input" type="number" step="0.01" value={f.valor} onChange={e => set('valor', e.target.value)} placeholder="0,00" /></div>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Conta débito (F4)</label><CampoConta value={f.conta_debito} onChange={v => set('conta_debito', v)} plano={plano} /></div>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Conta crédito (F4)</label><CampoConta value={f.conta_credito} onChange={v => set('conta_credito', v)} plano={plano} /></div>
          <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize: 12, color: theme.sub }}>Histórico</label><input className="input" value={f.historico} onChange={e => set('historico', e.target.value)} placeholder="Descrição do lançamento" /></div>
        </div>
        <button type="button" onClick={trocarLado} style={{ background: 'none', border: 'none', color: theme.accent, fontSize: 12, cursor: 'pointer', padding: '8px 0 0' }}><i className="ti ti-arrows-exchange" /> Trocar débito ↔ crédito</button>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await onCriar(f); setBusy(false) }}><i className="ti ti-check" /> Gerar lançamento</button>
        </div>
      </div>
    </div>
  )
}

function ModalConectarDif({ net, plano, onClose, onAplicar }) {
  const baixa = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const achaConta = re => (plano || []).find(p => re.test(baixa(p.nome)))?.cod || ''
  const [kind, setKind] = useState('')     // 'desconto' | 'juros'
  const [contaDif, setContaDif] = useState('')
  const [busy, setBusy] = useState(false)
  const dif = Math.abs(net)
  const escolher = k => { setKind(k); setContaDif(k === 'juros' ? achaConta(/juros|encargo|multa/) : achaConta(/desconto/)) }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 95 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(500px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 6px' }}><i className="ti ti-arrows-diff" style={{ color: theme.yellow, marginRight: 6 }} />Os selecionados não zeram</h3>
        <p style={{ color: theme.sub, fontSize: 13, margin: '0 0 4px' }}>Diferença de <b style={{ color: theme.text }}>{money(dif)}</b>. Aponte o que é para gerar a contabilização — <b>não dá para conectar sem classificar</b>.</p>
        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <button className={kind === 'desconto' ? 'btn' : 'btn btn-ghost'} style={{ flex: 1, fontSize: 13 }} onClick={() => escolher('desconto')}><i className="ti ti-discount" /> Desconto</button>
          <button className={kind === 'juros' ? 'btn' : 'btn btn-ghost'} style={{ flex: 1, fontSize: 13 }} onClick={() => escolher('juros')}><i className="ti ti-percentage" /> Juros / multa</button>
        </div>
        {kind && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: theme.sub }}>Conta do {kind === 'juros' ? 'juros/multa' : 'desconto'} (F4)</label>
            <CampoConta value={contaDif} onChange={setContaDif} plano={plano} />
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!kind || !contaDif || busy} onClick={async () => { setBusy(true); await onAplicar(kind, contaDif) }}><i className="ti ti-check" /> Conectar com {kind === 'juros' ? 'juros/multa' : 'desconto'}</button>
        </div>
      </div>
    </div>
  )
}

// Corrigir o fornecedor/cliente de vários lançamentos de uma vez.
function ModalLoteForn({ lines, lab, onClose, onAplicar }) {
  // Aplica a TODAS as linhas selecionadas: título e saldo anterior (por apelido/ajuste) e
  // também os lançamentos gerados/"não identificados" (nome salvo por lançamento).
  const total = (lines || []).length
  const comAcerto = (lines || []).filter(l => l.acerto).length
  // Prefill: o nome mais frequente entre os selecionados (que já têm nome).
  const cont = {}
  for (const l of (lines || [])) { const n = (l.leitura?.entidade || '').trim(); if (n) cont[n] = (cont[n] || 0) + 1 }
  const sugestao = Object.entries(cont).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const [nome, setNome] = useState(sugestao)
  const [aprender, setAprender] = useState(true)
  const [busy, setBusy] = useState(false)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 95 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}><i className="ti ti-user-edit" style={{ color: theme.accent, marginRight: 6 }} />Corrigir {lab} em lote</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>Aplica o nome a <b style={{ color: theme.text }}>{total}</b> lançamento(s) selecionado(s){comAcerto > 0 ? ` (${comAcerto} lançamento(s) gerado(s) — o nome fica salvo por lançamento)` : ''}. Renomeia esse {lab} em todos os meses.</p>
        <label style={{ fontSize: 12, color: theme.sub }}>Nome correto do {lab}</label>
        <input className="input" autoFocus value={nome} onChange={e => setNome(e.target.value)} placeholder={`Nome correto do ${lab}`} style={{ marginBottom: 12 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.sub, cursor: 'pointer', marginBottom: 16 }}>
          <input type="checkbox" checked={aprender} onChange={e => setAprender(e.target.checked)} /> Aprender — não pedir revisão desse {lab} nos próximos meses
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!nome.trim() || !total || busy} onClick={async () => { setBusy(true); await onAplicar(lines, nome, aprender) }}><i className="ti ti-check" /> Aplicar</button>
        </div>
      </div>
    </div>
  )
}

function ModalLancamento({ lanc, conta, lab, plano, natCredito, residuo = 0, onClose, onRegistrar, onDesvincular }) {
  const [tipo, setTipo] = useState(null) // 'Justificativa' | 'Correção'
  const [txt, setTxt] = useState('')
  const valorLan = Number(lanc.debito) || Number(lanc.credito) || 0
  const valor = Number(lanc.debito) ? `D ${money(lanc.debito)}` : Number(lanc.credito) ? `C ${money(lanc.credito)}` : ''
  // Sugestão de partida de acerto: a conta sendo conciliada entra como estorno do lado oposto ao original.
  const ehDeb = Number(lanc.debito) > 0
  const [form, setForm] = useState({
    data: lanc.data || '', valor: valorLan,
    conta_debito: ehDeb ? '' : conta.conta,
    conta_credito: ehDeb ? conta.conta : '',
    historico: contaComNF(conta.nome)
      ? `Reclassificação · NF ${lanc.leitura.nf || '—'} · ${conta.nome}`
      : `Reclassificação · ${conta.nome}`,
  })
  // Ajuste de leitura (ajuda o sistema a cruzar): nome do cliente/fornecedor, NF e histórico.
  const [ajuste, setAjuste] = useState({ entidade: lanc.leitura.entidade || '', nf: lanc.leitura.nf || '', historico: lanc.historico || '' })
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const setAj = k => e => setAjuste(a => ({ ...a, [k]: e.target.value }))

  // Reclassificar para DESPESA (classif 4) → pergunta dedutível/indedutível (LALUR). A conta
  // de destino é o lado da partida que NÃO é a conta conciliada. Sem NF, sugere indedutível.
  const ehDesp = cod => String((plano || []).find(p => String(p.cod) === String(cod))?.classif || '').replace(/\D/g, '')[0] === '4'
  const destinoConta = String(form.conta_debito) === String(conta.conta) ? form.conta_credito : (String(form.conta_credito) === String(conta.conta) ? form.conta_debito : '')
  const destinoEhDespesa = ehDesp(destinoConta)
  const [dedutDest, setDedutDest] = useState('')
  useEffect(() => {
    if (destinoEhDespesa) setDedutDest(d => d || (lanc.leitura?.nf ? 'Dedutível' : 'Indedutível'))
    else setDedutDest('')
  }, [destinoEhDespesa]) // eslint-disable-line react-hooks/exhaustive-deps

  // Diferença da NF tratada como Desconto financeiro ou Juros — pré-preenche a partida de acerto.
  const baixa = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const achaConta = re => (plano || []).find(p => re.test(baixa(p.nome)))?.cod || ''
  const temResiduo = Math.abs(Number(residuo) || 0) >= 0.005
  function tratarDiferenca(kind) {
    const v = Math.abs(Number(residuo) || 0)
    const contraConta = kind === 'juros' ? achaConta(/juros|encargo|multa/) : achaConta(/desconto/)
    // resíduo > 0: a conta (cliente/fornecedor) ainda está devedora → credita a conta para zerar.
    const creditaConta = residuo > 0
    setForm(f => ({
      ...f, valor: v,
      conta_credito: creditaConta ? conta.conta : contraConta,
      conta_debito: creditaConta ? contraConta : conta.conta,
      historico: `${kind === 'juros' ? 'Juros' : 'Desconto financeiro'} · NF ${lanc.leitura.nf || '—'} · ${conta.nome}`,
    }))
    setTipo('Correção')
  }

  // Estorno do lançamento clicado: inverte a partida (D↔C, mesmo valor). O lado
  // que era a conta conciliada troca; a contrapartida vem do razão (quando houver).
  function estornarLanc() {
    const contra = String(lanc.contrapartida || '').trim()
    const contraOk = contra && !/^0+([.,]0+)?$/.test(contra.replace(/\./g, ''))
    setForm(f => ({
      ...f,
      valor: valorLan,
      // original tocou a conta no lado 'ehDeb' → estorno inverte esse lado.
      conta_debito: ehDeb ? (contraOk ? contra : '') : conta.conta,
      conta_credito: ehDeb ? conta.conta : (contraOk ? contra : ''),
      // Histórico = "ESTORNO REF." + histórico do lançamento original.
      historico: (lanc.historico || '').trim() ? `ESTORNO REF. ${lanc.historico.trim()}` : `ESTORNO REF. ${conta.nome}`,
    }))
    setTipo('Correção')
  }

  const ajusteMudou = ajuste.entidade.trim() !== (lanc.leitura.entidade || '') || ajuste.nf.trim() !== (lanc.leitura.nf || '') || ajuste.historico.trim() !== (lanc.historico || '')
  const partidaOk = form.conta_debito && form.conta_credito && Number(form.valor) > 0
  const podeRegistrar = tipo === 'Justificativa' ? txt.trim() : (ajusteMudou || partidaOk || txt.trim())

  function registrar() {
    if (tipo === 'Justificativa') return onRegistrar('Justificativa', { detalhe: txt.trim() })
    // Ajuste de leitura puro (mudou NF/nome/histórico, sem partida): resolve-se aqui na
    // Conciliação e NÃO vira sugestão de lançamento — só entra no relatório de correções.
    // Por isso o detalhe começa sempre com "Ajuste de leitura" (marcador estável).
    const soAjuste = ajusteMudou && !partidaOk
    onRegistrar('Correção', {
      detalhe: soAjuste
        ? 'Ajuste de leitura' + (txt.trim() ? ` — ${txt.trim()}` : '')
        : (txt.trim() || form.historico),
      ajuste: ajusteMudou ? { entidade: ajuste.entidade.trim(), nf: ajuste.nf.trim(), historico: ajuste.historico.trim() } : null,
      lancamento: partidaOk ? form : null,
      dedut: (partidaOk && destinoEhDespesa) ? { conta: String(destinoConta), valor: Number(form.valor) || 0, tipo: dedutDest } : null,
    })
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo || 'Tratar lançamento'}</h2>
        <div style={{ background: theme.input, borderRadius: 10, padding: '10px 12px', margin: '8px 0 14px', fontSize: 12.5 }}>
          <span style={{ color: theme.sub }}>{lanc.data || '—'} · NF {lanc.leitura.nf || '—'} · {valor}</span>
          <div style={{ color: theme.sub, fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>{lanc.historico}</div>
        </div>

        {!tipo ? (
          <>
            {temResiduo && (
              <div style={{ background: 'rgba(245,166,35,0.10)', border: `1px solid ${theme.yellow}`, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
                <p style={{ fontSize: 12.5, color: theme.text, margin: '0 0 8px' }}><b>Diferença na NF: {money(Math.abs(residuo))}</b> — a NF casa, mas o valor não fecha. Tratar a diferença como:</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1, fontSize: 13 }} onClick={() => tratarDiferenca('desconto')}><i className="ti ti-discount" /> Desconto financeiro</button>
                  <button className="btn btn-ghost" style={{ flex: 1, fontSize: 13 }} onClick={() => tratarDiferenca('juros')}><i className="ti ti-percentage" /> Juros / encargos</button>
                </div>
              </div>
            )}
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>O que você quer fazer com este lançamento?</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setTipo('Justificativa')}><i className="ti ti-flag" /> Justificar</button>
              <button className="btn" style={{ flex: 1 }} onClick={() => setTipo('Correção')}><i className="ti ti-pencil-bolt" /> Corrigir</button>
            </div>
            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10, fontSize: 13 }} onClick={estornarLanc}><i className="ti ti-arrow-back-up" /> Estornar este lançamento (partida inversa)</button>
          </>
        ) : tipo === 'Justificativa' ? (
          <>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 10 }}>Fica registrada na auditoria com seu usuário e a data.</p>
            <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus placeholder="Por que este lançamento está assim (variação esperada, etc.)…" />
          </>
        ) : (
          <>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 10 }}><i className="ti ti-wand" style={{ color: theme.accent, marginRight: 6 }} /><b style={{ color: theme.text }}>Ajustar leitura</b> — arrume o que ajuda o sistema a cruzar (nome, NF, histórico). Fica salvo e é reaplicado.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
              <div style={{ gridColumn: '1 / -1' }}><label>Nome do {lab}</label><input className="input" value={ajuste.entidade} onChange={setAj('entidade')} placeholder={`Nome correto do ${lab}`} /></div>
              <div><label>Número da NF</label><input className="input" value={ajuste.nf} onChange={setAj('nf')} placeholder="Nº da nota" /></div>
              <div />
              <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><textarea className="input" rows={2} value={ajuste.historico} onChange={setAj('historico')} /></div>
            </div>
            {(ajuste.entidade || lanc.leitura?.entidade) && onDesvincular && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: theme.yellow, borderColor: theme.yellow, marginBottom: 10 }}
                title="O sistema uniu este nome com outro parecido por engano. Desvincular mantém este separado — vale para todos os meses."
                onClick={() => onDesvincular(ajuste.entidade || lanc.leitura?.entidade)}>
                <i className="ti ti-arrows-split" /> Desvincular — este {lab} é diferente (não unir com nomes parecidos)
              </button>
            )}

            <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 6 }}>
              <p style={{ fontSize: 12.5, color: theme.sub, margin: '0 0 8px' }}>Partida de acerto (opcional) — vai para o Contabilizar. Atalhos:</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={estornarLanc}><i className="ti ti-arrow-back-up" /> Estornar lançamento</button>
                <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => tratarDiferenca('desconto')}><i className="ti ti-discount" /> Desconto financeiro</button>
                <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => tratarDiferenca('juros')}><i className="ti ti-percentage" /> Juros / encargos</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label>Data</label><input className="input" type="date" value={form.data} onChange={set('data')} /></div>
                <div><label>Valor</label><input className="input" type="number" step="0.01" value={form.valor} onChange={set('valor')} /></div>
                <div><label>Conta débito</label><CampoConta value={form.conta_debito} onChange={v => setForm(f => ({ ...f, conta_debito: v }))} /></div>
                <div><label>Conta crédito</label><CampoConta value={form.conta_credito} onChange={v => setForm(f => ({ ...f, conta_credito: v }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label>Histórico da partida</label><textarea className="input" rows={2} value={form.historico} onChange={set('historico')} /></div>
              </div>
              {destinoEhDespesa && (
                <div style={{ marginTop: 12, background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.4)', borderRadius: 10, padding: '10px 14px' }}>
                  <label style={{ display: 'block', marginBottom: 6, color: theme.text }}>A conta de destino <b>{destinoConta}</b> é <b>despesa</b> — classifique para o LALUR{!lanc.leitura?.nf && <span style={{ color: theme.yellow }}> · sem nota fiscal</span>}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['Dedutível', 'Indedutível'].map(op => (
                      <button key={op} type="button" className={dedutDest === op ? 'btn' : 'btn btn-ghost'}
                        style={{ fontSize: 12.5, padding: '6px 12px', flex: 1, ...(op === 'Indedutível' && dedutDest === op ? { background: theme.yellow, borderColor: theme.yellow } : {}) }}
                        onClick={() => setDedutDest(op)}>{op}</button>
                    ))}
                  </div>
                  <p style={{ color: theme.sub, fontSize: 11.5, margin: '8px 0 0' }}><b style={{ color: theme.yellow }}>Indedutível</b> entra como <b>adição</b> no LALUR. Sem nota fiscal, o padrão é indedutível.</p>
                </div>
              )}
            </div>

            <div style={{ marginTop: 12 }}><label>Observação na auditoria (opcional)</label><input className="input" value={txt} onChange={e => setTxt(e.target.value)} placeholder="O que estava errado / o que foi corrigido…" /></div>
          </>
        )}

        {tipo && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={() => setTipo(null)}><i className="ti ti-chevron-left" /> Voltar</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
              <button className="btn" disabled={!podeRegistrar} onClick={registrar}>Registrar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ContaSelect({ value, onChange, plano }) {
  if (plano?.length) return (
    <select className="input" value={value} onChange={onChange}>
      <option value="">— conta —</option>
      {plano.map(p => <option key={p.cod} value={p.cod}>{p.cod} · {p.nome}</option>)}
    </select>
  )
  return <input className="input" value={value} onChange={onChange} placeholder="Código da conta" />
}

const numCell = v => { if (typeof v === 'number') return v; const s = String(v ?? '').trim(); if (/^-?[\d.]+,\d{2}$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.')); const n = parseFloat(s.replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n }

// Lê o saldo do documento suporte (Excel) de forma PREVISÍVEL, em ordem:
// 1) uma célula rotulada SALDO / TOTAL (não "anterior") → valor ao lado ou abaixo;
// 2) senão, a SOMA de uma coluna de valor (cabeçalho Valor/Saldo/Total/Em aberto…);
// 3) senão, o último número do arquivo (palpite — o comportamento antigo).
// Se o usuário destacou uma célula em AMARELO no extrato, lê o número dela (é o
// jeito mais direto de apontar o saldo). Precisa de cellStyles ao ler o arquivo.
// Etiqueta do lançamento gerado pela plataforma (linha "acerto" na conciliação).
// Antes tudo virava "estorno"; agora reflete a ORIGEM: apropriação de seguro/despesa
// não é estorno — só correção/estorno de fato leva essa etiqueta.
function tagAcertoLanc(l) {
  const o = String(l?.origem || '')
  if (o === 'seguro' || o === 'despesa') return { txt: 'apropriação', icon: 'ti-calendar-repeat', titulo: 'Apropriação gerada pela plataforma' }
  if (o === 'correcao' || o === 'estorno') return { txt: 'estorno', icon: 'ti-arrow-back-up', titulo: 'Lançamento de acerto (estorno/correção)' }
  return { txt: 'lançamento', icon: 'ti-file-plus', titulo: 'Lançamento gerado pela plataforma' }
}

function saldoCelulaAmarela(ws, XLSX) {
  if (!ws || !ws['!ref']) return null
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      const s = cell && cell.s
      if (!s || !s.patternType || s.patternType === 'none') continue
      const rgb = s.fgColor && s.fgColor.rgb
      if (!rgb) continue
      const hex = String(rgb).replace(/[^0-9a-fA-F]/g, '').slice(-6).padStart(6, '0')
      const R = parseInt(hex.slice(0, 2), 16), G = parseInt(hex.slice(2, 4), 16), B = parseInt(hex.slice(4, 6), 16)
      // "Amarelo" no sentido amplo: destaque quente (amarelo/tan/laranja) — o azul fica
      // bem abaixo do vermelho e do verde. Cobre desde amarelo puro (FFFF00) até o
      // amarelo-claro do Google Sheets (F9E79F). Ignora branco e cinzas.
      const quente = R > 150 && G > 130 && B < Math.min(R, G) * 0.85 && (R + G) / 2 - B > 35
      if (quente) { const n = numCell(cell.v); if (n) return n } // célula destacada em amarelo
    }
  }
  return null
}

// Se o usuário colocou um COMENTÁRIO numa célula (ex.: "saldo do extrato"), usa isso
// como sinal de onde está o saldo. Preferência: o número da PRÓPRIA célula comentada;
// se ela não for número, tenta ler um número do texto do comentário. Precisa de
// cellStyles ao ler o arquivo (o SheetJS popula cell.c com os comentários).
function saldoCelulaComentario(ws, XLSX) {
  if (!ws || !ws['!ref']) return null
  const range = XLSX.utils.decode_range(ws['!ref'])
  let doTexto = null
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (!cell || !cell.c || !cell.c.length) continue
      const n = numCell(cell.v)
      if (n) return n // a própria célula comentada é número → é o saldo
      // guarda um palpite pelo texto do comentário (usa só se nenhuma célula comentada for número)
      if (doTexto == null) { const t = cell.c.map(x => x && x.t).join(' '); const m = numCell(t); if (m) doTexto = m }
    }
  }
  return doTexto
}

function lerSaldoDocumento(arr, alvo) {
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
  // 0) O saldo do balancete (alvo) aparece no extrato? Procura o número MAIS PRÓXIMO
  //    do saldo da conta. Se bater (diferença ≤ 5 centavos), é o saldo do documento.
  if (alvo != null && Math.abs(alvo) > 0.005) {
    let best = null
    for (const row of (arr || [])) for (const cel of (row || [])) {
      const n = numCell(cel); if (!n) continue
      const d = Math.min(Math.abs(n - alvo), Math.abs(-n - alvo))
      if (best == null || d < best.d) best = { valor: Math.abs(Math.abs(n) - Math.abs(alvo)) <= 0.05 ? (alvo < 0 ? -Math.abs(n) : Math.abs(n)) : n, d }
    }
    if (best && best.d <= 0.05) return { valor: best.valor, via: 'valor do extrato que bate com o saldo da conta (≤ 5 centavos)' }
  }
  // 1) célula rotulada
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i] || []
    for (let j = 0; j < row.length; j++) {
      const t = norm(row[j])
      if (!t || /anterior/.test(t) || t.length > 26) continue
      if (/\b(saldo|total|montante)\b/.test(t)) {
        for (let k = j + 1; k < row.length; k++) { const n = numCell(row[k]); if (n) return { valor: n, via: `célula "${String(row[j]).trim()}"` } }
        const ab = arr[i + 1] ? numCell(arr[i + 1][j]) : 0; if (ab) return { valor: ab, via: `célula "${String(row[j]).trim()}"` }
      }
    }
  }
  // 2) soma de uma coluna de valor
  let hi = -1, col = -1
  for (let i = 0; i < Math.min(arr.length, 15); i++) {
    const j = (arr[i] || []).findIndex(c => /valor|saldo|total|aberto|liquido|montante/i.test(String(c ?? '')))
    if (j >= 0) { hi = i; col = j; break }
  }
  if (col >= 0) {
    let soma = 0, n = 0
    for (let i = hi + 1; i < arr.length; i++) { const v = numCell(arr[i]?.[col]); if (v) { soma += v; n++ } }
    if (n) return { valor: Math.round(soma * 100) / 100, via: `soma da coluna "${String(arr[hi][col]).trim()}" (${n} linha(s))` }
  }
  // 3) fallback: último número
  let ultimo = null
  for (const row of arr) for (const cel of row) { const x = numCell(cel); if (x) ultimo = x }
  return ultimo != null ? { valor: ultimo, via: 'último número do arquivo (palpite)' } : null
}
function Mini({ label, v, cor }) {
  return <div><p style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', margin: 0 }}>{label}</p><p style={{ color: cor || theme.text, fontSize: 15, fontWeight: 600, margin: '2px 0 0' }}>{v}</p></div>
}

function ImpostoCards({ conta }) {
  const [mem, setMem] = useState(null)
  const [erro, setErro] = useState('')
  const baixaAnterior = Number(conta.saldo_inicial) || 0
  const recolhido = Number(conta.debito) || 0
  // Saldo anterior vem em D−C: imposto a recolher é CRÉDITO (negativo). O recolhido é um
  // DÉBITO que ABATE esse saldo — então a diferença é saldo + recolhido (resíduo do mês
  // anterior). Antes era saldo − recolhido, que somava as duas grandezas (parecia dobrado).
  const baixaDif = baixaAnterior + recolhido
  const baixaOk = Math.abs(baixaDif) < 0.01
  const aRecolher = Number(conta.saldo_final) || 0

  async function aoEscolher(e) {
    const f = e.target.files?.[0]; if (!f) return; setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      let tot = 0
      for (const r of arr) for (const c of r) { const n = numCell(c); if (n) { tot += n; break } }
      setMem({ nome: f.name, total: tot })
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  const memDif = mem ? mem.total - aRecolher : 0
  const memOk = mem && Math.abs(memDif) < 0.01

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <div style={{ background: theme.card, border: `1px solid ${baixaOk ? 'rgba(48,164,108,0.4)' : 'rgba(229,72,77,0.4)'}`, borderRadius: 12, padding: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px' }}>Baixa do imposto do mês anterior</p>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Mini label="Saldo anterior (a recolher)" v={money(baixaAnterior)} />
          <Mini label="Recolhido no mês (débito)" v={money(recolhido)} />
          <Mini label="Diferença" v={money(baixaDif)} cor={baixaOk ? theme.green : theme.red} />
        </div>
        <p style={{ fontSize: 12.5, color: baixaOk ? theme.green : theme.red, margin: '10px 0 0' }}>
          <i className={`ti ${baixaOk ? 'ti-circle-check' : 'ti-alert-triangle'}`} /> {baixaOk ? 'Baixa conferida — o imposto do mês anterior foi recolhido e zerou.' : 'Divergência na baixa — justifique ou corrija (gera D imposto / C banco).'}
        </p>
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 6px' }}>Memória de cálculo</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 10px' }}>Importe a memória e compare com o balancete (imposto a recolher: {money(aRecolher)}).</p>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} style={{ fontSize: 13, color: theme.sub }} />
        {erro && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 8 }}>{erro}</p>}
        {mem && (
          <div style={{ marginTop: 12 }}>
            <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 8px' }}><i className="ti ti-file-spreadsheet" /> {mem.nome}</p>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <Mini label="Memória" v={money(mem.total)} />
              <Mini label="Balancete" v={money(aRecolher)} />
              <Mini label="Diferença" v={money(memDif)} cor={memOk ? theme.green : theme.yellow} />
            </div>
            {memOk
              ? <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> Memória bate com o balancete.</p>
              : <p style={{ color: theme.yellow, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-alert-triangle" /> Divergência: houve recolhimento no mês? houve PER/DCOMP? Justifique ou corrija acima.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

const th ={ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const thR = { ...th, textAlign: 'right' }
const td = { padding: '11px 14px', fontSize: 12.5, color: theme.text, verticalAlign: 'top' }
const tdR = { ...td, textAlign: 'right', whiteSpace: 'nowrap' }

function Dot({ c }) { return <span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: c }} /> }
function Tile({ label, v, cor, onClick, hint }) {
  return (
    <div onClick={onClick} title={onClick ? (hint || 'Ver composição') : undefined}
      style={{ background: theme.input, borderRadius: 10, padding: 14, cursor: onClick ? 'pointer' : 'default', border: `1px solid ${onClick ? theme.cb : 'transparent'}` }}>
      <p style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4, margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
        {label}{onClick && <i className="ti ti-eye" style={{ fontSize: 12, color: theme.accent }} />}
      </p>
      <p style={{ color: cor || theme.text, fontSize: 15, fontWeight: 600, margin: '4px 0 0' }}>{v}</p>
    </div>
  )
}
function Wrapper({ children, nome, comp }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Conciliação de Contas</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        {nome ? <>Estrutura de balancete (Ativo e Passivo) com contas sintéticas e analíticas. <b style={{ color: theme.text }}>{nome}</b> · {comp}. Clique numa conta analítica para ver a composição.</> : 'Estrutura de balancete (Ativo e Passivo).'}
      </p>
      {children}
    </div>
  )
}
function Aviso({ texto, icon = 'ti-building' }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 580 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
