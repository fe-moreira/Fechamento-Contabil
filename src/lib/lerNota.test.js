import { describe, it, expect } from 'vitest'
import { extrairNfHistorico } from './lerNota'

describe('extrairNfHistorico', () => {
  it('competência "NF 07/2026" NÃO é nota (é o mês de referência)', () => {
    expect(extrairNfHistorico('VALOR REF. PAGAMENTO GDEANA CONRADO LOPES NF 07/2026')).toBe('')
    expect(extrairNfHistorico('NOTA FISCAL 07/2026')).toBe('')
    expect(extrairNfHistorico('SERV. PREST. NF 12/2025')).toBe('')
  })
  it('não pega pedaço de CNPJ como NF ("57.220.178" → 220)', () => {
    // NF de 1 dígito explícita vence; o CNPJ não polui.
    expect(extrairNfHistorico('VALOR REF. PAGAMENTO 57.220.178 BARBARA BEDIN NF 5')).toBe('5')
    // Sem marcador de NF, CNPJ sozinho NÃO vira nota.
    expect(extrairNfHistorico('PAGAMENTO 57.220.178 BARBARA BEDIN')).toBe('')
  })
  it('aceita NF de 1 dígito explícita ("NF. N.º 6") e ignora ACUM.', () => {
    expect(extrairNfHistorico('DESP. COM TRAD/EDICAO DE TXT E DESENHS - ADM - ACUM. 623 - 57.220.178 BARBARA BEDIN CF. NF. N.º 6')).toBe('6')
  })
  it('nota normal com marcador', () => {
    expect(extrairNfHistorico('VALOR REF. RECEBIMENTO FULANO DE TAL NF 12345')).toBe('12345')
    expect(extrairNfHistorico('RECEBIMENTO CLIENTE Nº 4521')).toBe('4521')
  })
  it('nota de 5 dígitos seguida de ano NÃO é competência (número > 12)', () => {
    expect(extrairNfHistorico('RECEBIMENTO CLIENTE NF 12345/2026')).toBe('12345')
  })
  it('documento do Domínio "1-000584A" → 584 (sem zeros)', () => {
    expect(extrairNfHistorico('VALOR REF. RECEBIMENTO CLIENTE 1-000584A')).toBe('584')
  })
  it('preserva a LETRA da parcela (16557A/B/C são notas distintas)', () => {
    expect(extrairNfHistorico('VALOR REF. COMPRA DE MERCADORIA PARA REVENDA - ALMA TEXTIL CF. NF 16557A')).toBe('16557A')
    expect(extrairNfHistorico('VALOR REF. COMPRA DE MERCADORIA PARA REVENDA - ALMA TEXTIL CF. NF 16557B')).toBe('16557B')
    expect(extrairNfHistorico('COMPRA - ALMA TEXTIL CF. NF 16500c')).toBe('16500C') // normaliza p/ maiúscula
  })
  it('não confunde palavra colada com letra de parcela ("NF 123COMERCIO" → 123)', () => {
    expect(extrairNfHistorico('VALOR REF. NF 123COMERCIO LTDA')).toBe('123')
    expect(extrairNfHistorico('RECEBIMENTO CLIENTE NF 12345 COMERCIO')).toBe('12345')
  })
  it('sem número de nota → vazio', () => {
    expect(extrairNfHistorico('VALOR REF. NAGO COMPANY')).toBe('')
    expect(extrairNfHistorico('VALOR REF. PAGAMENTO PESCUMA INNOVATE IT CONSULTING LTDA NF NOTA DE DÉBITO')).toBe('')
  })
})
