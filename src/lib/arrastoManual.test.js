import { describe, it, expect } from 'vitest'
import { descartarBaixadasManuais, ehBaixaManualDet } from './arrastoManual.js'

// Regra: só arrasta o que NÃO foi baixado. Automático (Set `baixados`) e manual (auditoria).
// O foco é a COLISÃO de linhas gêmeas sem NF (ex.: FLASH), que quebrava o arrasto (190k / R$1.000).

const CONTA = '7865'
// Baixa manual da PERNA DE RAZÃO: item "conta · data · NF X"
const baixaRazao = (data, nf = '—') => ({ detalhe: 'Confirmado em lote', razao_id: null, item: `${CONTA} · ${data} · NF ${nf}` })
// Baixa manual da PERNA DE ABERTURA: item AB·conta·data·NF··cents (NF vazia aqui)
const baixaAbertura = (data, cents, nf = '') => ({ detalhe: 'Confirmado em lote', razao_id: null, item: `AB·${CONTA}·${data}·${nf}··${cents}` })

const linhaRazao = (id, data, deb, cred, nf = '') => ({ id, data, debito: deb, credito: cred, leitura: { nf } })
const linhaAbertura = (data, deb, cred, nf = '') => ({ _abertura: true, abertura: true, data, debito: deb, credito: cred, leitura: { nf, abertura: true } })

describe('descartarBaixadasManuais — colisão de gêmeas sem NF', () => {
  it('duas gêmeas sem NF, só UMA baixada → arrasta exatamente UMA (não zero, não as duas)', () => {
    const lanc = [
      linhaRazao('a', '2026-06-01', 0, 1000),  // gêmea 1 (crédito 1.000, sem NF)
      linhaRazao('b', '2026-06-01', 0, 1000),  // gêmea 2 (crédito 1.000, sem NF)
    ]
    // uma única baixa registrada para a chave "7865 · 2026-06-01 · NF —"
    const audit = [baixaRazao('2026-06-01')]
    const abertos = descartarBaixadasManuais(lanc, new Set(), audit, CONTA)
    expect(abertos).toHaveLength(1) // consumiu 1, sobrou 1 — NÃO retirou as duas
  })

  it('duas gêmeas, DUAS baixadas → não arrasta nenhuma', () => {
    const lanc = [linhaRazao('a', '2026-06-01', 0, 1000), linhaRazao('b', '2026-06-01', 0, 1000)]
    const audit = [baixaRazao('2026-06-01'), baixaRazao('2026-06-01')]
    expect(descartarBaixadasManuais(lanc, new Set(), audit, CONTA)).toHaveLength(0)
  })

  it('par título(abertura)+pagamento(razão) sem NF baixado → tira as DUAS pernas, equilíbrio zero', () => {
    const lanc = [
      linhaAbertura('2026-06-01', 0, 1000),   // título: crédito 1.000 (cents -100000)
      linhaRazao('p', '2026-06-01', 1000, 0), // pagamento: débito 1.000
    ]
    const audit = [baixaAbertura('2026-06-01', -100000), baixaRazao('2026-06-01')]
    const abertos = descartarBaixadasManuais(lanc, new Set(), audit, CONTA)
    expect(abertos).toHaveLength(0)
    const net = abertos.reduce((s, l) => s + l.debito - l.credito, 0)
    expect(net).toBe(0)
  })

  it('linha do automático (Set baixados) nunca arrasta, mesmo sem baixa manual', () => {
    const l = linhaRazao('x', '2026-06-01', 0, 500, '123')
    const abertos = descartarBaixadasManuais([l], new Set([l]), [], CONTA)
    expect(abertos).toHaveLength(0)
  })

  it('só reconhece baixa MANUAL (detalhe da auditoria); outros detalhes são ignorados', () => {
    expect(ehBaixaManualDet('Confirmado em lote de 3 linhas')).toBe(true)
    expect(ehBaixaManualDet('conexão manual')).toBe(true)
    expect(ehBaixaManualDet('Vínculo aprovado')).toBe(true)
    expect(ehBaixaManualDet('Reabertura')).toBe(false)
    expect(ehBaixaManualDet('')).toBe(false)
  })
})
