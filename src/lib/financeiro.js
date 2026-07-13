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

// Palavras genéricas do histórico do extrato/Domínio — não distinguem um lançamento
// de outro (tipo de operação, documento, sufixo societário). Ignoradas no casamento.
const STOP_HIST = new Set(['VALOR', 'REFERENTE', 'PAGAMENTO', 'PGTO', 'PAGTO', 'RECEBIMENTO', 'RECEBTO', 'RECEB', 'REF', 'DOC', 'DOCTO', 'DOCUMENTO', 'NOTA', 'FISCAL', 'LTDA', 'EPP', 'EIRELI', 'EIRELLI', 'TAR', 'TARIFA', 'CONF'])
// Tokens significativos de um texto (nome/descrição): ≥3 letras e não genéricos.
export function tokensHist(s) {
  return normHist(s).split(' ').filter(t => t.length >= 3 && !STOP_HIST.has(t))
}

// Casa um histórico com a memória por TOKENS significativos (não por substring, que
// quebrava com "PGTO" × "PAGAMENTO" e deixava lixo de 1 letra casar tudo).
// `excluir` = conta(s) que NÃO podem ser contrapartida — o BANCO DO PRÓPRIO EXTRATO
// (ele já é um lado da partida). Outro banco pode ser contrapartida (ex.: transferência).
// 1) termo com TODOS os tokens no histórico vence (o mais específico);
// 2) fallback por SEMELHANÇA: o termo com mais palavras em comum (≥2 e ≥60% do termo)
//    — traz a conta quando "o nome tem muitas coisas iguais" (ex.: Attentive).
// Igual ao casarHistorico, mas devolve { conta, nivel, score } com o NÍVEL DE CONFIANÇA:
//  'alta'  = regra forte (todos os tokens do termo batem) OU ≥80% das palavras do termo;
//  'media' = 60% a 80% das palavras do termo (≥2 em comum) — "confira";
//  ''      = nada casou.
export function casarHistoricoNivel(historico, memoria, excluir) {
  const htoks = new Set(tokensHist(historico))
  if (!htoks.size) return { conta: '', nivel: '', score: 0 }
  const banida = c => excluir && excluir.has && excluir.has(String(c))
  let best = null, bestScore = 0
  for (const m of (memoria || [])) {
    if (banida(m.conta)) continue
    const tt = tokensHist(m.termo)
    if (!tt.length) continue
    if (!tt.every(t => htoks.has(t))) continue
    if (tt.length > bestScore) { bestScore = tt.length; best = m }
  }
  if (best) return { conta: String(best.conta || ''), nivel: 'alta', score: 1 }
  let alt = null, altShared = 0, altFrac = 0
  for (const m of (memoria || [])) {
    if (banida(m.conta)) continue
    const tt = tokensHist(m.termo)
    if (tt.length < 2) continue
    const shared = tt.filter(t => htoks.has(t)).length
    const frac = shared / tt.length
    if (shared >= 2 && frac >= 0.6 && (frac > altFrac || (frac === altFrac && shared > altShared))) { altShared = shared; altFrac = frac; alt = m }
  }
  if (alt) return { conta: String(alt.conta || ''), nivel: altFrac >= 0.8 ? 'alta' : 'media', score: altFrac }
  return { conta: '', nivel: '', score: 0 }
}

export function casarHistorico(historico, memoria, excluir) {
  return casarHistoricoNivel(historico, memoria, excluir).conta
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
  // A célula tem de ser SÓ uma data (opcionalmente com hora) — ancorado no fim para NÃO
  // casar códigos de conta como "1.10.05.0001" (que pareciam "1.10.05" → data e faziam a
  // coluna de natureza ser detectada como Data, deixando os lançamentos "sem data").
  const m = String(v ?? '').trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[ T].*)?$/)
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
    // Só aprende termos com algum token significativo (evita lixo tipo "D", "C",
    // "PAGAMENTO" — que casariam com tudo). Sem token útil, não vira regra.
    if (!termo || !c || !tokensHist(termo).length) continue
    map.set(termo, { termo, conta: c })
  }
  return [...map.values()]
}

