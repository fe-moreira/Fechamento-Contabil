import { supabase } from './supabase'

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Cada regra liga um padrão de nome de conta (no balancete) a um bloco/tabela de contrato.
// Padrões específicos (evitam falsos positivos como PAGSEGURO, empréstimos a funcionários,
// XP investimentos, nome de fornecedor com "importação").
const REGRAS = [
  { tipo: 'seguro', tabela: 'seguros', kw: /premio.*seguro|seguro.*(a pagar|apropriar)|desp.*seguro/, label: 'Seguro' },
  { tipo: 'emprestimo', tabela: 'emprestimos', kw: /emprestimo.*(bancario|financiamento|mutuo|capital de giro)/, label: 'Empréstimo' },
  { tipo: 'parcelamento', tabela: 'parcelamentos', kw: /parcelamento de (debito|imposto)|refis|parcelamento tributario/, label: 'Parcelamento de impostos' },
  { tipo: 'importacao', tabela: 'importacoes', kw: /importacao em andamento|importacao \d|adiantamento.*importacao/, label: 'Importação' },
  { tipo: 'equivalencia', tabela: 'participacoes', kw: /participacoes societarias|coligad|controlad/, label: 'Equivalência patrimonial' },
]

// Descobre o competencia_id (somente leitura — não cria).
export async function competenciaIdDe(clienteId, competencia) {
  const [mes, ano] = (competencia || '').split('/').map(Number)
  if (!clienteId || !mes || !ano) return null
  const { data } = await supabase.from('competencias').select('id')
    .eq('cliente_id', clienteId).eq('ano', ano).eq('mes', mes).maybeSingle()
  return data?.id || null
}

// Carrega o plano de contas do cliente como mapa { código: nome }.
async function planoMap(clienteId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const rows = Array.isArray(data?.dados) ? data.dados : []
  if (!rows.length) return {}
  const keys = Object.keys(rows[0])
  const kCod = keys.find(k => /cod|reduz/.test(norm(k))) || keys.find(k => /conta/.test(norm(k))) || keys[0]
  const kNome = keys.find(k => /nome|descri/.test(norm(k))) || keys.find(k => k !== kCod) || keys[0]
  const m = {}
  rows.forEach(r => { const c = String(r[kCod] ?? '').trim(); if (c) m[c] = String(r[kNome] ?? '').trim() })
  return m
}

// Detecta observações: conta com movimento/saldo no balancete (nome vem do plano) e nenhum contrato ativo no bloco.
export async function detectarObservacoes(clienteId, competenciaId) {
  if (!clienteId || !competenciaId) return []
  const [balRes, plano] = await Promise.all([
    supabase.from('balancete').select('conta,nome,debito,credito,saldo_final').eq('competencia_id', competenciaId),
    planoMap(clienteId),
  ])
  const rows = (balRes.data || []).map(b => ({ ...b, nome: b.nome || plano[String(b.conta ?? '').trim()] || '' }))
  const out = []
  for (const r of REGRAS) {
    const contas = rows.filter(b => b.nome && r.kw.test(norm(b.nome)) &&
      (Math.abs(Number(b.debito) || 0) + Math.abs(Number(b.credito) || 0) + Math.abs(Number(b.saldo_final) || 0) > 0.005))
    if (!contas.length) continue
    const { count } = await supabase.from(r.tabela).select('id', { count: 'exact', head: true })
      .eq('cliente_id', clienteId).eq('status', 'ativo')
    if ((count || 0) > 0) continue // já há contrato cadastrado no bloco
    const valor = contas.reduce((s, b) => s + Math.abs(Number(b.saldo_final) || 0), 0)
    out.push({ tipo: r.tipo, label: r.label, conta: contas[0].conta,
      descricao: `Movimento em ${contas.length} conta(s) de ${r.label.toLowerCase()} (ex.: ${contas[0].nome}) e nenhum cadastro no bloco.`, valor })
  }
  return out
}

export async function carregarResolucoes(competenciaId) {
  if (!competenciaId) return {}
  const { data } = await supabase.from('observacoes').select('*').eq('competencia_id', competenciaId)
  const map = {}; (data || []).forEach(o => { map[o.tipo] = o }); return map
}

export async function resolverObservacao({ competencia_id, tipo, conta, descricao, status, texto, usuario }) {
  const { error } = await supabase.from('observacoes').upsert(
    { competencia_id, tipo, conta, descricao, status, texto, usuario },
    { onConflict: 'competencia_id,tipo' })
  if (error) throw error
}

export async function reabrirObservacao(competenciaId, tipo) {
  const { error } = await supabase.from('observacoes').delete()
    .eq('competencia_id', competenciaId).eq('tipo', tipo)
  if (error) throw error
}
