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

// Balancete hierárquico (sintéticas + analíticas) de uma competência.
// Estrutura vem do plano; os saldos somam o razão (balancete das folhas) por prefixo da classificação.
export async function montarBalancete(empresaId, compId) {
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  const { data: bal } = await supabase.from('balancete')
    .select('conta, nome, debito, credito, saldo_inicial').eq('competencia_id', compId)
  const movs = bal || []
  const comMov = l => Math.abs(l.debito) > 0.005 || Math.abs(l.credito) > 0.005 || Math.abs(l.saldo_inicial) > 0.005
  const ordena = (a, b) => String(a.classif).localeCompare(String(b.classif), 'pt-BR', { numeric: true })

  if (plano.length) {
    const linhas = plano.map(p => {
      let deb = 0, cre = 0, ini = 0
      for (const m of movs) {
        const c = String(m.conta || '')
        if (c === p.classif || c.startsWith(p.classif + '.')) {
          deb += Number(m.debito) || 0; cre += Number(m.credito) || 0; ini += Number(m.saldo_inicial) || 0
        }
      }
      return { reduzido: p.reduzido, classif: p.classif, nome: p.nome, grau: p.grau, sintetica: p.sintetica, saldo_inicial: ini, debito: deb, credito: cre, saldo_final: ini + deb - cre }
    }).filter(comMov).sort(ordena)
    return { temPlano: true, linhas }
  }

  // Fallback sem plano: deriva as sintéticas a partir das folhas (sem reduzido/nome das sintéticas).
  const map = {}
  function acc(classif, folha, nome, deb, cre, ini) {
    const e = map[classif] || (map[classif] = { reduzido: '', classif, nome: '', grau: classif.split('.').length, sintetica: !folha, debito: 0, credito: 0, saldo_inicial: 0 })
    e.debito += deb; e.credito += cre; e.saldo_inicial += ini
    if (folha && nome && !e.nome) e.nome = nome
    if (folha) e.sintetica = false
  }
  for (const m of movs) {
    const c = String(m.conta || ''); if (!c) continue
    const deb = Number(m.debito) || 0, cre = Number(m.credito) || 0, ini = Number(m.saldo_inicial) || 0
    acc(c, true, m.nome, deb, cre, ini)
    const segs = c.split('.')
    for (let i = 1; i < segs.length; i++) acc(segs.slice(0, i).join('.'), false, '', deb, cre, ini)
  }
  const linhas = Object.values(map).map(e => ({ ...e, saldo_final: e.saldo_inicial + e.debito - e.credito })).filter(comMov).sort(ordena)
  return { temPlano: false, linhas }
}
