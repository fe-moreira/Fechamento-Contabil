import { supabase } from './supabase'

// Arrasto da COMPOSIÇÃO de saldo: computa os títulos/lançamentos ainda EM ABERTO de uma
// conta (cliente/fornecedor) ao FIM de uma competência, para virarem a composição de
// abertura ("saldo anterior") do mês seguinte. O casamento é por NF + entidade — a mesma
// regra da Conciliação. Os helpers abaixo são cópia fiel dos da tela Conciliacao.jsx:
// se aquela regra mudar, atualize aqui também (fonte compartilhada intencionalmente
// isolada para não arriscar a tela de conciliação, que já funciona).

const RUIDO = /\b(VENDA|VENDAS|COMPRA|COMPRAS|PAGTO|PAGAMENTO|RECEBIMENTO|RECEBTO|REF|REFERENTE|NOTA|FISCAL|DUPLICATA|DUPL|BOLETO|TITULO|TÍTULO|VLR|VALOR|PARCELA|PARC|CONF|S\/|A|DE|DA|DO|DOS|DAS|E|NO|NA|EM)\b/ig
const tiraSufixo = e => e.replace(/\s+(S[./]?\s?A\.?|LTDA\.?|EIRELI|EPP|ME)\b.*$/i, '').replace(/\s+/g, ' ').trim()

const GENERICAS = new Set(['COMPANHIA', 'CIA', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'ENERGIA', 'ENERGIAS', 'ELETRICA', 'ELETRICAS', 'FORCA', 'LUZ', 'COMERCIO', 'COMERCIAL', 'INDUSTRIA', 'INDUSTRIAL', 'SERVICO', 'SERVICOS', 'BRASIL', 'NACIONAL', 'GRUPO', 'HOLDING', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'TRANSPORTE', 'TRANSPORTES', 'LOGISTICA', 'SOLUCOES', 'TECNOLOGIA', 'SISTEMAS', 'ASSOCIACAO', 'INSTITUTO', 'FUNDACAO', 'BANCO', 'SUPERMERCADO', 'SUPERMERCADOS', 'ALIMENTOS',
  'SERV', 'PROPAGANDA', 'CUMULATIVO', 'ACUM', 'PREST', 'PRESTACAO', 'CONTABIL', 'CONTABEIS', 'CONTABILIDADE', 'CONTABILISTAS', 'ASSESSORIA', 'ASSESSORIAS', 'CONSULTORIA', 'CONSULTORIAS', 'EMPRESARIAL', 'EMPRESARIAIS', 'GESTAO', 'TRIBUTARIA', 'ADMINISTRATIVA', 'ADMINISTRATIVOS', 'PERICIA', 'AUDITORIA', 'AUDITORES', 'ESCRITORIO', 'FINANCEIRA', 'RECURSOS', 'HUMANOS', 'NEGOCIOS', 'ESPECIALIZADA', 'PROJETOS', 'INVESTIMENTOS', 'CONTADORES',
  'LTDA', 'EIRELI', 'EPP', 'MEI', 'CF', 'RPS',
  'DO', 'DA', 'DE', 'DOS', 'DAS', 'E', 'EM'])
const normNome = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
export function tokensNome(nome) {
  const todos = normNome(nome).split(' ').filter(Boolean)
  const dist = todos.filter(t => t.length >= 3 && !GENERICAS.has(t))
  if (dist.length) return dist
  const naoGen = todos.filter(t => !GENERICAS.has(t)) // iniciais "C K", "A S" — melhor que todos com genéricas
  return naoGen.length ? naoGen : todos
}
export function mesmoCliente(a, b) {
  const inter = a.filter(t => b.includes(t))
  if (!inter.length) return false
  const menor = Math.min(a.length, b.length)
  // Conjuntos idênticos → mesmo cliente. Subconjunto com UM só token distintivo só casa se
  // esse token for FORTE (>=5) — senão "NOVA" uniria "NOVA CONTABILIDADE" e "NOVA ALIANCA".
  if (a.length === b.length && inter.length === menor) return true
  if (menor === 1) return inter.length === 1 && inter[0].length >= 5
  if (inter.length === menor) return true
  return inter.length / menor >= 0.6 && inter.some(t => t.length >= 4)
}

