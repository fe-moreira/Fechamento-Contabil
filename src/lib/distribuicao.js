import { supabase } from './supabase'
import { lerTudo } from './lerTudo'

const baixa = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Apura a distribuição de lucros por sócio numa competência, a partir da config
// (limite, alíquota, contas observadas, sócios) e dos lançamentos do razão nessas contas.
// Regra (Lei 15.270/2025): se o total recebido pelo sócio no mês > limite, retém IRRF
// sobre o TOTAL recebido (não só o excedente).
export async function apurarDistribuicao(empresaId, compId, ano = null, mes = null) {
  const { data: cfg } = await supabase.from('dist_lucros_config').select('*')
    .eq('cliente_id', empresaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!cfg) return { temConfig: false, socios: [], limite: 0, aliquota: 0, ata: { distribuido: 0, pago: 0, pagoMes: 0, saldo: 0 } }

  const limite = Number(cfg.limite) || 50000
  const aliquota = Number(cfg.aliquota) || 10
  const contas = (cfg.contas || []).map(c => String(c.cod || '').trim()).filter(Boolean)

  let lanc = []
  if (compId && contas.length) {
    lanc = await lerTudo(() => supabase.from('razao').select('conta, historico, debito, credito')
      .eq('competencia_id', compId).in('conta', contas))
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

  // Resumo da ATA: valor distribuído (autorizado), total pago (até o fim da competência),
  // pago no mês e saldo que ainda falta pagar. Cada sócio traz `valor` (distribuído em ata)
  // e `pagamentos: [{ data, valor }]`.
  const fimMes = (ano && mes) ? `${ano}-${String(mes).padStart(2, '0')}-${String(new Date(ano, mes, 0).getDate()).padStart(2, '0')}` : null
  const alvoMes = (ano && mes) ? `${ano}-${String(mes).padStart(2, '0')}` : null
  let distribuido = 0, pago = 0, pagoMes = 0
  // A ata fica em cfg.ata.socios[] ({ nome, valor, conta, pagamentos[] }) — diferente de
  // cfg.socios (que é só a lista de identificadores para o cálculo de IRRF).
  for (const s of (cfg.ata?.socios || [])) {
    distribuido += Number(s.valor) || 0
    for (const p of (s.pagamentos || [])) {
      const v = Number(p.valor) || 0
      if (!p.data) continue
      if (!fimMes || p.data <= fimMes) pago += v
      if (alvoMes && String(p.data).slice(0, 7) === alvoMes) pagoMes += v
    }
  }
  const ata = { distribuido, pago, pagoMes, saldo: Math.round((distribuido - pago) * 100) / 100 }

  return { temConfig: true, limite, aliquota, socios, contas, ata }
}
