import { historicoDominio } from './dominio'

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

// Extrai o credor/devedor (a "entidade") de um texto de histórico livre — pega o
// trecho após " - " e corta em CF/NF/Nº/REF. Usado para semear a memória a partir
// de uma base de lançamentos, casando pelo nome da empresa (sinal da contrapartida).
export function extrairEntidade(s) {
  let e = String(s ?? '')
  const parts = e.split(/\s-\s/)
  if (parts.length > 1) e = parts[parts.length - 1]
  e = e.replace(/\bC[F]?\.?\s*NF.*/i, '').replace(/\bNF.*/i, '').replace(/\bN[ºo°]\.?.*/i, '').replace(/\bREF\.?.*/i, '')
  return normHist(e)
}

// Um termo só serve para semear a memória a partir de texto livre se parecer um
// NOME DE EMPRESA — evita casar por palavras genéricas curtas ("ME", "IPI", "REDES").
export function ehEmpresa(t) {
  const s = String(t || '').trim()
  const palavras = s.split(' ').filter(Boolean).length
  return (palavras >= 2 && s.length >= 12) || /(LTDA|SPE|EPP|S A|S S|SA)$/.test(s)
}

// ----- Perfil de importação por cliente (cada cliente exporta diferente) -----
// Normaliza qualquer extrato para um layout único. O histórico sai no padrão do
// Domínio ("VALOR REFERENTE A PAGAMENTO/RECEBIMENTO" + credor + documento),
// sempre sem acento/caractere especial.
export function montarHistorico(entrada, partes) {
  const prefixo = entrada ? 'VALOR REFERENTE A RECEBIMENTO' : 'VALOR REFERENTE A PAGAMENTO'
  const txt = [prefixo, ...(partes || []).map(p => String(p ?? '').trim()).filter(Boolean)].join(' ')
  return historicoDominio(txt)
}

// Entrada (recebimento) x saída (pagamento): por uma coluna indicadora
// (ex.: Origem = CAR/CAP) ou pelo sinal do valor.
function decidirEntrada(r, p) {
  const es = p.es || { modo: 'sinal' }
  if (es.modo === 'coluna' && es.col != null && es.col >= 0) {
    const v = String(r[es.col] ?? '').trim().toUpperCase()
    return (es.entrada || []).map(x => String(x).toUpperCase()).includes(v)
  }
  return parseValor(r[p.colValor]) >= 0
}

// Limpa a categoria (coluna mesclada): tira o código contábil do começo e o
// sufixo "Total" dos subtotais.
function limparCategoria(s) {
  return String(s || '').replace(/^[\d.\s]+/, '').replace(/\s+total\s*$/i, '').trim()
}

// Mapa linha→categoria a partir das células mescladas da coluna 0. Usa só as
// faixas de categoria (mescla estreita, cols 0..~6), ignorando as linhas-total
// de largura total e o sufixo "Total". Corrige o layout hierárquico do Sisloc.
export function catByRowDeMerges(merges, arr) {
  const map = []
  for (const m of (merges || [])) {
    if (m.s?.c === 0 && (m.e.c - m.s.c) <= 10) {
      const val = String((arr[m.s.r] || [])[0] ?? '').trim()
      if (val && !/total\s*$/i.test(val)) for (let r = m.s.r; r <= m.e.r; r++) map[r] = val
    }
  }
  return map
}

// Aplica um perfil a uma planilha crua (matriz de linhas). Retorna
// [{ historico, credor, valor, entrada, data, contra }] classificado pela memória
// (casando pelo credor/devedor). Se houver coluna de categoria (mesclada), ela é
// arrastada pra baixo (forward-fill) e entra no histórico.
export function aplicarPerfil(arr, perfil, memoria, catByRow, adiantContas) {
  const p = perfil || {}
  const temAdiant = adiantContas && adiantContas.size > 0
  const ini = Number.isInteger(p.linhaInicio) ? p.linhaInicio : 1
  const histCols = (p.histCols && p.histCols.length ? p.histCols : [p.colCredor, p.colDoc]).filter(c => c != null && c >= 0)
  const temCat = p.colCategoria != null && p.colCategoria >= 0
  const rows = arr || []
  let catAtual = ''
  const out = []
  for (let idx = ini; idx < rows.length; idx++) {
    const r = rows[idx] || []
    // Categoria: se o arquivo trouxe as faixas de células mescladas (catByRow),
    // usa a faixa (correto p/ layout hierárquico do Sisloc); senão, arrasta pra baixo.
    let categoria = ''
    if (temCat) {
      if (catByRow && catByRow[idx]) categoria = catByRow[idx]
      else { const v = String(r[p.colCategoria] ?? '').trim(); if (v && !/total\s*$/i.test(v)) catAtual = v; categoria = catAtual }
    }
    if (!r || !r.some(c => c !== '' && c != null)) continue
    if (p.filtro?.pularVazio && p.filtro.col != null && p.filtro.col >= 0 && !String(r[p.filtro.col] ?? '').trim()) continue
    const entrada = decidirEntrada(r, p)
    const credor = p.colCredor != null && p.colCredor >= 0 ? String(r[p.colCredor] ?? '').trim() : ''
    const partes = temCat ? [limparCategoria(categoria), ...histCols.map(c => r[c])] : histCols.map(c => r[c])
    const historico = montarHistorico(entrada, partes)
    const valor = Math.abs(parseValor(r[p.colValor]))
    if (!valor) continue
    const data = p.colData != null && p.colData >= 0 ? dataISO(r[p.colData]) : ''
    const doc = p.colDoc != null && p.colDoc >= 0 ? String(r[p.colDoc] ?? '').trim() : ''
    let contra = casarHistorico(credor || historico, memoria)
    // Regra: se a linha tem nota/documento, não é adiantamento (adiantamento é
    // quando ainda não há nota). Evita "adiantamento a fornecedor/cliente" errado.
    if (doc && contra && temAdiant && adiantContas.has(String(contra))) contra = ''
    out.push({ historico, credor, valor, entrada, data, contra })
  }
  return out
}
