import { supabase } from './supabase'
import { ehPorEntidade } from './aberturaArrasto'

// CONFIGURAÇÃO DO TIPO DE CADA CONTA PATRIMONIAL (Ativo/Passivo), definida direto na lista da
// Conciliação (o badge ao lado da conta). Três tipos possíveis + "automático":
//   'entidade'   → Cliente/Fornecedor: blocos por nome, baixa por NF+nome.
//   'composicao' → Composição sem nome (impostos): lista em aberto + baixa, sem blocos de nome.
//   'saldo'      → Só saldo (banco/estoque): sem baixa; arrasta só o saldo.
//   (sem config) → Automático: 1.1.1 → saldo; nome cliente/forn → entidade; senão composicao.
//
// REGRA TEMPORAL (igual ao aprendizado de nomes): guardado POR COMPETÊNCIA com HERANÇA pra frente.
// O que você define vale do mês atual em diante; meses anteriores (fechados) NÃO mudam. Guardado em
// cargas_cadastro (tipo 'config_contas'), uma linha por salvamento (append, lê a mais recente) —
// sem tabela nova.
const TIPO = 'config_contas'
const TIPOS = new Set(['entidade', 'composicao', 'saldo'])
const VNUM = v => { const m = /^(\d{1,2})\/(\d{4})$/.exec(String(v || '')); return m ? Number(m[2]) * 100 + Number(m[1]) : 0 }

// Lê o registro de config do cliente (a linha mais recente). Devolve { porComp }.
export async function lerConfigContas(empresaId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', TIPO).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const d = data?.dados
  const porComp = (d && typeof d.porComp === 'object' && d.porComp) ? d.porComp : {}
  return { porComp }
}

// Config EFETIVA de uma competência: funde as definições de TODOS os meses <= competencia
// (a mais recente de cada conta vence) → { contaCod: 'entidade'|'composicao'|'saldo' }. Assim a
// herança vai pra frente e o passado nunca é afetado por uma definição de mês posterior. Uma
// definição 'auto' num mês REMOVE o override daquele mês em diante (volta ao automático).
export function configEfetiva(cfg, competencia) {
  const alvo = VNUM(competencia)
  const chaves = Object.keys(cfg?.porComp || {}).filter(k => VNUM(k) <= alvo).sort((a, b) => VNUM(a) - VNUM(b))
  const out = {}
  for (const k of chaves) {
    const m = cfg.porComp[k]
    if (!m || typeof m !== 'object') continue
    for (const conta in m) {
      const t = m[conta]
      if (TIPOS.has(t)) out[String(conta)] = t
      else delete out[String(conta)] // 'auto'/null → volta ao automático daqui pra frente
    }
  }
  return out
}

// Tipo AUTOMÁTICO (quando não há config manual): 1.1.1 → saldo; nome de cliente/fornecedor →
// entidade; senão composicao. Mesma regra de hoje (tipoAuto + ehPorEntidade), agora num lugar só.
export function tipoAutomatico(classifRaw, nome) {
  const c = String(classifRaw || '').replace(/\D/g, '')
  if (c.startsWith('111')) return 'saldo'
  if (ehPorEntidade(nome)) return 'entidade'
  return 'composicao'
}

// Tipo EFETIVO de uma conta: config manual tem prioridade; senão automático. Devolve o 3-valor.
export function tipoContaEf(configMerged, conta, classifRaw, nome) {
  const ov = configMerged && configMerged[String(conta)]
  if (TIPOS.has(ov)) return ov
  return tipoAutomatico(classifRaw, nome)
}

// Define o tipo de uma conta A PARTIR de uma competência (vale deste mês pra frente). `tipo` deve
// ser um de TIPOS, ou 'auto' para remover o override (voltar ao automático daqui pra frente).
// Append de uma nova linha (igual conciliacao_nomes): preserva o histórico e nunca mexe no passado.
export async function salvarConfigConta(empresaId, competencia, conta, tipo, usuario) {
  const atual = await lerConfigContas(empresaId)
  const porComp = { ...(atual.porComp || {}) }
  const comp = competencia || '00/0000'
  porComp[comp] = { ...(porComp[comp] || {}), [String(conta)]: TIPOS.has(tipo) ? tipo : 'auto' }
  const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: TIPO, vigencia: comp, dados: { porComp }, usuario })
  if (error) throw error
  return { porComp }
}

export const ROTULO_TIPO = { entidade: 'Cliente/Forn.', composicao: 'Composição', saldo: 'Saldo' }
