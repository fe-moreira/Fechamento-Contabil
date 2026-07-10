import { supabase } from './supabase'

const ANO = 2026

// Monta a matriz conta × mês (saldo final) do ano e aponta as variações > 10% da
// média ainda não justificadas no Comparativo (auditoria). Usada no gate Variações
// do Status e no relatório Comparativo.
export async function apurarVariacoes(empresaId) {
  const vazio = { itens: [], meses: [], contas: [], matriz: {} }
  if (!empresaId) return vazio

  const { data: comps } = await supabase.from('competencias').select('id, mes')
    .eq('cliente_id', empresaId).eq('ano', ANO).order('mes', { ascending: true })
  if (!comps || !comps.length) return vazio

  const matriz = {}, nomes = {}, mesPorComp = {}, mesesComDados = []
  for (const c of comps) {
    mesPorComp[c.id] = c.mes
    const { data: bal } = await supabase.from('balancete').select('conta, nome, saldo_final').eq('competencia_id', c.id)
    if (!bal || !bal.length) continue
    mesesComDados.push(c.mes)
    for (const b of bal) {
      if (!b.conta) continue
      ;(matriz[b.conta] ||= {})[c.mes] = Number(b.saldo_final) || 0
      if (b.nome && !nomes[b.conta]) nomes[b.conta] = b.nome
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
