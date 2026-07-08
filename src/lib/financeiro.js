// Memória do financeiro: aprende "histórico do extrato → conta de contrapartida"
// por cliente. A chave é o histórico normalizado (sem datas/números/pontuação),
// para casar o mesmo tipo de lançamento em meses diferentes.

export function normHist(s) {
  return String(s ?? '')
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // acentos
    .replace(/\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?/g, ' ') // datas
    .replace(/\d{3,}/g, ' ')      // documentos/números longos
    .replace(/[^A-Z ]+/g, ' ')    // fica só com letras
    .replace(/\s+/g, ' ')
    .trim()
}

// Casa um histórico com a memória. Retorna a conta de contrapartida (ou '').
// Preferência: igualdade exata da chave; senão, a chave da memória mais longa
// que esteja contida no histórico (mais específica).
export function casarHistorico(historico, memoria) {
  const h = normHist(historico)
  if (!h) return ''
  let exato = null, contido = null
  for (const m of (memoria || [])) {
    const t = String(m.termo || '').trim()
    if (!t) continue
    if (t === h) { exato = m; break }
    if (h.includes(t) && (!contido || t.length > String(contido.termo).length)) contido = m
  }
  const m = exato || contido
  return m ? String(m.conta || '') : ''
}

// Valor em formato BR ("1.234,56") ou US ("1234.56"); negativo por sinal ou (parênteses).
export function parseValor(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '')
  if (!s) return 0
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s)
  s = s.replace(/[()]/g, '').replace(/^-/, '')
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : (neg ? -n : n)
}

// Data (Date do Excel ou "DD/MM/AAAA") → "AAAA-MM-DD" (formato do lançamento).
export function dataISO(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const m = String(v ?? '').trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/)
  if (!m) return ''
  let [, d, mo, y] = m; if (y.length === 2) y = '20' + y
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// Aprende/atualiza a memória com as classificações feitas (termo → conta).
// Substitui o termo se já existir; ignora sem conta.
export function aprender(memoria, novas) {
  const map = new Map((memoria || []).map(m => [String(m.termo), { ...m }]))
  for (const { historico, conta } of (novas || [])) {
    const termo = normHist(historico)
    const c = String(conta || '').trim()
    if (!termo || !c) continue
    map.set(termo, { termo, conta: c })
  }
  return [...map.values()]
}
