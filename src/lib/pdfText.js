// Leitura de PDF no navegador (extrato do cliente). pdfjs é pesado, então este
// módulo é carregado sob demanda (import dinâmico) só quando importa-se um PDF.
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

// Extrai todo o texto do PDF (todas as páginas).
export async function extrairTextoPdf(file) {
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  let texto = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    texto += content.items.map(i => i.str).join(' ') + '\n'
  }
  return texto
}

// Palpite do saldo do extrato. Prioriza o saldo da CONTA CORRENTE — muitos
// bancos (ex.: Itaú) mostram também um "saldo final" que SOMA o investimento,
// e não é o que vai para a conta contábil do banco.
export function palpiteSaldo(texto) {
  const parse = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'))
  const t = String(texto || '')
  const V = '(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2})'
  // Pega a ÚLTIMA ocorrência de um rótulo com valor (extrato lista um "saldo do
  // dia" por dia → o do último dia é o que vale).
  const ultimo = (rot) => {
    const ms = [...t.matchAll(new RegExp(rot + '[^\\n]{0,90}?' + V, 'gi'))]
    return ms.length ? parse(ms[ms.length - 1][1]) : null
  }
  // Prioriza a CONTA CORRENTE / saldo do dia — não o "saldo final/total" que
  // soma investimento (Itaú), e cobre "SALDO DIA" sem "do" (Caixa).
  for (const rot of ['saldo\\s+em\\s+c\\s*\\/?\\s*c', 'saldo[^\\n]{0,25}?conta\\s+corrente', 'saldo\\s+(?:do\\s+)?dia', 'saldo\\s+dispon[ií]vel']) {
    const v = ultimo(rot); if (v != null) return v
  }
  // senão: última menção a "saldo" com valor.
  const alvos = [...t.matchAll(new RegExp('saldo[^\\n]{0,90}?' + V, 'gi'))]
  if (alvos.length) return parse(alvos[alvos.length - 1][1])
  // por fim: último valor monetário do documento.
  const todos = t.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g)
  return todos && todos.length ? parse(todos[todos.length - 1]) : null
}
