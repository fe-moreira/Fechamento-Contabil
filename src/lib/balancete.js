import { supabase } from './supabase'

const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Aplica a máscara do Domínio (ex.: "9.9.9.999.9999") a uma classificação sem pontos.
// "1110010001" → "1.1.1.001.0001"; aceita códigos parciais (sintéticas): "111001" → "1.1.1.001".
export function applyMask(code, mask) {
  const c = String(code ?? '')
  if (!mask || !c) return c
  const tams = String(mask).split('.').map(s => s.length)
  const out = []
  let i = 0
  for (const t of tams) {
    if (i >= c.length) break
    out.push(c.slice(i, i + t))
    i += t
  }
  return out.join('.')
}

// Comprimentos acumulados de cada nível da máscara: "9.9.9.999.9999" → [1,2,3,6,10].
function cortesDaMascara(mask) {
  const tams = String(mask || '').split('.').map(s => s.length).filter(Boolean)
  const cortes = []
  let acc = 0
  for (const t of tams) { acc += t; cortes.push(acc) }
  return cortes
}

// Lê o plano de contas importado (export do Domínio) → [{ reduzido, classif, nome, sintetica, mascara }].
// reduzido = código da conta (o que aparece no razão); classif = classificação hierárquica (coluna O).
export function parsePlano(dados) {
  const rows = Array.isArray(dados) ? dados : []
  if (!rows.length) return []
  const keys = Object.keys(rows[0])
  const find = (...res) => { for (const re of res) { const k = keys.find(k => re.test(baixa(k))); if (k) return k } return null }
  const kClass = find(/classifica/, /classif/)
  const kRed = find(/codigo.?conta/, /codigo|reduz/, /^cod/)
  const kNome = find(/nome.?conta/, /nome|descri/)
  const kTipo = find(/tipo.?conta/) || keys.find(k => baixa(k) === 't') || find(/^tipo$/)
  const kMask = find(/mascara.?relat/, /mascara/)
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
      mascara: String((kMask != null ? r[kMask] : '') ?? '').trim(),
    })
  }
  return out
}

// Balancete hierárquico (sintéticas + analíticas) de uma competência.
// Os movimentos (razão/balancete) vêm pelo CÓDIGO da conta (reduzido); o plano traduz
// cada código para a sua CLASSIFICAÇÃO hierárquica (coluna O) e nome, e as sintéticas
// são os totais agregados por prefixo da classificação (segundo a máscara).
export async function montarBalancete(empresaId, compId) {
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  const mascara = (plano.find(p => p.mascara)?.mascara) || '9.9.9.999.9999'
  const cortes = cortesDaMascara(mascara)
  const temPlano = plano.length > 0

  // Índices do plano: por código (reduzido → conta) e por classificação (classif → conta).
  const porReduzido = {}, porClassif = {}
  for (const p of plano) {
    if (p.reduzido && !porReduzido[p.reduzido]) porReduzido[p.reduzido] = p
    if (p.classif && !porClassif[p.classif]) porClassif[p.classif] = p
  }

  const { data: bal } = await supabase.from('balancete')
    .select('conta, nome, debito, credito, saldo_inicial').eq('competencia_id', compId)
  const movs = bal || []

  const map = {}
  const ensure = classif => map[classif] || (map[classif] = {
    reduzido: '', classif, nome: '', folha: false, debito: 0, credito: 0, saldo_inicial: 0,
  })

  for (const mv of movs) {
    const cod = String(mv.conta || '').trim(); if (!cod) continue
    const deb = Number(mv.debito) || 0, cre = Number(mv.credito) || 0, ini = Number(mv.saldo_inicial) || 0
    const p = porReduzido[cod]
    const classif = p ? p.classif : cod
    const folha = ensure(classif)
    folha.folha = true
    folha.debito += deb; folha.credito += cre; folha.saldo_inicial += ini
    if (!folha.nome && (p?.nome || mv.nome)) folha.nome = p?.nome || mv.nome
    if (!folha.reduzido) folha.reduzido = p?.reduzido || cod
    // Ancestrais (sintéticas): prefixos da classificação nos cortes da máscara (com plano),
    // ou pelos pontos do próprio código (fallback sem plano).
    if (p) {
      for (const corte of cortes) { if (corte < classif.length) { const e = ensure(classif.slice(0, corte)); e.debito += deb; e.credito += cre; e.saldo_inicial += ini } }
    } else {
      const segs = classif.split('.')
      for (let i = 1; i < segs.length; i++) { const e = ensure(segs.slice(0, i).join('.')); e.debito += deb; e.credito += cre; e.saldo_inicial += ini }
    }
  }

  // Enriquecer cada nó com nome/reduzido do plano (sintéticas inclusive).
  for (const e of Object.values(map)) {
    const p = porClassif[e.classif]
    if (p) { if (p.reduzido) e.reduzido = p.reduzido; if (p.nome) e.nome = p.nome }
  }

  const comMov = l => Math.abs(l.debito) > 0.005 || Math.abs(l.credito) > 0.005 || Math.abs(l.saldo_inicial) > 0.005
  const ordena = (a, b) => String(a.classif).localeCompare(String(b.classif), 'pt-BR', { numeric: true })
  const grauDe = classif => temPlano ? Math.max(1, cortes.filter(c => c <= classif.length).length) : classif.split('.').length

  const linhas = Object.values(map).map(e => ({
    reduzido: e.reduzido,
    classif: temPlano ? applyMask(e.classif, mascara) : e.classif,
    classifRaw: e.classif,
    nome: e.nome,
    grau: grauDe(e.classif),
    sintetica: !e.folha,
    saldo_inicial: e.saldo_inicial, debito: e.debito, credito: e.credito,
    saldo_final: e.saldo_inicial + e.debito - e.credito,
  })).filter(comMov).sort((a, b) => ordena({ classif: a.classifRaw }, { classif: b.classifRaw }))
  return { temPlano, linhas }
}
