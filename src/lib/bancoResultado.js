import { supabase } from './supabase'
import { parsePlano } from './balancete'

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
  for (const l of (razao || [])) {
    const a = String(l.conta || '').trim(), b = String(l.contrapartida || '').trim()
    const ca = classifDe(a), cb = classifDe(b)
    let banco = null, resultado = null, resultadoCl = null
    if (bancos.has(ca) && isResultado(cb)) { banco = a; resultado = b; resultadoCl = cb }
    else if (bancos.has(cb) && isResultado(ca)) { banco = b; resultado = a; resultadoCl = ca }
    if (resultado && !liberadas.has(resultadoCl)) {
      flagged.push({
        data: l.data, banco, resultado, historico: l.historico || '',
        valor: (Number(l.debito) || 0) + (Number(l.credito) || 0),
        despesa: /^4/.test(resultadoCl),
      })
    }
  }
  return { temCarga: rows.length > 0, bancos: bancos.size, lancamentos: flagged }
}
