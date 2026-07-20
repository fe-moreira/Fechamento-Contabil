// ============================================================================
// Cronograma de apropriação de contratos (seguro / despesa a apropriar).
// FONTE ÚNICA — usada pela tela Outras Contabilizações, pelas Sugestões do razão
// e pelo cálculo do SALDO INICIAL (lib/outras.js). Antes esta lógica estava
// duplicada em três lugares e divergia (o saldo inicial ignorava o "por dia").
// ============================================================================

export const r2 = v => Math.round((v || 0) * 100) / 100
export function parseISO(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null }

// Cronograma de apropriação de um contrato: lista [{comp:'MM/AAAA', valor, dias?}].
// metodo 'dia' = proporcional aos dias de cada mês dentro da vigência (oscila mês a
// mês); metodo 'igual' = parcelas iguais (a última absorve o arredondamento).
export function cronogramaContrato(c, metodo) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  const vi = parseISO(c.vigencia_inicio)
  if (metodo === 'dia') {
    const vf = parseISO(c.vigencia_fim)
    if (!vi || !vf || vf < vi || !total) return []
    const totalDias = Math.round((vf - vi) / 86400000) + 1
    const linhas = []
    let cursor = new Date(vi.getFullYear(), vi.getMonth(), vi.getDate()), acum = 0
    while (cursor <= vf) {
      const ano = cursor.getFullYear(), mes = cursor.getMonth()
      const fimMes = new Date(ano, mes + 1, 0)
      const ate = fimMes < vf ? fimMes : vf
      const dias = Math.round((ate - cursor) / 86400000) + 1
      const prox = new Date(ano, mes + 1, 1)
      const valor = prox > vf ? r2(total - acum) : r2(total * dias / totalDias)
      acum = r2(acum + valor)
      linhas.push({ comp: `${String(mes + 1).padStart(2, '0')}/${ano}`, valor, dias })
      cursor = prox
    }
    return linhas
  }
  // parcelas iguais
  const nParc = Number(c.num_parcelas) || 0
  const mensal = Number(c.valor_parcela) || (nParc ? total / nParc : 0)
  const linhas = []
  if (vi && mensal > 0 && nParc > 0) {
    let ym = vi.getFullYear() * 12 + vi.getMonth()
    for (let i = 0; i < nParc; i++) {
      const ano = Math.floor(ym / 12), mes = (ym % 12) + 1
      const valor = i === nParc - 1 ? r2(total - mensal * (nParc - 1)) : r2(mensal)
      linhas.push({ comp: `${String(mes).padStart(2, '0')}/${ano}`, valor })
      ym++
    }
  }
  return linhas
}

// Saldo que AINDA falta apropriar de um contrato no início da competência de
// abertura do cliente (compIni em "MM/AAAA"): total menos a soma das parcelas de
// competências ANTERIORES à abertura. Usa o MESMO cronograma da tela (respeita
// "por dia"), então bate exatamente com o "a apropriar após" mostrado no modal de
// apropriações — é o valor que deve virar SALDO INICIAL na carga.
export function saldoAApropriarNaAbertura(c, compIni) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  if (!total) return 0
  const mi = String(compIni || '').match(/^(\d{2})\/(\d{4})$/)
  if (!mi) return r2(total) // sem competência de abertura, assume tudo a apropriar
  const corteAbs = Number(mi[2]) * 12 + Number(mi[1])
  const sched = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual')
  if (sched.length) {
    let acumAntes = 0
    for (const s of sched) {
      const [m, a] = s.comp.split('/').map(Number)
      if (a * 12 + m < corteAbs) acumAntes = r2(acumAntes + s.valor)
    }
    return Math.max(0, r2(total - acumAntes))
  }
  // Sem cronograma (faltam datas/nº de parcelas): cai no cálculo por parcelas iguais.
  const nParc = Number(c.num_parcelas) || 0
  const mensal = Number(c.valor_parcela) || (nParc ? total / nParc : 0)
  const vi = String(c.vigencia_inicio || '').match(/^(\d{4})-(\d{2})/)
  if (!mensal || !vi) return r2(total)
  const mesesAntes = corteAbs - (Number(vi[1]) * 12 + Number(vi[2]))
  const apropriadas = Math.max(0, Math.min(mesesAntes, nParc || mesesAntes))
  return Math.max(0, r2(total - apropriadas * mensal))
}
