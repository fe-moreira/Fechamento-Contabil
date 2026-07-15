// Cartão de Crédito (em Outras Contabilizações): funciona como a integração financeira,
// mas o "outro lado" é a CONTA DO CARTÃO A PAGAR e a memória casa estabelecimento → conta
// de despesa. Sem tabela nova: cadastro dos cartões e memória vão em cargas_cadastro; o
// rascunho por cartão/competência em competencias.integracoes.cartao; os lançamentos
// gerados na tabela lancamentos (mesma fila do Status/Domínio).
import { supabase } from './supabase'
import { casarHistoricoNivel, aprender, parseValor, dataISO } from './financeiro'

// ---- Cartões do cliente (nome + conta a pagar) + perfil de leitura por cartão ----
export async function carregarCartoes(clienteId) {
  const { data } = await supabase.from('cargas_cadastro').select('id, dados, obs')
    .eq('cliente_id', clienteId).eq('tipo', 'cartoes').order('created_at', { ascending: false }).limit(1).maybeSingle()
  let perfis = {}
  try { const o = JSON.parse(data?.obs || ''); if (o?.perfis) perfis = o.perfis } catch { /* obs antigo */ }
  return { cartoes: Array.isArray(data?.dados) ? data.dados : [], perfis }
}
export async function salvarCartoes(clienteId, cartoes, perfis, usuario) {
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', 'cartoes')
  const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: 'cartoes', dados: cartoes, usuario, obs: JSON.stringify({ perfis: perfis || {} }) })
  if (error) throw error
}

// ---- Memória do cartão: estabelecimento (termo) → conta de despesa ----
export async function carregarMemoriaCartao(clienteId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'memoria_cartao').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return Array.isArray(data?.dados) ? data.dados : []
}
export async function salvarMemoriaCartao(clienteId, memoria, usuario) {
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', 'memoria_cartao')
  const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: 'memoria_cartao', dados: memoria, usuario })
  if (error) throw error
}
export { aprender }

// ---- Rascunho da fatura por cartão/competência (em competencias.integracoes.cartao) ----
export async function carregarDraftCartao(clienteId, competencia) {
  const [mes, ano] = String(competencia || '').split('/').map(Number)
  const { data } = await supabase.from('competencias').select('id, status, integracoes')
    .eq('cliente_id', clienteId).eq('ano', ano).eq('mes', mes).maybeSingle()
  return { compId: data?.id || null, status: data?.status || null, integracoes: data?.integracoes || {}, porCartao: data?.integracoes?.cartao || {} }
}
export async function salvarDraftCartao(clienteId, competencia, getCompId, integracoes, cartaoId, estadoObj) {
  let compId = null
  const [mes, ano] = String(competencia || '').split('/').map(Number)
  const { data } = await supabase.from('competencias').select('id').eq('cliente_id', clienteId).eq('ano', ano).eq('mes', mes).maybeSingle()
  compId = data?.id || (getCompId ? await getCompId() : null)
  if (!compId) throw new Error('Abra o fechamento desta competência antes.')
  const novo = { ...integracoes, cartao: { ...(integracoes.cartao || {}), [cartaoId]: estadoObj } }
  const { error } = await supabase.from('competencias').update({ integracoes: novo }).eq('id', compId)
  if (error) throw error
  return { compId, integracoes: novo }
}

// ---- Leitura da fatura em Excel ----
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// Descobre a linha de cabeçalho e as colunas Data / Estabelecimento / Valor.
export function autoMapaFatura(arr) {
  const rows = arr || []
  let hIdx = rows.findIndex(r => (r || []).some(c => /data|estabelec|hist|descri|lan[cç]|valor/.test(norm(c))))
  if (hIdx < 0) hIdx = 0
  const header = (rows[hIdx] || []).map(norm)
  const acha = re => header.findIndex(c => re.test(c))
  let colData = acha(/^data|\bdata\b|\bdt\b/)
  let colValor = acha(/valor|montante|r\$/)
  let colEstab = acha(/estabelec|hist|descri|lan[cç]/)
  const corpo = rows.slice(hIdx + 1).filter(r => (r || []).some(c => c !== '' && c != null))
  // Fallbacks pelo conteúdo: valor = coluna mais numérica; estabelecimento = texto mais longo.
  const ncol = Math.max(...rows.map(r => (r || []).length), 0)
  if (colValor < 0) { let best = -1, q = 0; for (let j = 0; j < ncol; j++) { const n = corpo.filter(r => parseValor(r[j])).length; if (n > q) { q = n; best = j } } colValor = best }
  if (colEstab < 0) { let best = -1, q = 0; for (let j = 0; j < ncol; j++) { if (j === colValor) continue; const avg = corpo.reduce((s, r) => s + (typeof r[j] === 'string' ? r[j].length : 0), 0) / (corpo.length || 1); if (avg > q) { q = avg; best = j } } colEstab = best }
  if (colData < 0) { for (let j = 0; j < ncol; j++) { if (corpo.filter(r => dataISO(r[j])).length > corpo.length / 2) { colData = j; break } } }
  return { colData, colEstab, colValor, linhaInicio: hIdx + 1 }
}
// Extrai os lançamentos da fatura [{ data, historico, valor }] com arrasto de data.
export function lerFaturaArr(arr, mapa) {
  const out = []
  let ultima = ''
  for (let i = (mapa.linhaInicio || 1); i < (arr || []).length; i++) {
    const r = arr[i] || []
    const valor = mapa.colValor >= 0 ? parseValor(r[mapa.colValor]) : 0
    const historico = mapa.colEstab >= 0 ? String(r[mapa.colEstab] ?? '').trim() : ''
    if (!valor || !historico) continue
    let data = mapa.colData >= 0 ? dataISO(r[mapa.colData]) : ''
    if (data) ultima = data; else data = ultima
    if (/pagamento\s+fatura|saldo\s+anterior/i.test(norm(historico))) continue // pagamento da fatura não é gasto
    out.push({ data, historico, valor: Math.abs(valor) })
  }
  return out
}
// Classifica pela memória (estabelecimento → conta de despesa).
export function classificarFatura(linhas, memoria) {
  return linhas.map(l => { const cas = casarHistoricoNivel(l.historico, memoria, null); return { ...l, contra: cas.conta, contra_nivel: cas.nivel } })
}
