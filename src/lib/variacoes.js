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

  const itens = []
  for (const [conta, linha] of Object.entries(matriz)) {
    const vals = mesesComDados.map(m => linha[m]).filter(v => v != null)
    if (vals.length < 2) continue
    const media = vals.reduce((s, v) => s + v, 0) / vals.length
    for (const m of mesesComDados) {
      const v = linha[m]; if (v == null) continue
      const dv = media === 0 ? (v !== 0 ? 1 : 0) : Math.abs(v - media) / Math.abs(media)
      if (dv > 0.10 && !just.has(`${conta}|${m}`)) itens.push({ conta, nome: nomes[conta] || '', mes: m, valor: v })
    }
  }

  const contas = Object.keys(matriz).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })).map(conta => ({ conta, nome: nomes[conta] || '' }))
  return { itens, meses: mesesComDados, contas, matriz }
}