// Extrai o credor/devedor (a "entidade") de um texto de histórico livre — pega o
// trecho após " - " e corta em CF/NF/Nº/REF. Usado para semear a memória a partir
// de uma base de lançamentos, casando pelo nome da empresa (sinal da contrapartida).
export function extrairEntidade(s) {
  let e = String(s ?? '')
  // Tira prefixo de operação (PGTO./PAGTO./RECEB.) e o bloco de documento (DOC/CF/NF/Nº/REF).
  e = e.replace(/^\s*(VALOR\s+REFERENTE\s+A\s+)?(PAGAMENTO|PAGTO|PGTO|RECEBIMENTO|RECEBTO|RECEB)\.?\s+/i, '')
  e = e.replace(/\bC[F]?\.?\s*NF.*/i, '').replace(/\bNF.*/i, '').replace(/\bN[ºo°]\.?.*/i, '').replace(/\bREF\.?.*/i, '').replace(/\bDOC.*/i, '')
  // "categoria - entidade": pega a entidade (último trecho). Mas se o último trecho for só
  // sufixo societário (ME/EPP/LTDA/SA) ou muito curto, a entidade é o trecho ANTERIOR
  // (ex.: "LEILA DOMINGUES GARCIA - ME" → "LEILA DOMINGUES GARCIA").
  const parts = e.split(/\s[-–]\s/)
  if (parts.length > 1) {
    const ult = parts[parts.length - 1].trim()
    e = (/^(ME|EPP|EIRELI|LTDA|S\/?A|S\/?S)\.?$/i.test(ult) || normHist(ult).length < 4) ? parts[parts.length - 2] : ult
  }
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
  if (es.modo === 'natureza' && es.col != null && es.col >= 0) {
    // FINANCEIRO (extrato): natureza C (crédito) = ENTRADA, D (débito) = SAÍDA.
    // É o INVERSO da contabilidade — aqui é o extrato bancário do cliente.
    const v = String(r[es.col] ?? '').trim().toUpperCase()
    if (v.startsWith('C')) return true
    if (v.startsWith('D')) return false
    return parseValor(r[p.colValor]) >= 0 // sem indicador na linha → cai no sinal
  }
  if (es.modo === 'coluna' && es.col != null && es.col >= 0) {
    const v = String(r[es.col] ?? '').trim().toUpperCase()
    return (es.entrada || []).map(x => String(x).toUpperCase()).includes(v)
  }
  return parseValor(r[p.colValor]) >= 0 // sinal: negativo = saída, positivo = entrada
}

// Limpa a categoria (coluna mesclada): tira o código contábil do começo e o
// sufixo "Total" dos subtotais.
function limparCategoria(s) {
  return String(s || '').replace(/^[\d.\s]+/, '').replace(/\s+total\s*$/i, '').trim()
}

// Preenche as células MESCLADAS com o valor do canto superior-esquerdo (só onde está
// vazio). Resolve extratos como o Sisloc, em que Data (Dt. Liquidação), Documento e a
// Natureza vêm em células mescladas — sem isso, as linhas "de baixo" da mescla ficam
// vazias (ex.: sobem sem data). Mutação in-place do array (matriz linhas × colunas).
export function expandirMerges(arr, merges) {
  for (const m of (merges || [])) {
    if (!m?.s || !m?.e) continue
    const v = (arr[m.s.r] || [])[m.s.c]
    if (v === '' || v == null) continue
    for (let r = m.s.r; r <= m.e.r; r++) {
      const row = arr[r] || (arr[r] = [])
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue
        if (row[c] === '' || row[c] == null) row[c] = v
      }
    }
  }
  return arr
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
// O documento já está no histórico? (para não duplicar ao juntar). Compara o texto e,
// como reforço, os dígitos — TAR/COB 14/01 no histórico casa com o documento "1401".
function contemDoc(hist, doc) {
  const h = String(hist || '').toUpperCase()
  const d = String(doc || '').trim().toUpperCase()
  if (!d) return true
  if (h.includes(d)) return true
  const dig = d.replace(/\D/g, '')
  return dig.length >= 2 && h.replace(/\D/g, '').includes(dig)
}

