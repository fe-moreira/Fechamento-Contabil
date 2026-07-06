// Geração do arquivo de importação do Domínio (CSV). Mesmo formato usado no
// painel Contabilizar — centralizado aqui para o Status reutilizar sem divergir.

export function historicoDominio(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toUpperCase()
    .replace(/[^A-Z0-9 .,\-/]/g, ' ')                 // troca o resto por espaço
    .replace(/\s+/g, ' ')
    .trim()
}

export function baixarCsv(conteudo, nome) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8;' }))
  a.download = nome
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
}

// Gera e baixa o CSV de importação do Domínio a partir dos lançamentos.
export function gerarDominioCSV(lancamentos, nome = 'lanctos_dominio.csv') {
  const hdr = ['Data', 'Cód. Conta Debito', 'Cód. Conta Credito', 'Valor', 'Cód. Histórico', 'Complemento Histórico', 'Inicia Lote', 'Código Matriz/Filial', 'Centro de Custo Débito', 'Centro de Custo Crédito']
  const linhas = [hdr.join(';')]
  lancamentos.forEach((l, i) => {
    const v = (Number(l.valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const data = l.data ? l.data.split('-').reverse().join('/') : ''
    linhas.push([data, l.conta_debito || '', l.conta_credito || '', v, '', historicoDominio(l.historico), i === 0 ? '1' : '', '9999', '', ''].join(';'))
  })
  baixarCsv('﻿' + linhas.join('\r\n'), nome)
}
