// Leitura de PDF no navegador (extrato do cliente). pdfjs é pesado, então este
// módulo é carregado sob demanda (import dinâmico) só quando importa-se um PDF.
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

// Extrai todo o texto do PDF (todas as páginas). Agrupa os itens por LINHA
// (coordenada Y) e ordena por COLUNA (X): extratos são colunares e o pdfjs às
// vezes emite os itens fora da ordem de leitura, o que separaria o rótulo
// ("SALDO DIA") do valor. Assim cada linha do extrato vira uma linha de texto.
export async function extrairTextoPdf(file) {
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  let texto = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const linhas = new Map()
    for (const it of content.items) {
      if (!it.str) continue
      const y = Math.round((it.transform?.[5] ?? 0) / 2) * 2 // agrupa Y próximos (mesma linha)
      const x = it.transform?.[4] ?? 0
      if (!linhas.has(y)) linhas.set(y, [])
      linhas.get(y).push({ x, s: it.str })
    }
    const ys = [...linhas.keys()].sort((a, b) => b - a) // topo → base
    for (const y of ys) {
      texto += linhas.get(y).sort((a, b) => a.x - b.x).map(o => o.s).join(' ') + '\n'
    }
  }
  return texto
}

// OCR: quando o PDF é uma IMAGEM (ex.: "Microsoft Print to PDF" da tela da
// Caixa), não há texto para extrair. Aqui renderizamos cada página em imagem e
// lemos com o Tesseract (português). É pesado, então só é chamado quando o PDF
// não tem texto. Lê da última página para a primeira (o "SALDO DIA" do último
// dia fica no fim) e para assim que encontra um saldo.
export async function ocrPdf(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const worker = await createWorker('por', 1, {
    logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress) },
  })
  try {
    let texto = ''
    for (let p = doc.numPages; p >= 1; p--) {
      const page = await doc.getPage(p)
      const viewport = page.getViewport({ scale: 2 }) // 2x melhora o reconhecimento
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      const { data } = await worker.recognize(canvas)
      texto = data.text + '\n' + texto // mantém a ordem das páginas
      if (palpiteSaldo(texto) != null) break // achou o saldo — não precisa ler o resto
    }
    return texto
  } finally {
    await worker.terminate()
  }
}

// Palpite do saldo do extrato. Prioriza o saldo da CONTA CORRENTE — muitos
// bancos (ex.: Itaú) mostram também um "saldo final" que SOMA o investimento,
// e não é o que vai para a conta contábil do banco.
export function palpiteSaldo(texto, alvo) {
  const parse = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'))
  const t = String(texto || '')
  const V = '(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2})'
  // 0) Se sabemos o saldo da CONTA (alvo), procura no documento o número que bate com
  //    ele em MÓDULO (só o valor importa — passivo/guia vem positivo). É o sinal mais
  //    forte e evita "pegar o último número" quando o saldo aparece no meio do arquivo.
  if (alvo != null && Math.abs(alvo) > 0.005) {
    const nums = t.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g) || []
    let best = null
    for (const m of nums) { const n = parse(m); const d = Math.abs(Math.abs(n) - Math.abs(alvo)); if (best == null || d < best.d) best = { n, d } }
    if (best && best.d <= 0.05) return best.n
  }
  // Pega a ÚLTIMA ocorrência de um rótulo com valor (extrato lista um "saldo do
  // dia" por dia → o do último dia é o que vale).
  const ultimo = (rot) => {
    const ms = [...t.matchAll(new RegExp(rot + '[^\\n]{0,160}?' + V, 'gi'))]
    return ms.length ? parse(ms[ms.length - 1][1]) : null
  }
  // Prioriza a CONTA CORRENTE / saldo do dia — não o "saldo final/total" que
  // soma investimento (Itaú), e cobre "SALDO DIA" sem "do" (Caixa).
  for (const rot of ['saldo\\s+em\\s+c\\s*\\/?\\s*c', 'saldo[^\\n]{0,25}?conta\\s+corrente', 'saldo\\s+(?:do\\s+)?dia', 'saldo\\s+dispon[ií]vel']) {
    const v = ultimo(rot); if (v != null) return v
  }
  // senão: última menção a "saldo" com valor.
  const alvos = [...t.matchAll(new RegExp('saldo[^\\n]{0,160}?' + V, 'gi'))]
  if (alvos.length) return parse(alvos[alvos.length - 1][1])
  // por fim: último valor monetário do documento.
  const todos = t.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g)
  return todos && todos.length ? parse(todos[todos.length - 1]) : null
}
