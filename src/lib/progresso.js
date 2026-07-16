import { supabase } from './supabase'
import { contasConciliacaoAbertas } from './balancete'
import { apurarVariacoes } from './variacoes'
import { apurarBancoResultado } from './bancoResultado'
import { apurarDistribuicao } from './distribuicao'

// Calcula o MESMO progresso que a tela Status persiste em competencias.pct, mas de forma
// reaproveitável — para o card da lista de Fechamentos mostrar o andamento real de QUALQUER
// cliente sem precisar abrir o Status de cada um. Progresso = fração dos gates bloqueantes
// (os mesmos do Status) já sem pendência. Os testes de pendência abaixo espelham os gates.
const INTEG_NAO_FIN = ['fiscal', 'folha', 'patrimonio']

export async function calcularProgresso(empresaId, competencia) {
  const [mes, ano] = String(competencia || '').split('/').map(Number)
  if (!empresaId || !mes || !ano) return 0

  const { data: comp } = await supabase.from('competencias')
    .select('id, status, documentos, integracoes')
    .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
  if (!comp) return 0
  if (comp.status === 'fechado') return 100

  const [{ data: cli }, { count: razaoCount }, { data: bc }, cAbertas, variacoes, br, dist,
    { data: seg }, { data: dsp }, { data: audC }] = await Promise.all([
    supabase.from('clientes').select('carga_saldos, carga_inicial_feita, integracao_financeira').eq('id', empresaId).maybeSingle(),
    supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    contasConciliacaoAbertas(empresaId, comp.id),
    apurarVariacoes(empresaId),
    apurarBancoResultado(empresaId, comp.id),
    apurarDistribuicao(empresaId, comp.id),
    supabase.from('seguros').select('id, arquivo, vigencia_inicio, vigencia_fim').eq('cliente_id', empresaId),
    supabase.from('despesas_apropriar').select('id, tipo, descricao, arquivo, vigencia_inicio, vigencia_fim').eq('cliente_id', empresaId),
    supabase.from('auditoria').select('item').eq('competencia_id', comp.id).eq('modulo', 'Contratos'),
  ])

  const integracoes = (comp.integracoes && typeof comp.integracoes === 'object') ? comp.integracoes : {}
  const integracaoFin = cli?.integracao_financeira || 'Não usa'
  const contasBancarias = Array.isArray(bc?.dados) ? bc.dados : []
  const contratosJust = new Set((audC || []).map(a => a.item))

  // Financeira pendente? (mesma regra do Status.itensFinanceira)
  const fin = integracoes.financeira || {}
  let finPend
  if (integracaoFin !== 'Excel') finPend = !fin.estado
  else if (fin.combinado?.estado === 'validado') finPend = false
  else if (!contasBancarias.length) finPend = true
  else finPend = contasBancarias.some(c => { const e = fin.bancos?.[String(c.conta_contabil)]?.estado; return e !== 'validado' && e !== 'sem_movimento' })

  // Integrações (fiscal/folha/patrimônio) sem estado + financeira.
  const integPend = INTEG_NAO_FIN.some(k => !integracoes[k]?.estado) || finPend

  // Contratos ativos na competência sem documento e não justificados.
  const ini = `${ano}-${String(mes).padStart(2, '0')}-01`, fim = `${ano}-${String(mes).padStart(2, '0')}-31`
  const contratos = [
    ...(seg || []).map(r => ({ label: `Seguro`, arquivo: r.arquivo, vi: r.vigencia_inicio, vf: r.vigencia_fim, id: r.id })),
    ...(dsp || []).map(r => ({ label: `${r.tipo || 'Despesa a apropriar'}${r.descricao ? ' · ' + r.descricao : ''}`.trim(), arquivo: r.arquivo, vi: r.vigencia_inicio, vf: r.vigencia_fim, id: r.id })),
  ]
  const contratosPend = contratos.some(c => {
    const ativo = !(c.vi && c.vi > fim) && !(c.vf && c.vf < ini)
    return ativo && !c.arquivo && !contratosJust.has(`${c.label} — documento`)
  })

  const docs = Array.isArray(comp.documentos) ? comp.documentos : []
  const docsPend = docs.some(d => { const s = d?.situacao ?? (d?.rec ? 'recebido' : ''); return s === '' })

  // Gates bloqueantes (os mesmos do Status). true = pendente.
  const gates = [
    !!(cli?.carga_saldos && !cli?.carga_inicial_feita),          // carga inicial
    !((razaoCount || 0) > 0),                                     // razão importado
    docsPend,                                                     // documentos
    (cAbertas || []).length > 0,                                  // conciliação
    (variacoes?.itens || []).length > 0,                          // variações
    (br?.lancamentos || []).some(l => !l.tratado),                // banco × resultado
    (dist?.socios || []).some(s => s.excede),                     // distribuição de lucros
    integPend,                                                    // integrações validadas
    contratosPend,                                                // documentos de contratos
  ]
  const feitos = gates.filter(g => !g).length
  return Math.round((feitos / gates.length) * 100)
}
