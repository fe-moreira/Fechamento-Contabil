import { supabase } from './supabase'
import { parsePlano } from './balancete'

const ANO = 2026

// Monta a matriz conta × mês (saldo final) do ano e aponta as variações > 10% do mês
// anterior ainda não justificadas no Comparativo (auditoria). Usada no gate Variações
// do Status e no relatório Comparativo. Só CONTAS DE RESULTADO (3/4/5) — mesmo escopo
// da tela Comp. Movimento (para o badge/Status baterem com o header do comparativo).
// opts.comLancamentos: sobrepõe os LANÇAMENTOS confirmados (correções, apropriações,
// contabilizações) sobre a matriz do razão — para o Cockpit ler o resultado VIVO. NÃO
// ligar na página Comparativo de Movimento nem no gate do Status: lá as correções
// pendentes aparecem à parte (sobreposição própria); embutir aqui contaria em dobro.
export async function apurarVariacoes(empresaId, opts = {}) {
  const vazio = { itens: [], meses: [], contas: [], matriz: {} }
  if (!empresaId) return vazio

  const { data: comps } = await supabase.from('competencias').select('id, mes')
    .eq('cliente_id', empresaId).eq('ano', ANO).order('mes', { ascending: true })
  if (!comps || !comps.length) return vazio

  // Plano p/ classificar cada conta (reduzido → classificação) e filtrar só resultado.
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  const temPlano = plano.length > 0
  const classifDe = {}
  for (const p of plano) if (p.reduzido && !(p.reduzido in classifDe)) classifDe[p.reduzido] = p.classif
  const ehResultado = cod => {
    if (!temPlano) return true            // sem plano não dá pra classificar — não filtra
    const cl = classifDe[String(cod)]
    if (!cl) return false                 // conta fora do plano → ignora
    const d = String(cl).trim()[0]
    return d === '3' || d === '4' || d === '5'
  }

  // SISTEMA VIVO (opt-in): lançamentos confirmados por competência, para embutir na matriz.
  const lancPorComp = {}
  if (opts.comLancamentos) {
    const { data: lancs } = await supabase.from('lancamentos')
      .select('competencia_id, conta_debito, conta_credito, valor').in('competencia_id', comps.map(c => c.id))
    for (const l of (lancs || [])) (lancPorComp[l.competencia_id] ||= []).push(l)
  }

  const matriz = {}, nomes = {}, mesPorComp = {}, mesesComDados = []
  for (const c of comps) {
    mesPorComp[c.id] = c.mes
    const { data: bal } = await supabase.from('balancete').select('conta, nome, saldo_final').eq('competencia_id', c.id)
    const lancsC = lancPorComp[c.id] || []
    if ((!bal || !bal.length) && !lancsC.length) continue
    mesesComDados.push(c.mes)
    for (const b of (bal || [])) {
      if (!b.conta || !ehResultado(b.conta)) continue
      ;(matriz[b.conta] ||= {})[c.mes] = Number(b.saldo_final) || 0
      if (b.nome && !nomes[b.conta]) nomes[b.conta] = b.nome
    }
    // Sobrepõe os lançamentos: débito soma, crédito subtrai no saldo_final (resultado só).
    for (const l of lancsC) {
      const v = Number(l.valor) || 0
      if (Math.abs(v) < 0.005) continue
      const cd = String(l.conta_debito || '').trim(), cc = String(l.conta_credito || '').trim()
      if (cd && ehResultado(cd)) (matriz[cd] ||= {})[c.mes] = (matriz[cd]?.[c.mes] || 0) + v
      if (cc && ehResultado(cc)) (matriz[cc] ||= {})[c.mes] = (matriz[cc]?.[c.mes] || 0) - v
    }
  }
  mesesComDados.sort((a, b) => a - b)

  // Justificadas
  const { data: aud } = await supabase.from('auditoria').select('item, competencia_id')
    .in('competencia_id', comps.map(c => c.id)).eq('modulo', 'Comparativo')
  const just = new Set()
  for (const a of (aud || [])) {
    const conta = String(a.item || '').split(' · ')[0].trim()
    const mes = mesPorComp[a.competencia_id]
    if (conta && mes) just.add(`${conta}|${mes}`)
  }

  // Variação mês a mês: cada mês compara com o mês ANTERIOR (fev × jan, mar × fev…).
  // O primeiro mês nunca desvia. Mês sem saldo conta como 0 — sumir de um mês que tinha
  // movimento é variação a justificar.
  const itens = []
  for (const [conta, linha] of Object.entries(matriz)) {
    for (let i = 1; i < mesesComDados.length; i++) {
      const m = mesesComDados[i], mAnt = mesesComDados[i - 1]
      const a = linha[m] == null ? 0 : Number(linha[m]) || 0
      const p = linha[mAnt] == null ? 0 : Number(linha[mAnt]) || 0
      if (a === 0 && p === 0) continue // sem movimento nos dois meses
      const desvia = p === 0 ? a !== 0 : Math.abs(a - p) / Math.abs(p) > 0.10
      if (desvia && !just.has(`${conta}|${m}`)) itens.push({ conta, nome: nomes[conta] || '', mes: m, valor: linha[m] ?? 0 })
    }
  }

  const contas = Object.keys(matriz).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })).map(conta => ({ conta, nome: nomes[conta] || '' }))
  return { itens, meses: mesesComDados, contas, matriz }
}