function lerHistorico(h) {
  const s = String(h || '').trim()
  const nfm = s.match(/\bNF\.?\s*(?:N[ºo°.]*\s*)?(\d{2,9})/i) || s.match(/\bNOTA\s*(?:FISCAL)?\s*N?[ºo°.]*\s*(\d{2,9})/i) || s.match(/\bN[ºo°]\.?\s*(\d{2,9})/i)
  const nf = nfm ? nfm[1] : (s.match(/\b(\d{3,9})\b/)?.[1] || '')
  const corpo = s.split(/\s(?:CF\b|NF\b|NOTA\s+FISCAL|RPS\b)/i)[0].trim()
  let entidade = '', ident = false
  const mRec = corpo.match(/\b(?:RECEBIMENTO|RECEBTO|PAGAMENTO|PAGTO)\s+(?:A\s+|DE\s+|AO\s+)?(.+)$/i)
  // Fiscal integrado (SAÍDAS/serviços): cliente vem DEPOIS do "ACUM. N —" (qualquer traço).
  const mAcum = corpo.match(/\bACUM(?:ULADOR)?\.?\s*\d+[\s|\-–—−]+(.+)$/i)
  if (mRec) {
    entidade = tiraSufixo(mRec[1].trim()); ident = true
  } else if (mAcum && mAcum[1].trim().length >= 3) {
    entidade = tiraSufixo(mAcum[1].trim()); ident = true
  } else if (/\s[-–—−]\s/.test(corpo)) {
    const segs = corpo.split(/\s[-–—−]\s/).map(x => x.trim()).filter(Boolean)
    entidade = tiraSufixo(segs[segs.length - 1]); ident = true
  }
  if (!entidade || entidade.length < 3) {
    entidade = s.replace(nfm ? nfm[0] : '', ' ').replace(/\b\d+\b/g, ' ').replace(RUIDO, ' ').replace(/[.\-/]+/g, ' ').replace(/\s+/g, ' ').trim()
    ident = false
  }
  let conf = 'baixa'
  if (ident && entidade.length >= 4 && nf) conf = 'alta'
  else if (ident && entidade.length >= 4) conf = 'media'
  return { nf, entidade: entidade || '', ident, conf }
}

export function lerHistoricoLanc(h) { return lerHistorico(h) }
export function aplicarAjuste(l, aj) {
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

const baixaTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export function ehPorEntidade(nome) {
  const n = baixaTxt(nome)
  return /client|fornecedor|duplicat|adiantament|contas? a pagar|a receber/.test(n)
}

export const nfKey = nf => String(nf ?? '').replace(/\D/g, '').replace(/^0+/, '')
function baixadosPorNF(lancs) {
  const porNF = {}
  for (const l of lancs) { const nf = nfKey(l.leitura?.nf); if (nf) (porNF[nf] = porNF[nf] || []).push(l) }
  const baixados = new Set()
  for (const nf in porNF) {
    const grp = porNF[nf]
    const temD = grp.some(l => Number(l.debito) > 0.005)
    const temC = grp.some(l => Number(l.credito) > 0.005)
    if (!temD || !temC) continue
    if (Math.abs(grp.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)) >= 0.005) continue
    const nomes = [...new Set(grp.map(l => (l.leitura?.ident && l.leitura.entidade) ? l.leitura.entidade : null).filter(Boolean))]
    let mesmoCli = true
    for (let i = 1; i < nomes.length; i++) if (!mesmoCliente(tokensNome(nomes[0]), tokensNome(nomes[i]))) { mesmoCli = false; break }
    if (!mesmoCli) continue
    for (const l of grp) baixados.add(l)
  }
  return baixados
}

