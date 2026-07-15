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
