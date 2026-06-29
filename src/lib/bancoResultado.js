import { supabase } from './supabase'

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const isResultado = c => /^[345]/.test(String(c || '').trim())

// Aponta lançamentos que jogam um BANCO direto numa conta de RESULTADO (prefixo 3/4/5)
// que NÃO está liberada na amarração banco × resultado. Despesas (/^4/) exigem
// classificação dedutível/indedutível (LALUR) na justificativa.
export async function apurarBancoResultado(empresaId, compId) {
  const { data: carga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'bancoresult').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const rows = Array.isArray(carga?.dados) ? carga.dados : []

  const bancos = new Set(), liberadas = new Set()
  for (const r of rows) {
    const keys = Object.keys(r)
    const kTipo = keys.find(k => /tipo/.test(norm(k)))
    const kCod = keys.find(k => /cod/.test(norm(k))) || keys.find(k => /conta/.test(norm(k)))
    const tipo = norm(kTipo ? r[kTipo] : '')
    const cod = String((kCod ? r[kCod] : '') ?? '').trim()
    if (!cod) continue
    if (tipo.includes('banco')) bancos.add(cod)
    else if (tipo.includes('result') || tipo.includes('liber')) liberadas.add(cod)
  }

  if (!compId || !bancos.size) return { temCarga: rows.length > 0, bancos: bancos.size, lancamentos: [] }

  const { data: razao } = await supabase.from('razao')
    .select('data, conta, contrapartida, historico, debito, credito').eq('competencia_id', compId)

  const flagged = []
  for (const l of (razao || [])) {
    const a = String(l.conta || '').trim(), b = String(l.contrapartida || '').trim()
    let banco = null, resultado = null
    if (bancos.has(a) && isResultado(b)) { banco = a; resultado = b }
    else if (bancos.has(b) && isResultado(a)) { banco = b; resultado = a }
    if (resultado && !liberadas.has(resultado)) {
      flagged.push({
        data: l.data, banco, resultado, historico: l.historico || '',
        valor: (Number(l.debito) || 0) + (Number(l.credito) || 0),
        despesa: /^4/.test(resultado),
      })
    }
  }
  return { temCarga: rows.length > 0, bancos: bancos.size, lancamentos: flagged }
}