// Itens ainda EM ABERTO de uma conta ao fim da competência `compId`, para arrastar como
// composição de abertura do mês seguinte. `aberturaPrevia` = composição de abertura DA
// PRÓPRIA competência (recursiva) — junto com o razão e as correções do mês forma o total,
// e o que casa por NF (título × baixa) sai; o que sobra é o saldo que segue em aberto.
// - Contas de ENTIDADE (cliente/fornecedor): o que sobra vira vários "saldo anterior" por
//   título (casamento por NF).
// - Contas de SALDO (ex.: seguro/despesa a apropriar): não há NF a casar; o saldo que resta
//   (abertura anterior + movimento + acertos) arrasta como UMA linha de "saldo anterior" —
//   é o saldo inicial do mês seguinte, para aparecer também no razão da Conciliação.
export async function itensAbertosConta(compId, contaCod, contaNome, classifRaw, aberturaPrevia) {
  const porEntidade = ehPorEntidade(contaNome)
  const [{ data: rz }, { data: aj }, { data: acs }] = await Promise.all([
    supabase.from('razao').select('id, data, contrapartida, historico, debito, credito').eq('competencia_id', compId).eq('conta', contaCod).order('data'),
    supabase.from('ajuste_leitura').select('razao_id, nf, entidade, historico').eq('competencia_id', compId),
    supabase.from('lancamentos').select('id, data, conta_debito, conta_credito, valor, historico, razao_id, origem').eq('competencia_id', compId),
  ])
  const ajById = {}; for (const a of (aj || [])) ajById[a.razao_id] = a
  const acertoLancs = (acs || [])
    .filter(a => String(a.conta_debito) === String(contaCod) || String(a.conta_credito) === String(contaCod))
    .map(a => {
      const ehDeb = String(a.conta_debito) === String(contaCod)
      return aplicarAjuste({
        id: 'ac_' + a.id, data: a.data,
        contrapartida: ehDeb ? a.conta_credito : a.conta_debito, historico: a.historico,
        debito: ehDeb ? (Number(a.valor) || 0) : 0, credito: ehDeb ? 0 : (Number(a.valor) || 0),
      }, null)
    })
  const lanc = [...(aberturaPrevia || []), ...(rz || []).map(l => aplicarAjuste(l, ajById[l.id])), ...acertoLancs]
  // Conta de saldo (não é cliente/fornecedor): arrasta o SALDO líquido como uma única linha.
  if (!porEntidade) {
    const net = lanc.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
    if (Math.abs(net) < 0.005) return []
    const rotulo = String(contaNome || '').trim()
    return [{
      id: `arr-${compId}-saldo`,
      data: 'abertura',
      contrapartida: '',
      historico: `Saldo anterior${rotulo ? ' · ' + rotulo : ''}`,
      debito: net > 0 ? net : 0,
      credito: net < 0 ? -net : 0,
      abertura: true,
      leitura: { nf: '', entidade: '', ident: false, conf: 'baixa', abertura: true },
    }]
  }
  const baixados = baixadosPorNF(lanc)
  const abertos = lanc.filter(l => !baixados.has(l) && Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0)) >= 0.005)
  // Vira "saldo anterior" para o mês seguinte, preservando NF/entidade p/ casar as baixas.
  return abertos.map((l, i) => ({
    id: `arr-${compId}-${i}`,
    data: l.data || 'abertura',
    contrapartida: '',
    historico: `Saldo anterior · ${l.leitura?.entidade || ''}${l.leitura?.nf ? ' · NF ' + l.leitura.nf : ''}`.replace(/·\s*$/, '').trim(),
    debito: Number(l.debito) || 0,
    credito: Number(l.credito) || 0,
    abertura: true,
    leitura: { ...(l.leitura || {}), abertura: true },
  }))
}
