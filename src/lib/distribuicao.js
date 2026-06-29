import { supabase } from './supabase'

const baixa = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Apura a distribuição de lucros por sócio numa competência, a partir da config
// (limite, alíquota, contas observadas, sócios) e dos lançamentos do razão nessas contas.
// Regra (Lei 15.270/2025): se o total recebido pelo sócio no mês > limite, retém IRRF
// sobre o TOTAL recebido (não só o excedente).
export async function apurarDistribuicao(empresaId, compId) {
  const { data: cfg } = await supabase.from('dist_lucros_config').select('*')
    .eq('cliente_id', empresaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!cfg) return { temConfig: false, socios: [], limite: 0, aliquota: 0 }

  const limite = Number(cfg.limite) || 50000
  const aliquota = Number(cfg.aliquota) || 10
  const contas = (cfg.contas || []).map(c => String(c.cod || '').trim()).filter(Boolean)

  let lanc = []
  if (compId && contas.length) {
    const { data } = await supabase.from('razao').select('conta, historico, debito, credito')
      .eq('competencia_id', compId).in('conta', contas)
    lanc = data || []
  }

  const socios = (cfg.socios || []).map(s => {
    const ident = baixa(s.ident || s.nome)
    let total = 0
    if (ident) for (const l of lanc) {
      if (baixa(l.historico).includes(ident)) total += (Number(l.debito) || 0) + (Number(l.credito) || 0)
    }
    const excede = total > limite
    return { nome: s.nome || '(sócio)', ident: s.ident || '', total, excede, irrf: excede ? total * (aliquota / 100) : 0 }
  })

  return { temConfig: true, limite, aliquota, socios, contas }
}
