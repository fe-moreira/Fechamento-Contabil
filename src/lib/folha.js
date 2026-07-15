// Leitura do relatório de rubricas da FOLHA do Domínio (export "row_dados"), compartilhada
// entre a Integração (upload 1 a 1) e a Importação em Massa (um arquivo com várias empresas).
import { parseValor } from './financeiro'

// Colunas das rubricas no relatório do Domínio.
export const COLS_FOLHA = { cod: 'V', nome: 'W', valor: 'Z', pd: 'U' }
// Colunas que identificam a EMPRESA num export multi-empresa (codi_emp / nome_emp / cgce_emp).
export const COLS_EMP = { cod: 'A', nome: 'B', cnpj: 'D' }

export const numFis = v => { if (typeof v === 'number') return v; const n = parseValor(v); return Number.isFinite(n) ? n : 0 }
export const normRub = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')
// Letra da coluna → índice 0-based (A=0, V=21, Z=25).
const colIdx = c => { let n = 0; for (const ch of String(c).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }

// Extrai os eventos [{ cod, nome, valor, pd }] de um conjunto de linhas (array de arrays).
export function eventosDeLinhas(linhas) {
  const cCod = colIdx(COLS_FOLHA.cod), cNome = colIdx(COLS_FOLHA.nome), cVal = colIdx(COLS_FOLHA.valor), cPd = colIdx(COLS_FOLHA.pd)
  const out = []
  for (const r of (linhas || [])) {
    const cod = normRub(r[cCod]); const valor = numFis(r[cVal])
    if (!cod || !valor) continue // pula cabeçalho, linhas em branco e linhas sem código/valor
    out.push({ cod, nome: String(r[cNome] ?? '').trim(), valor, pd: String(r[cPd] ?? '').trim().toUpperCase() })
  }
  return out
}

// Rótulo único de um arquivo de folha: marca a origem de cada evento em `__arq`, para
// COMPLEMENTAR (somar outro arquivo sem apagar o anterior) e EXCLUIR arquivo por arquivo —
// mesma ideia da carga inicial de saldos. `data` é só para exibição.
export function novoRotuloArq(nome) {
  const d = new Date(); const p = n => String(n).padStart(2, '0')
  const data = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  return { arq: `${nome}#${Math.random().toString(36).slice(2, 8)}`, doc: nome, data }
}
// Lista os arquivos que compõem um slot de folha (agrupa os eventos pela origem __arq).
// Usa os metadados `files` quando houver; para dados antigos sem marca, mostra um arquivo só.
export function arquivosDoSlot(a) {
  if (!a) return []
  const cont = {}
  for (const e of (a.eventos || [])) { const k = e.__arq || '__legado'; cont[k] = (cont[k] || 0) + 1 }
  if (a.files?.length) return a.files.map(f => ({ ...f, n: cont[f.arq] || 0 }))
  const ks = Object.keys(cont)
  if (!ks.length || (ks.length === 1 && ks[0] === '__legado')) return [{ arq: '__legado', doc: a.doc || 'Arquivo', data: '', n: cont['__legado'] || (a.eventos || []).length }]
  return ks.map(k => ({ arq: k, doc: k === '__legado' ? (a.doc || 'Arquivo') : k.replace(/#[a-z0-9]+$/, ''), data: '', n: cont[k] }))
}
// Marca todos os eventos com a origem (arq) — para poder complementar/excluir por arquivo.
export function marcarEventos(eventos, arq) {
  return (eventos || []).map(e => ({ ...e, __arq: arq }))
}

// Quebra um export MULTI-EMPRESA por empresa (coluna A = código no Domínio). Cada empresa
// vira { cod, nome, cnpj, linhas, eventos } — os eventos já lidos pela mesma regra acima.
export function folhaPorEmpresa(linhas) {
  const cE = colIdx(COLS_EMP.cod), cN = colIdx(COLS_EMP.nome), cC = colIdx(COLS_EMP.cnpj)
  const map = new Map()
  for (const r of (linhas || [])) {
    const cod = String(r[cE] ?? '').trim()
    if (!cod || !/^\d+$/.test(cod)) continue // cabeçalho e linhas sem código numérico de empresa
    let g = map.get(cod)
    if (!g) { g = { cod, nome: String(r[cN] ?? '').trim(), cnpj: String(r[cC] ?? '').trim(), linhas: [] }; map.set(cod, g) }
    g.linhas.push(r)
  }
  return [...map.values()].map(g => ({ ...g, eventos: eventosDeLinhas(g.linhas) }))
}
