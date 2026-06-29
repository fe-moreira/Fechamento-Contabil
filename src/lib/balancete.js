import { supabase } from './supabase'

const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Lê o plano de contas importado → [{ reduzido, classif, nome, sintetica, grau }].
export function parsePlano(dados) {
  const rows = Array.isArray(dados) ? dados : []
  if (!rows.length) return []
  const keys = Object.keys(rows[0])
  const find = re => keys.find(k => re.test(baixa(k)))
  const kClass = find(/classif/)
  const kRed = find(/codigo|reduz/) || find(/^cod/)
  const kNome = find(/nome|descri/)
  const kTipo = keys.find(k => baixa(k) === 't') || find(/^tipo$/) || find(/tipo/)
  const kGrau = find(/grau|nivel/)
  const out = []
  for (const r of rows) {
    const classif = String((kClass != null ? r[kClass] : '') ?? '').trim()
    if (!classif || !/^\d/.test(classif)) continue
    const tipo = String((kTipo != null ? r[kTipo] : '') ?? '').trim().toUpperCase().slice(0, 1)
    out.push({
      reduzido: String((kRed != null ? r[kRed] : '') ?? '').trim(),
      classif,
      nome: String((kNome != null ? r[kNome] : '') ?? '').trim(),
      sintetica: tipo === 'S',
      grau: Number(kGrau != null ? r[kGrau] : 0) || classif.split('.').length,
    })
  }
  return out
}

// Forma canônica do código: separa por não-dígitos e tira zeros à esquerda de cada
// segmento. Assim "1.1.001", "1-1-1" e "1.1.1" casam entre si ao consultar o plano.
const canon = c => String(c ?? '').split(/[^0-9]+/).filter(Boolean).map(s => String(parseInt(s, 10))).join('.')

// Balancete hierárquico (sintéticas + analíticas) de uma competência.
// Parte dos MOVIMENTOS (razão/balancete): cada conta movimentada é uma analítica
// (folha) e as sintéticas são os totais agregados por prefixo da classificação.
// O plano de contas só enriquece nome e código reduzido (não decide o que aparece),
// de modo que toda conta com movimento entra — analíticas e sintéticas.
export async function montarBalancete(empresaId, compId) {
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  // Índice do plano por classificação (exata e canônica) para preencher nome/reduzido/grau.
  const planoIdx = {}
  for (const p of plano) {
    if (!planoIdx[p.classif]) planoIdx[p.classif] = p
    const cc = canon(p.classif)
    if (cc && !planoIdx['#' + cc]) planoIdx['#' + cc] = p
  }
  const lookup = classif => planoIdx[classif] || planoIdx['#' + canon(classif)] || null

  const { data: bal } = await supabase.from('balancete')
    .select('conta, nome, debito, credito, saldo_inicial').eq('competencia_id', compId)
  const movs = bal || []

  const map = {}
  const ensure = classif => map[classif] || (map[classif] = {
    reduzido: '', classif, nome: '', grau: classif.split('.').length,
    folha: false, debito: 0, credito: 0, saldo_inicial: 0,
  })
  for (const mv of movs) {
    const c = String(mv.conta || '').trim(); if (!c) continue
    const deb = Number(mv.debito) || 0, cre = Number(mv.credito) || 0, ini = Number(mv.saldo_inicial) || 0
    const folha = ensure(c)
    folha.folha = true
    folha.debito += deb; folha.credito += cre; folha.saldo_inicial += ini
    if (mv.nome && !folha.nome) folha.nome = mv.nome
    const segs = c.split('.')
    for (let i = 1; i < segs.length; i++) {
      const e = ensure(segs.slice(0, i).join('.'))
      e.debito += deb; e.credito += cre; e.saldo_inicial += ini
    }
  }
  // Enriquecer com o plano (nome e código reduzido), sem alterar quem é folha/sintética.
  for (const e of Object.values(map)) {
    const p = lookup(e.classif)
    if (p) {
      if (p.reduzido) e.reduzido = p.reduzido
      if (p.nome) e.nome = p.nome
      if (p.grau) e.grau = p.grau
    }
  }
  const comMov = l => Math.abs(l.debito) > 0.005 || Math.abs(l.credito) > 0.005 || Math.abs(l.saldo_inicial) > 0.005
  const ordena = (a, b) => String(a.classif).localeCompare(String(b.classif), 'pt-BR', { numeric: true })
  const linhas = Object.values(map).map(e => ({
    reduzido: e.reduzido, classif: e.classif, nome: e.nome, grau: e.grau,
    sintetica: !e.folha,
    saldo_inicial: e.saldo_inicial, debito: e.debito, credito: e.credito,
    saldo_final: e.saldo_inicial + e.debito - e.credito,
  })).filter(comMov).sort(ordena)
  return { temPlano: plano.length > 0, linhas }
}
