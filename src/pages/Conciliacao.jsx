import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money, moneyDC } from '../lib/theme'
import { montarBalancete, parsePlano, composicaoAbertura } from '../lib/balancete'
import { abrePdfTimbrado } from '../lib/pdf'
import { gerarExcelTimbrado } from '../lib/excel'
import CampoConta from '../components/CampoConta'

// Diferença de conciliação respeitando a NATUREZA da conta. O documento (guia,
// extrato, relatório) vem SEMPRE positivo. Numa conta DEVEDORA (saldo > 0) a
// diferença é saldo − documento; numa conta CREDORA (saldo < 0) é saldo + documento.
// Assim, quando |saldo| == |documento|, a diferença é zero — não importa o sinal.
// Ex.: FGTS a pagar 1.600 C com guia de 1.600 → diferença 0.
function difConciliacao(saldo, doc) {
  const s = Number(saldo) || 0
  const v = Math.abs(Number(doc) || 0)
  const nat = s < 0 ? -1 : 1 // credora subtrai o documento (soma ao saldo negativo)
  return Math.round((s - nat * v) * 100) / 100
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
  const grupos = {}, nomes = []
  for (const l of lancs) {
    const k = l.leitura?.ident && l.leitura.entidade ? l.leitura.entidade : '(não identificado)'
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
  for (const nf in porNF) {
    const grp = porNF[nf]
    const temD = grp.some(l => Number(l.debito) > 0.005)
    const temC = grp.some(l => Number(l.credito) > 0.005)
    if (!temD || !temC) continue // precisa de débito e crédito na mesma NF
    if (Math.abs(grp.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)) >= 0.005) continue // não zera
    // Cliente tem que bater (nome aproximado) entre os lançamentos da NF.
    const nomes = [...new Set(grp.map(l => (l.leitura?.ident && l.leitura.entidade) ? l.leitura.entidade : null).filter(Boolean))]
    let mesmoCli = true
    for (let i = 1; i < nomes.length; i++) if (!mesmoCliente(tokensNome(nomes[0]), tokensNome(nomes[i]))) { mesmoCli = false; break }
    if (!mesmoCli) continue
    for (const l of grp) baixados.add(l)
    const strs = [...new Set(grp.map(l => String(l.leitura?.nf ?? '').trim()).filter(Boolean))]
    if (strs.length > 1) aproximadas.push(strs.join(' = ')) // NFs diferentes em texto, iguais ignorando zeros
  }
  return { baixados, aproximadas }
}

// Natureza invertida do SALDO da conta (não redutora):
// 'credor' = conta do Ativo (1) com saldo credor; 'devedor' = Passivo (2) com saldo devedor.
function saldoInvertido(classifRaw, nome, saldoFinal) {
  if (ehRedutora(nome)) return null
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
  const [contas, setContas] = useState([])
  const [conf, setConf] = useState({}) // conta -> registro conciliacao_conta
  const [acertos, setAcertos] = useState({}) // conta -> ajuste (soma dos lançamentos de acerto pendentes)
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null) // conta selecionada (detalhe)
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
    setSel(null); setContas([]); setCompId(null); setConf({})
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
        setContas(ap.map(l => ({ ...l, conta: l.reduzido })))
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

  if (!empresaId) return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral." /></Wrapper>
  if (carregando) return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  if (!compId || contas.length === 0) return <Wrapper><Aviso icon="ti-table-off" texto="Nenhum balancete nesta competência. Importe o razão primeiro." /></Wrapper>

  if (sel) return <Detalhe conta={sel} tipoCta={tipoEf(sel)} reg={conf[sel.conta]} compId={compId} empresaId={empresaId} usuario={user?.email} ajuste={acertos[sel.conta] || null} getCompetenciaId={getCompetenciaId} onSalvarConf={recarregar} onMudou={recarregar} onVoltar={() => setSel(null)} />

  // A SINTÉTICA é a soma das ANALÍTICAS: as correções/estornos pendentes ficam nas
  // analíticas (acertos por conta), então acumulamos o ajuste nas sintéticas ancestrais
  // (classificação que é prefixo) para o total refletir os estornos feitos embaixo.
  const ajSintMap = (() => {
    const map = {}
    const sints = contas.filter(c => c.sintetica)
    for (const a of contas) {
      if (a.sintetica) continue
      const aj = ajNet(a)
      if (Math.abs(aj) < 0.005) continue
      const ar = String(a.classifRaw || a.classif)
      for (const s of sints) {
        const sr = String(s.classifRaw || s.classif)
        if (ar !== sr && ar.startsWith(sr)) map[sr] = (map[sr] || 0) + aj
      }
    }
    return map
  })()
  const ajTotal = c => c.sintetica ? (ajSintMap[String(c.classifRaw || c.classif)] || 0) : ajNet(c)
  const saldoEfAll = c => (Number(c.saldo_final) || 0) + ajTotal(c)

  return (
    <Wrapper nome={empresaNome} comp={competencia}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12, color: theme.sub, flexWrap: 'wrap' }}>
        <span><Dot c={theme.red} /> Pendente (padrão)</span>
        <span><Dot c={theme.yellow} /> Confirmada + justificada (sem documento)</span>
        <span><Dot c={theme.green} /> Documento bate com o saldo</span>
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
            {contas.map((c, i) => {
              const sint = c.sintetica
              const peso = sint ? 700 : 400 // só as sintéticas em negrito
              const t = tipoEf(c)
              const inv = sint ? null : saldoInvertido(c.classifRaw, c.nome, c.saldo_final)
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
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.debito)}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.credito)}</td>
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

