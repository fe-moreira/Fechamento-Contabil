import { describe, it, expect } from 'vitest'
import { apurarResultadoSimples } from './dre.js'

// saldo_final segue a convenção do balancete: receita (grupo 3) é CREDORA (negativa),
// custo/despesa (grupos 4/5) são DEVEDORAS (positivas).
const L = (classif, nome, saldo_final) => ({ classifRaw: classif, nome, saldo_final, sintetica: false })

describe('apurarResultadoSimples — EBITDA é resultado OPERACIONAL (o bug do gráfico da TradeX)', () => {
  it('EBITDA subtrai as despesas operacionais e NÃO conta o resultado financeiro (grupo 5.5)', () => {
    const linhas = [
      L('3.1.1', 'Receita de serviços', -1000),    // receita líquida 1000
      L('4.1.1', 'Custo dos serviços', 200),        // custo 200
      L('5.1.1', 'Despesas administrativas', 300),  // despesa OPERACIONAL 300
      L('5.5.1', 'Despesas financeiras', 100),      // financeiro 100 — FORA do EBITDA
    ]
    const r = apurarResultadoSimples(linhas)
    expect(r.receitaLiquida).toBeCloseTo(1000, 3)
    expect(r.ebitda).toBeCloseTo(500, 3)            // 1000 − 200 − 300 (o financeiro NÃO entra)
    expect(r.financeiro).toBeCloseTo(-100, 3)
    expect(r.lucroLiquido).toBeCloseTo(400, 3)      // ebitda + financeiro
    // A margem EBITDA fica em 50% — nunca mais ~100%.
    expect((r.ebitda / r.receitaLiquida) * 100).toBeCloseTo(50, 1)
  })

  it('depreciação e IR/CSLL ficam FORA do EBITDA (voltam depois, no lucro líquido)', () => {
    const linhas = [
      L('3.1.1', 'Receita', -1000),
      L('5.1.1', 'Salários', 200),
      L('5.2.9', 'Depreciação de equipamentos', 50),
      L('5.8.1', 'IRPJ', 80),
    ]
    const r = apurarResultadoSimples(linhas)
    expect(r.ebitda).toBeCloseTo(800, 3)            // 1000 − 200 (deprec e IR fora)
    expect(r.deprec).toBeCloseTo(-50, 3)
    expect(r.ir).toBeCloseTo(-80, 3)
    expect(r.lucroLiquido).toBeCloseTo(670, 3)      // 800 − 50 − 80
  })

  it('empresa de tecnologia (custo≈0, tudo em despesa) NÃO dá margem EBITDA ~100%', () => {
    // Caso TradeX: sem grupo 4; os gastos estão no grupo 5. Antes, ebitda = receita − custo ≈ receita.
    const linhas = [
      L('3.1.1', 'Receita de tecnologia', -1000),
      L('5.1.1', 'Despesas com pessoal', 600),
      L('5.2.1', 'Despesas administrativas', 150),
    ]
    const r = apurarResultadoSimples(linhas)
    expect(r.ebitda).toBeCloseTo(250, 3)            // 1000 − 750 (e não ~1000)
    expect((r.ebitda / r.receitaLiquida) * 100).toBeCloseTo(25, 1)
  })
})
