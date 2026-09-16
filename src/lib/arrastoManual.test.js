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

describe('descartarBaixadasManuais — trava "baixa que não zera não baixa"', () => {
  it('par completo (título crédito + pagamento débito) baixado e ZERA → remove os dois', () => {
    const lanc = [
      linhaRazao('t', '2026-06-01', 0, 1000), // título crédito 1.000
      linhaRazao('p', '2026-06-05', 1000, 0), // pagamento débito 1.000
    ]
    const audit = [baixaRazao('2026-06-01'), baixaRazao('2026-06-05')]
    expect(descartarBaixadasManuais(lanc, new Set(), audit, CONTA)).toHaveLength(0)
  })

  it('TRAVA: só UMA perna do par reconhecida (reimportação quebrou o vínculo) → NÃO remove, carrega as duas', () => {
    const lanc = [
      linhaRazao('t', '2026-06-01', 0, 1000), // título crédito 1.000 (reconhecido)
      linhaRazao('p', '2026-06-05', 1000, 0), // pagamento débito 1.000 (SEM registro)
    ]
    const audit = [baixaRazao('2026-06-01')] // só o título tem baixa registrada → conjunto não zera
    const abertos = descartarBaixadasManuais(lanc, new Set(), audit, CONTA)
    expect(abertos).toHaveLength(2) // não zera → não baixa → as duas seguem em aberto
    expect(abertos.reduce((s, l) => s + l.debito - l.credito, 0)).toBe(0) // equilibradas
  })

  it('gêmeas: DOIS pares completos baixados (zeram) → remove todos', () => {
    const lanc = [
      linhaRazao('t1', '2026-06-01', 0, 1000), linhaRazao('t2', '2026-06-01', 0, 1000), // 2 títulos crédito
      linhaRazao('p1', '2026-06-05', 1000, 0), linhaRazao('p2', '2026-06-05', 1000, 0), // 2 pagamentos débito
    ]
    const audit = [baixaRazao('2026-06-01'), baixaRazao('2026-06-01'), baixaRazao('2026-06-05'), baixaRazao('2026-06-05')]
    expect(descartarBaixadasManuais(lanc, new Set(), audit, CONTA)).toHaveLength(0)
  })

  it('par título(abertura)+pagamento(razão) sem NF baixado e zera → tira as DUAS pernas', () => {
    const lanc = [
      linhaAbertura('2026-06-01', 0, 1000),   // título: crédito 1.000 (cents -100000)
      linhaRazao('p', '2026-06-05', 1000, 0), // pagamento: débito 1.000
    ]
    const audit = [baixaAbertura('2026-06-01', -100000), baixaRazao('2026-06-05')]
    const abertos = descartarBaixadasManuais(lanc, new Set(), audit, CONTA)
    expect(abertos).toHaveLength(0)
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
