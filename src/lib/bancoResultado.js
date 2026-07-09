import { supabase } from './supabase'
import { parsePlano } from './balancete'
import { money } from './theme'

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const soNum = s => String(s ?? '').replace(/\D/g, '')
// Resultado = CLASSIFICAÇÃO começa com 3, 4 ou 5. (Ativo=1, Passivo=2 são patrimoniais.)
const isResultado = cl => /^[345]/.test(String(cl || ''))

// Aponta lançamentos que jogam um BANCO direto numa conta de RESULTADO (classificação 3/4/5)
// que NÃO está liberada na amarração banco × resultado. A natureza é decidida pela
// CLASSIFICAÇÃO da conta (do plano), nunca pelo código reduzido. Despesas (classif 4)
// exigem classificação dedutível/indedutível (LALUR) na justificativa.
export async function apurarBancoResultado(empresaId, compId) {
  const [{ data: carga }, { data: planoCarga }] = await Promise.all([
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'bancoresult').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  // Código (reduzido ou classificação, com/sem máscara) → classificação só com dígitos.
  const plano = parsePlano(planoCarga?.dados)
  const redToClassif = {}
  for (const p of plano) { if (p.reduzido) redToClassif[p.reduzido] = soNum(p.classif) }
  const classifDe = cod => {
    const t = String(cod ?? '').trim(); if (!t) return ''
    if (redToClassif[t]) return redToClassif[t] // é código reduzido → classificação do plano
    return soNum(t)                              // já é uma classificação
  }

  const rows = Array.isArray(carga?.dados) ? carga.dados : []
  const bancos = new Set(), liberadas = new Set()
  for (const r of rows) {
    const keys = Object.keys(r)
    const kTipo = keys.find(k => /tipo/.test(norm(k)))
    const kCod = keys.find(k => /cod/.test(norm(k))) || keys.find(k => /conta/.test(norm(k)))
    const tipo = norm(kTipo ? r[kTipo] : '')
    const cl = classifDe(kCod ? r[kCod] : '')
    if (!cl) continue
    if (tipo.includes('banco')) bancos.add(cl)
    else if (tipo.includes('result') || tipo.includes('liber')) liberadas.add(cl)
  }

  if (!compId || !bancos.size) return { temCarga: rows.length > 0, bancos: bancos.size, lancamentos: [] }

  const { data: razao } = await supabase.from('razao')
    .select('data, conta, contrapartida, historico, debito, credito').eq('competencia_id', compId)

  const flagged = []
  // O razão traz os DOIS lados do lançamento (linha do banco + linha da conta de
  // resultado). Para não duplicar, processamos SÓ a linha do BANCO (cada lançamento tem
  // exatamente uma) — assim dois lançamentos idênticos ainda contam como dois. bancoDeb =
  // o banco foi DEBITADO (dinheiro ENTROU → D banco / C resultado, o caso inverso, que
  // também tem que aparecer). Caso normal: banco creditado (D resultado / C banco).
  for (const l of (razao || [])) {
    const a = String(l.conta || '').trim(), b = String(l.contrapartida || '').trim()
    const ca = classifDe(a), cb = classifDe(b)
    if (!bancos.has(ca) || !isResultado(cb) || liberadas.has(cb)) continue // só a linha do banco → resultado não liberado
    const valor = (Number(l.debito) || 0) + (Number(l.credito) || 0)
    flagged.push({
      data: l.data, banco: a, resultado: b, historico: l.historico || '', valor,
      bancoDeb: (Number(l.debito) || 0) > 0.005,
      // Despesa E custo (classif 4 e 5) exigem classificação dedutível/indedutível (LALUR).
      despesa: /^[45]/.test(cb),
    })
  }
  // Marca o que já foi tratado (justificado/corrigido) e o que é pendência do cliente —
  // pela mesma chave do item usada no Status. Guarda também o TEXTO da justificativa e o
  // dedutível/indedutível, para o "editar" pré-preencher e mostrar no próprio item.
  const { data: aud } = await supabase.from('auditoria').select('item, tipo, detalhe, dedutibilidade').eq('competencia_id', compId).eq('modulo', 'Status')
  const tratados = new Map(), pend = new Set()
  for (const a of (aud || [])) { if (a.tipo === 'Pendência') pend.add(a.item); else tratados.set(a.item, a) }
  for (const f of flagged) {
    const chave = `${f.banco} → ${f.resultado} · ${money(f.valor)}`
    const t = tratados.get(chave)
    f.tratado = !!t
    f.pendenciaCliente = pend.has(chave)
    f.justDetalhe = t?.detalhe || ''
    f.justDedut = t?.dedutibilidade || ''
    f.justTipo = t?.tipo || ''
  }
  return { temCarga: rows.length > 0, bancos: bancos.size, lancamentos: flagged }
}
