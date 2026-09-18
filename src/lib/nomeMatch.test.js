import { describe, it, expect, vi } from 'vitest'
// aberturaArrasto importa supabase (que precisa de env) — mocka pra conseguir importar as funções puras.
vi.mock('./supabase', () => ({ supabase: {} }))
const { tokensNome, mesmoCliente } = await import('./aberturaArrasto.js')

const mesmo = (a, b) => mesmoCliente(tokensNome(a), tokensNome(b))

describe('matcher de nome — ignora tipo de transação (título × pagamento juntam; fornecedores diferentes não)', () => {
  it('FLASH: título e pagamento (com "VALE TRANSPORTE" na frente) são o MESMO fornecedor', () => {
    const titulo = 'FLASH TECNOLOGIA E INSTITUICAO DE PAGAMENTO'
    const pagamento = 'VALE TRANSPORTE FLASH TECNOLOGIA E INSTITUICAO DE PAGAMENTO'
    expect(mesmo(titulo, pagamento)).toBe(true)
  })
  it('ALMA: "COMPRA DE MERCADORIA PARA REVENDA ALMA TEXTIL" = "ALMA TEXTIL"', () => {
    expect(mesmo('ALMA TEXTIL', 'COMPRA DE MERCADORIA PARA REVENDA ALMA TEXTIL')).toBe(true)
  })
  it('FLASH e LALAMOVE são fornecedores DIFERENTES (não juntam)', () => {
    expect(mesmo('FLASH TECNOLOGIA E INSTITUICAO DE PAGAMENTO',
      'FRETES E CARRETOS DE MATERIAIS MANUFATURADOS LALAMOVE TECNOLOGIA BRASIL')).toBe(false)
  })
  it('ESCORAMAX e MEGA PLATE são diferentes (só compartilhavam o prefixo "MATERIA PRIMA…")', () => {
    expect(mesmo('MATERIA PRIMA - INDUSTRIALIZACAO PARA VENDA ESCORAMAX',
      'MATERIA PRIMA - INDUSTRIALIZACAO PARA VENDA MEGA PLATE COMERCIO DE FERRO E ACO')).toBe(false)
  })
  it('MAC-LEN e HGX são diferentes (só compartilham IMPORTACAO/EXPORTACAO, que são genéricos)', () => {
    expect(mesmo('MAC-LEN COMERCIAL IMPORTACAO E EXPORTACAO', 'HGX IMPORTACAO EXPORTACAO LTDA')).toBe(false)
    // mas duas variações do MESMO HGX continuam juntas:
    expect(mesmo('HGX IMPORTACAO EXPORTACAO LTDA', 'HGX IMPORTACAO E EXPORTACAO')).toBe(true)
  })
})