function Detalhe({ conta, tipoCta, reg, compId, empresaId, usuario, ajuste = null, getCompetenciaId, onSalvarConf, onMudou, onVoltar }) {
  const ajDeb = ajuste?.deb || 0, ajCred = ajuste?.cred || 0, ajNet = ajDeb - ajCred // correções pendentes
  const [lanc, setLanc] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [acao, setAcao] = useState(null)   // lançamento clicado (justificar/corrigir)
  const [verCorr, setVerCorr] = useState(null) // lançamento já tratado (ver o que foi feito / desfazer)
  const [plano, setPlano] = useState([])   // [{ cod, nome }] para os seletores de conta
  const [partidas, setPartidas] = useState({}) // chave (data|histórico) -> lançamentos da partida (p/ contrapartida)
  const [msg, setMsg] = useState('')
  const [tratados, setTratados] = useState(new Set()) // razao_ids já corrigidos/estornados/justificados

  async function carregarTratados() {
    const { data } = await supabase.from('auditoria').select('razao_id')
      .eq('competencia_id', compId).eq('modulo', 'Conciliação').not('razao_id', 'is', null)
    setTratados(new Set((data || []).map(a => a.razao_id)))
  }
  useEffect(() => { carregarTratados() }, [compId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function carregarLanc() {
    setCarregando(true)
    const [{ data: rz }, { data: aj }, { data: acs }, abertura] = await Promise.all([
      supabase.from('razao').select('id, data, contrapartida, historico, debito, credito').eq('competencia_id', compId).eq('conta', conta.conta).order('data'),
      supabase.from('ajuste_leitura').select('razao_id, nf, entidade, historico').eq('competencia_id', compId),
      supabase.from('lancamentos').select('id, data, conta_debito, conta_credito, valor, historico, razao_id').eq('competencia_id', compId),
      composicaoAbertura(empresaId, compId, conta.conta, conta.classifRaw),
    ])
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
        return { ...base, acerto: true, razaoRef: a.razao_id || null }
      })
    // Títulos de abertura (saldo anterior) primeiro; depois o movimento do mês; por fim os acertos.
    setLanc([...(abertura || []), ...(rz || []).map(l => aplicarAjuste(l, ajById[l.id])), ...acertoLancs])
    setCarregando(false)
  }
  useEffect(() => { carregarLanc() }, [compId, conta.conta]) // eslint-disable-line react-hooks/exhaustive-deps

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
      .then(({ data }) => setPlano(parsePlano(data?.dados).map(p => ({ cod: p.reduzido, nome: p.nome })).filter(p => p.cod)))
  }, [empresaId])

  const planoMap = Object.fromEntries(plano.map(p => [p.cod, p.nome]))

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
  // Saldo efetivo (balancete + acertos) para amarrar com a composição, que já inclui os acertos.
  const dif = (Number(conta.saldo_final) || 0) + ajNet - somaComp

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

  // Agrupa só o que está EM ABERTO (não baixado) por nome; incerto cai em "(não identificado)".
  const grupos = {}, nomes = []
  for (const l of lanc) {
    if (baixados.has(l)) continue
    if (Math.abs(ov(l)) < 0.005) continue
    const key = l.leitura.ident && l.leitura.entidade ? l.leitura.entidade : '(não identificado)'
    if (!grupos[key]) { grupos[key] = []; nomes.push(key) }
    grupos[key].push(l)
  }
  // Unifica nomes parecidos (mesmo cliente escrito de formas diferentes) em um cluster.
  const idents = nomes.filter(k => k !== '(não identificado)')
  const tk = Object.fromEntries(idents.map(k => [k, tokensNome(k)]))
  const clusters = []
  for (const k of idents) {
    const alvo = clusters.find(cl => cl.membros.some(m => mesmoCliente(tk[k], tk[m])))
    if (alvo) alvo.membros.push(k); else clusters.push({ membros: [k] })
  }
  const lista = clusters.map(cl => {
    const membros = cl.membros.slice().sort((a, b) => b.length - a.length)
    const lancs = cl.membros.flatMap(m => grupos[m])
    return { nome: membros[0], variacoes: membros, lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: membros.length > 1, unk: false }
  })
  if (grupos['(não identificado)']) {
    const lancs = grupos['(não identificado)']
    lista.push({ nome: '(não identificado)', variacoes: [], lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: false, unk: true })
  }
  lista.sort((a, b) => (a.unk ? 1 : 0) - (b.unk ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'))
  const algoEmAberto = lista.length > 0

  // Para os relatórios: o que está em aberto (compõe o saldo) e o que zerou (baixado por NF).
  const ehEntidade = ehEntidadeConta
  const emAbertoTodos = ehEntidade ? lista.flatMap(g => g.lancs) : lanc.filter(l => Math.abs(ov(l)) >= 0.005)
  const zerados = [...baixados]

  const revs = lanc.filter(l => Math.abs(ov(l)) >= 0.005 && l.leitura.conf !== 'alta').length

  // Anomalia de natureza: conta de cliente (Ativo) deve ficar devedora; fornecedor (Passivo) credora.
  // Um grupo com total na natureza invertida (total < 0) é estranho e precisa ser verificado.
  const natAnom = natCredito ? 'devedor' : 'credor'   // saldo que é ANÔMALO nesta conta
  const natOk = natCredito ? 'credora' : 'devedora'   // natureza esperada da conta
  const anomalos = lista.filter(x => x.total < -0.005).map(x => x.nome)
  const unificados = lista.filter(x => x.unido).length
  const contaInvertida = Number(conta.saldo_final) * (natCredito ? -1 : 1) < -0.005

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

  async function registrar(tipo, payload) {
    const id = await getCompetenciaId()
    // Trava: um lançamento só pode ter UMA correção/estorno por vez. Se já houver,
    // bloqueia — para refazer, o usuário abre a linha (já tratada) e clica em Desfazer.
    if (payload.lancamento && acao?.id) {
      const { count } = await supabase.from('lancamentos').select('id', { count: 'exact', head: true })
        .eq('competencia_id', id).eq('razao_id', acao.id)
      if (count) {
        setAcao(null)
        setMsg('Este lançamento já foi corrigido/estornado. Abra a linha (marcada como "corrigido") e clique em "Desfazer" antes de refazer.')
        return
      }
    }
    const item = `${conta.conta} · ${acao?.data || ''} · NF ${acao?.leitura.nf || '—'}`
    await supabase.from('auditoria').insert({ competencia_id: id, modulo: 'Conciliação', item, tipo, detalhe: payload.detalhe || null, razao_id: acao?.id || null, usuario })
    let virouLancamento = false
    if (tipo === 'Correção' && payload.lancamento && (payload.lancamento.conta_debito || payload.lancamento.conta_credito)) {
      const L = payload.lancamento
      await supabase.from('lancamentos').insert({
        competencia_id: id, data: L.data || null,
        conta_debito: L.conta_debito || null, conta_credito: L.conta_credito || null,
        valor: Number(L.valor) || 0, historico: L.historico || null,
        documento: acao?.leitura.nf ? `NF ${acao.leitura.nf}` : null,
        origem: 'correcao', razao_id: acao?.id || null, usuario,
      })
      virouLancamento = true
    }
    // Ajuste de leitura (nome/NF/histórico) — ajuda o sistema a cruzar; reaplicado sempre.
    let ajustouLeitura = false
    const aj = payload.ajuste
    if (aj && acao?.id && (aj.nf || aj.entidade || aj.historico)) {
      await supabase.from('ajuste_leitura').upsert({
        competencia_id: id, razao_id: acao.id,
        nf: aj.nf || null, entidade: aj.entidade || null, historico: aj.historico || null, usuario,
      }, { onConflict: 'razao_id' })
      ajustouLeitura = true
    }
    setMsg(ajustouLeitura ? 'Leitura ajustada — o sistema vai recruzar.' : virouLancamento ? 'Correção registrada — lançamento enviado para o painel Contabilizar.' : `${tipo} registrada na auditoria.`)
    if (acao?.id) setTratados(prev => new Set(prev).add(acao.id)) // marca a linha como tratada na hora
    setAcao(null)
    carregarTratados()
    if (virouLancamento) { onMudou && onMudou(); carregarLanc() } // atualiza saldo e mostra o acerto na composição
    else if (ajustouLeitura) carregarLanc()
  }

  // Desfazer uma correção/estorno: remove o lançamento de acerto e o registro de
  // auditoria daquela linha; a linha volta a ficar pendente e o saldo se reverte.
  async function desfazerCorrecao(razaoId) {
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
    tratados.has(l.id) ? setVerCorr(l) : setAcao(l)
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span onClick={onVoltar} style={{ color: '#8FB0FF', fontSize: 13, cursor: 'pointer' }}><i className="ti ti-chevron-left" /> Conciliação</span>
          <span style={{ color: theme.sub }}>/</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{conta.conta} · {conta.nome}</span>
        </div>
        <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-click" /> Clique num lançamento para justificar ou corrigir.</span>
      </div>

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 12 }}><i className="ti ti-circle-check" /> {msg}</p>}

      {/* Resumo + amarração — débito/crédito/saldo já incluem as correções pendentes. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: Math.abs(ajNet) > 0.005 ? 6 : 16 }}>
        <Tile label="Saldo inicial" v={moneyDC(conta.saldo_inicial)} />
        <Tile label="Débito" v={money((Number(conta.debito) || 0) + ajDeb)} cor={theme.green} />
        <Tile label="Crédito" v={money((Number(conta.credito) || 0) + ajCred)} cor={theme.red} />
        <Tile label="Saldo atual" v={moneyDC((Number(conta.saldo_final) || 0) + ajNet)} />
        <Tile label="Diferença (amarração)" v={money(dif)} cor={Math.abs(dif) < 0.01 ? theme.green : theme.yellow} />
      </div>
      {Math.abs(ajNet) > 0.005 && <p style={{ color: theme.accent, fontSize: 11.5, margin: '0 0 16px' }}>
        <i className="ti ti-adjustments-alt" /> Débito, crédito e saldo já incluem {moneyDC(ajNet)} de correções pendentes de contabilização (balancete: débito {money(conta.debito)} · crédito {money(conta.credito)} · saldo {moneyDC(conta.saldo_final)}).
      </p>}

      {/* Natureza do saldo: Ativo credor / Passivo devedor (sem ser redutora) */}
      {(() => {
        const inv = saldoInvertido(conta.classifRaw, conta.nome, conta.saldo_final)
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
      <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '4px 0 10px' }}>
        O que compõe o saldo — por {lab}
      </p>

      {anomalos.length > 0 && (
        <div style={{ background: 'rgba(229,72,77,0.10)', border: `1px solid ${theme.red}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-alert-octagon" style={{ color: theme.red, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>
            {anomalos.length} {lab}(s) com saldo <b>{natAnom}</b> (natureza invertida) — verifique{anomalos.length <= 4 ? `: ${anomalos.join(', ')}` : ''}.
          </span>
        </div>
      )}

      {totalSemTitulo > 0 && (
        <div style={{ background: 'rgba(229,72,77,0.10)', border: `1px solid ${theme.red}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-receipt-off" style={{ color: theme.red, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{totalSemTitulo} baixa(s) com NF que não confere com nenhum título deste {lab} — para o saldo zerar, a NF do recebimento tem que ser a mesma do faturamento.</span>
        </div>
      )}

      {aproximadas.length > 0 && (
        <div style={{ background: 'rgba(74,124,255,0.10)', border: `1px solid ${theme.accent}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-discount-check" style={{ color: theme.accent, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{aproximadas.length} baixa(s) conciliada(s) por <b>NF aproximada</b> (mesmo número ignorando zeros à esquerda) — confirme: {aproximadas.slice(0, 4).join('; ')}. Veja no relatório “Conciliados”.</span>
        </div>
      )}

      {unificados > 0 && (
        <div style={{ background: 'rgba(74,124,255,0.10)', border: `1px solid ${theme.accent}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-arrows-join" style={{ color: theme.accent, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{unificados} {lab}(s) com nomes parecidos foram <b>unificados</b> — confira se é mesmo o mesmo {lab} (veja “nomes unidos” em cada card).</span>
        </div>
      )}

      {revs > 0 && (
        <div style={{ background: 'rgba(245,166,35,0.10)', border: `1px solid ${theme.yellow}`, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-alert-triangle" style={{ color: theme.yellow, fontSize: 18 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{revs} lançamento(s) com leitura incerta — corrija o {lab} para o sistema aprender.</span>
        </div>
      )}

      {carregando ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : lanc.length === 0 ? (
        <Aviso icon="ti-inbox" texto="Sem lançamentos nesta conta." />
      ) : !algoEmAberto ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <i className="ti ti-circle-check" style={{ fontSize: 22, color: theme.green }} />
          <p style={{ fontSize: 13.5, color: theme.text, margin: 0 }}>Nada em aberto — débitos e créditos se conciliaram por NF (saldo zerado). Anexe o relatório de {natCredito ? 'contas a pagar' : 'contas a receber'} ou justifique no card acima.</p>
        </div>
      ) : lista.map((g, gi) => {
        const grp = g.lancs
        const gt = g.total
        const unk = g.unk
        const semTit = baixaSemTitulo(g) // baixas com NF que não casa com título
        const hasRev = grp.some(l => l.leitura.conf !== 'alta')
        const anom = gt < -0.005 // natureza invertida (cliente credor / fornecedor devedor)
        const borda = (anom || semTit.size > 0) ? theme.red : hasRev ? theme.yellow : theme.cb
        return (
          <div key={gi} style={{ background: theme.card, border: `1px solid ${borda}`, borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', background: theme.input, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: unk ? theme.yellow : theme.text, fontSize: 14, fontWeight: 600, fontStyle: unk ? 'italic' : 'normal' }}>{g.nome}</span>
                {g.unido && <span title={`Nomes unidos: ${g.variacoes.join(' · ')}`} style={{ background: 'rgba(74,124,255,0.18)', color: theme.accent, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3, cursor: 'help' }}><i className="ti ti-arrows-join" /> {g.variacoes.length} nomes unidos</span>}
                {anom && <span style={{ background: 'rgba(229,72,77,0.18)', color: theme.red, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3 }}><i className="ti ti-alert-octagon" /> saldo {natAnom}</span>}
              </span>
              <span style={{ color: anom ? theme.red : theme.text, fontSize: 14, fontWeight: 600 }}>{money(gt)}</span>
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
                      style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', opacity: (l.acerto || tratados.has(l.id)) ? 0.7 : 1, background: (l.acerto || tratados.has(l.id)) ? 'rgba(48,164,108,0.08)' : semNF ? 'rgba(229,72,77,0.08)' : 'transparent' }}
                      title={l.acerto ? 'Lançamento de acerto (estorno/correção) — clique para ver ou desfazer' : tratados.has(l.id) ? 'Já tratado — clique para ver o que foi feito ou desfazer' : semNF ? 'Baixa com NF que não confere com o título — justifique ou corrija' : 'Justificar ou corrigir este lançamento'}>
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
                          ? <span title="Lançamento de acerto (estorno/correção)" style={{ color: theme.accent, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-arrow-back-up" /> estorno</span>
                          : tratados.has(l.id)
                            ? <span title="Já tratado" style={{ color: theme.green, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-arrow-back-up" /> corrigido</span>
                            : semNF
                              ? <span title="NF não confere com nenhum título" style={{ color: theme.red, fontSize: 10.5, fontWeight: 700 }}>NF s/ título</span>
                              : rev
                                ? <span style={{ color: theme.yellow, fontSize: 11, fontWeight: 600 }}>revisar</span>
                                : <span style={{ color: theme.green, fontSize: 14 }}><i className="ti ti-circle-check" /></span>}
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
      </>
      ) : (
        <ListaLancamentos lanc={emAbertoTodos} carregando={carregando} contraDe={contraDe} planoMap={planoMap} tratados={tratados} onTratar={abrirLinha} />
      )}

      {acao && (
        <ModalLancamento lanc={acao} conta={conta} lab={lab} plano={plano} natCredito={natCredito}
          residuo={ehEntidadeConta ? residuoNF(acao) : 0}
          onClose={() => setAcao(null)} onRegistrar={registrar} />
      )}
      {verCorr && (
        <ModalCorrigido linha={verCorr} conta={conta} compId={compId} planoMap={planoMap}
          onClose={() => setVerCorr(null)} onDesfazer={() => desfazerCorrecao(verCorr.id)} />
      )}
    </Wrapper>
  )
}

// Lista simples dos lançamentos de uma conta de composição que NÃO é por entidade
// (ex.: IRRF s/ aplicação): sem nome/NF/agrupamento; cada lançamento é clicável.
function ListaLancamentos({ lanc, carregando, contraDe, planoMap, tratados = new Set(), onTratar }) {
  return (
    <>
      <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '4px 0 10px' }}>Lançamentos da conta</p>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Data</th><th style={th}>Histórico</th><th style={th}>Contrapartida</th>
              <th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={{ ...th, textAlign: 'center' }}>Ação</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr><td colSpan={6} style={{ ...td, color: theme.sub }}>Carregando…</td></tr>
            ) : lanc.length === 0 ? (
              <tr><td colSpan={6} style={{ ...td, color: theme.sub }}>Sem lançamentos nesta conta.</td></tr>
            ) : lanc.map((l, i) => {
              const contras = contraDe(l)
              return (
                <tr key={i} onClick={() => onTratar(l)} style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', opacity: (l.acerto || tratados.has(l.id)) ? 0.7 : 1, background: (l.acerto || tratados.has(l.id)) ? 'rgba(48,164,108,0.08)' : 'transparent' }} title={l.acerto ? 'Lançamento de acerto (estorno/correção) — clique para ver ou desfazer' : tratados.has(l.id) ? 'Já tratado — clique para ver ou desfazer' : 'Justificar ou corrigir este lançamento'}>
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
                    ? <span title="Lançamento de acerto (estorno/correção)" style={{ color: theme.accent, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-arrow-back-up" /> estorno</span>
                    : tratados.has(l.id)
                      ? <span title="Já tratado" style={{ color: theme.green, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}><i className="ti ti-arrow-back-up" /> corrigido</span>
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
        // Extrato em PDF (ex.: extrato bancário do cliente).
        const { extrairTextoPdf, palpiteSaldo, ocrPdf } = await import('../lib/pdfText')
        const texto = await extrairTextoPdf(file)
        let s = palpiteSaldo(texto, saldo)
        setDoc(file.name)
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
          setErro('Li o PDF, mas não identifiquei o saldo automaticamente — confira e digite o saldo abaixo.')
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
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label>Documento suporte <span style={{ color: theme.sub, fontWeight: 400 }}>(Excel ou PDF do extrato)</span></label><input type="file" accept=".xlsx,.xls,.csv,.pdf" onChange={e => lerArquivo(e.target.files?.[0])} style={{ fontSize: 13, color: theme.sub, display: 'block' }} /></div>
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
function ModalLancamento({ lanc, conta, lab, plano, natCredito, residuo = 0, onClose, onRegistrar }) {
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
  const baixaDif = baixaAnterior - recolhido
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
function Tile({ label, v, cor }) {
  return (
    <div style={{ background: theme.input, borderRadius: 10, padding: 14 }}>
      <p style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4, margin: 0 }}>{label}</p>
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
