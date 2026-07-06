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

// Palpite do saldo do extrato: procura a última menção a "saldo" com um valor
// monetário perto; senão, pega o último valor monetário do texto.
export function palpiteSaldo(texto) {
  const parse = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'))
  const alvos = [...String(texto || '').matchAll(/saldo[^\n]{0,80}?(-?\d{1,3}(?:\.\d{3})*,\d{2})/gi)]
  if (alvos.length) return parse(alvos[alvos.length - 1][1])
  const todos = String(texto || '').match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g)
  return todos && todos.length ? parse(todos[todos.length - 1]) : null
}