export function aplicarPerfil(arr, perfil, memoria, catByRow, adiantContas, bancos) {
  const p = perfil || {}
  const temAdiant = adiantContas && adiantContas.size > 0
  const ini = Number.isInteger(p.linhaInicio) ? p.linhaInicio : 1
  const colHist = (p.colHist != null && p.colHist >= 0) ? p.colHist : -1
  // Compat: perfis antigos sem coluna de Histórico montam por [credor, documento].
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
    // Linha de SUBTOTAL/TOTAL do relatório (ex.: "1.90.01.0006 Irrf Retido Total"): tem
    // valor mas não é lançamento — não sobe (era o que subia "sem data" no Sisloc). Só pula
    // quando a categoria termina em "Total" E a linha não tem data (lançamento real tem data).
    if (temCat && /total(\s+geral)?\s*$/i.test(String(r[p.colCategoria] ?? '').trim())
      && !(p.colData != null && p.colData >= 0 && dataISO(r[p.colData]))) continue
    if (p.filtro?.pularVazio && p.filtro.col != null && p.filtro.col >= 0 && !String(r[p.filtro.col] ?? '').trim()) continue
    // "SALDO ANTERIOR/INICIAL" não é lançamento — é a abertura do extrato (só valida o saldo).
    const descr = colHist >= 0 ? String(r[colHist] ?? '') : histCols.length ? String(r[histCols[0]] ?? '') : ''
    if (/saldo\s+(anterior|inicial)/i.test(descr.normalize('NFD').replace(/[̀-ͯ]/g, ''))) continue
    const entrada = decidirEntrada(r, p)
    const credor = p.colCredor != null && p.colCredor >= 0 ? String(r[p.colCredor] ?? '').trim() : ''
    const doc = p.colDoc != null && p.colDoc >= 0 ? String(r[p.colDoc] ?? '').trim() : ''
    // Base do histórico: a coluna de Histórico (nova) OU o modo antigo (credor+doc).
    // O DOCUMENTO só é juntado quando o histórico AINDA NÃO o contém (evita duplicar) —
    // planilhas com o documento fora do histórico continuam recebendo o documento.
    let partesBase
    if (colHist >= 0) {
      const h = String(r[colHist] ?? '').trim()
      partesBase = [h]
      if (credor && !contemDoc(h, credor)) partesBase.push(credor)
      if (doc && !contemDoc(h, doc)) partesBase.push(doc)
    } else {
      partesBase = histCols.map(c => r[c])
    }
    const partes = temCat ? [limparCategoria(categoria), ...partesBase] : partesBase
    const historico = montarHistorico(entrada, partes)
    const valor = Math.abs(parseValor(r[p.colValor]))
    if (!valor) continue
    const data = p.colData != null && p.colData >= 0 ? dataISO(r[p.colData]) : ''
    // Sempre casa pelo HISTÓRICO (que já traz a descrição/entidade via colHist). Antes
    // usava `credor || historico`, e um credor mal mapeado (ex.: a coluna C/D = "D")
    // fazia casar por "D" e não achar nada.
    const casada = casarHistoricoNivel(historico, memoria, bancos)
    let contra = casada.conta
    let contra_nivel = casada.nivel
    // Regra: se a linha tem nota/documento, não é adiantamento (adiantamento é
    // quando ainda não há nota). Evita "adiantamento a fornecedor/cliente" errado.
    if (doc && contra && temAdiant && adiantContas.has(String(contra))) { contra = ''; contra_nivel = '' }
    out.push({ historico, credor, valor, entrada, data, contra, contra_nivel })
  }
  return out
}
