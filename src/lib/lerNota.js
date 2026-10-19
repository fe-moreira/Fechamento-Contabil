// Extrai o NÚMERO DA NOTA (NF) de um histórico de lançamento, de forma robusta.
// É a fonte ÚNICA usada pelos dois leitores de histórico (tela de Conciliação e o
// arrasto de saldo `aberturaArrasto.js`) — a mesma regra dos dois lados.
//
// O histórico do Domínio mistura no texto vários números que NÃO são a nota:
//  - COMPETÊNCIA / mês de referência: "NF 07/2026" → o "07/2026" é o MÊS, não a nota.
//    (recorrentes tipo GDEANA/ELETROPAULO/FOPAG vêm todos com "NF 07/2026" e, lido como
//     "07", colapsavam TODOS os fornecedores na mesma NF.)
//  - CNPJ / CPF: "57.220.178 BARBARA BEDIN" → o "220" (pedaço do CNPJ) virava "NF 220".
//  - ACUMULADOR do Domínio: "ACUM. 623" → não é nota.
// Também aceita NF de 1 dígito quando vem explícita ("NF 5", "NF. N.º 6").
export function extrairNfHistorico(h) {
  const s = String(h || '')
  // Neutraliza CNPJ, CPF e "ACUM. N" para não virarem "número de nota".
  const limpo = s
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, ' ') // CNPJ com filial: 57.220.178/0001-00
    .replace(/\b\d{2}\.\d{3}\.\d{3}\b/g, ' ')                  // CNPJ raiz: 57.220.178
    .replace(/\b\d{3}\.\d{3}\.\d{3}-?\d{0,2}\b/g, ' ')         // CPF: 123.456.789-00
    .replace(/\bACUM(?:ULADOR)?\.?\s*\d+/ig, ' ')             // acumulador do Domínio: ACUM. 623
  // "NF/NOTA/Nº <número>[letra da parcela][ /AAAA ]" — número da nota, 1 a 9 dígitos, com uma
  // LETRA de parcela opcional colada (16557A/B/C são notas DISTINTAS — a letra tem que ficar,
  // senão as parcelas colapsam numa só e o saldo/arrasto perde lançamentos). `nfKey` ignora a
  // letra p/ o casamento por NF; ela serve para diferenciar e exibir a parcela.
  // Tira ZEROS À ESQUERDA do número da nota (nunca são significativos): "003895" → "3895". Sem
  // isso, "NF 003895" e "NF 3895" pareciam notas diferentes em comparações pela NF crua e na tela.
  // Mantém a LETRA da parcela (16557A). Se por acaso vier só zeros, devolve "0".
  const semZeros = n => String(n).replace(/^0+/, '') || '0'
  // Formato SÉRIE-NÚMERO do Domínio colado no marcador: "NF. N 1-000725B" = série 1, nota 000725,
  // parcela B → a nota é o número DEPOIS do traço (725B), NÃO a série (1). Sem isto, "NF 1-000725B"
  // virava "NF 1" (a série) e nenhuma nota casava. m[2] = número da nota; m[3] = letra da parcela.
  const m = limpo.match(/\b(?:NF|NOTA(?:\s+FISCAL)?|N[ºo°])\.?\s*(?:N[ºo°.]*\s*)?(\d{1,9})(?:-(\d{4,7}))?([A-Za-z](?![A-Za-z]))?(\s*\/\s*\d{2,4})?/i)
  if (m) {
    // "<1-12>/<ano>" logo após o marcador = COMPETÊNCIA (mês/ano de referência), não é nota.
    // (só quando NÃO é série-número: "1-000725" não é competência).
    if (!m[2] && m[4] && Number(m[1]) >= 1 && Number(m[1]) <= 12) return ''
    const num = m[2] ? m[2] : m[1] // série-número → o número é a nota; senão o próprio número
    return semZeros(num) + (m[3] ? m[3].toUpperCase() : '')
  }
  // Documento do Domínio "série-número[parcela]" no fim: "1-000584A" → 584 (tira zeros à esquerda).
  const doc = limpo.match(/\b\d{1,3}-(\d{4,7})[A-Za-z]?\b/)
  if (doc) return String(Number(doc[1]))
  // Último recurso: um número "de nota" solto (>=3 dígitos), já sem CNPJ/CPF/ACUM e sem ANO.
  const solto = limpo.replace(/\b(?:19|20)\d{2}\b/g, ' ').match(/\b(\d{3,9})\b/)
  return solto ? semZeros(solto[1]) : ''
}
