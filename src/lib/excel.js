// Planilha Excel (.xlsx) apresentável, no papel timbrado da Attentive — espelha o
// abrePdfTimbrado: logo no topo, título, cabeçalho colorido, blocos por seção,
// subtotais/totais, moeda formatada e rodapé com o endereço. Usa ExcelJS (carregado
// sob demanda) porque a SheetJS grátis não embute imagem nem estiliza células.
import { HEADER_IMG, RODAPE } from './pdf'

const NAVY = 'FF1B2A4A'
const NAVY_LT = 'FFDFE6F3'
const CINZA_TOT = 'FFE9EDF5'
const CINZA_SUB = 'FFF2F2F2'
const borda = { top: { style: 'thin', color: { argb: 'FFCCCCCC' } }, bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } }, left: { style: 'thin', color: { argb: 'FFCCCCCC' } }, right: { style: 'thin', color: { argb: 'FFCCCCCC' } } }

function baixar(buffer, nome) {
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = nome
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
}

// gerarExcelTimbrado({ titulo, sub?, colunas, linhas?|secoes?, totais?, arquivo, aba? })
// - colunas: [{ nome, alinhar?: 'right', moeda?: bool, largura?: n, wrap?: bool }]
// - linhas:  array de arrays (use NÚMEROS nas colunas de moeda p/ formatar certo).
// - secoes:  [{ titulo, linhas, totais? }] → relatório em blocos (ex.: por cliente).
// - totais:  array de células do rodapé da tabela (TOTAL GERAL).
// Passe `retornarBuffer: true` para receber o ArrayBuffer do .xlsx (em vez de baixar) —
// usado para empacotar a planilha num .zip junto com os anexos. Uma célula pode ser um
// objeto { text, hyperlink } → vira um link clicável (ex.: caminho relativo "anexos/x.pdf").
export async function gerarExcelTimbrado({ titulo, sub = '', colunas, linhas, secoes, totais, arquivo, aba = 'Relatório', retornarBuffer = false }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Attentive Contabilidade'
  const ws = wb.addWorksheet(String(aba).slice(0, 28) || 'Relatório', { views: [{ showGridLines: false }] })
  const n = colunas.length

  ws.columns = colunas.map(c => ({ width: c.largura || (c.moeda ? 16 : 22) }))

  // Logo no topo.
  try {
    const id = wb.addImage({ base64: HEADER_IMG.replace(/^data:image\/png;base64,/, ''), extension: 'png' })
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 300, height: 49 } })
  } catch { /* sem logo se a imagem falhar */ }
  ws.getRow(1).height = 40

  // Título + subtítulo.
  ws.mergeCells(2, 1, 2, n)
  const tit = ws.getCell(2, 1)
  tit.value = titulo; tit.font = { bold: true, size: 14, color: { argb: NAVY } }
  let r = 4
  if (sub) {
    ws.mergeCells(3, 1, 3, n)
    const s = ws.getCell(3, 1)
    s.value = sub; s.font = { size: 10, color: { argb: 'FF666666' } }
    r = 5
  }

  // Cabeçalho.
  const hdr = ws.getRow(r); hdr.height = 20
  colunas.forEach((c, i) => {
    const cell = hdr.getCell(i + 1)
    cell.value = c.nome
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    cell.alignment = { horizontal: c.alinhar === 'right' ? 'right' : 'left', vertical: 'middle' }
    cell.border = borda
  })
  r++

  const linha = (cells, opt = {}) => {
    const row = ws.getRow(r)
    for (let i = 0; i < n; i++) {
      const cell = row.getCell(i + 1)
      const col = colunas[i] || {}
      const val = cells[i]
      const ehLink = val && typeof val === 'object' && val.hyperlink
      cell.value = (val === undefined || val === null) ? '' : val
      cell.border = borda
      cell.alignment = { horizontal: col.alinhar === 'right' ? 'right' : 'left', vertical: 'top', wrapText: !!col.wrap }
      if (ehLink) cell.font = { color: { argb: 'FF0563C1' }, underline: true }
      if (col.moeda && typeof val === 'number') cell.numFmt = '#,##0.00'
      if (opt.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } }
      if (opt.bold) cell.font = { bold: true }
    }
    r++
  }

  if (secoes) {
    if (!secoes.length) linha([n > 0 ? 'Sem lançamentos.' : ''])
    for (const sec of secoes) {
      ws.mergeCells(r, 1, r, n)
      for (let c = 1; c <= n; c++) ws.getCell(r, c).border = borda
      const g = ws.getCell(r, 1)
      g.value = sec.titulo; g.font = { bold: true, color: { argb: NAVY } }
      g.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY_LT } }
      r++
      for (const ln of sec.linhas) linha(ln)
      if (sec.totais) linha(sec.totais, { fill: CINZA_SUB, bold: true })
    }
  } else {
    if (!(linhas || []).length) linha(['Sem lançamentos.'])
    for (const ln of (linhas || [])) linha(ln)
  }
  if (totais) linha(totais, { fill: CINZA_TOT, bold: true })

  // Rodapé com o endereço.
  r++
  ws.mergeCells(r, 1, r, n)
  const foot = ws.getCell(r, 1)
  foot.value = RODAPE; foot.font = { size: 8, color: { argb: 'FF888888' } }; foot.alignment = { horizontal: 'center' }

  const buffer = await wb.xlsx.writeBuffer()
  if (retornarBuffer) return buffer
  baixar(buffer, arquivo)
}

// Excel no PADRÃO DOMÍNIO (sem timbre): cabeçalho Empresa/CNPJ/Período, título e a
// tabela com cabeçalho cinza. linhas: array de arrays; `sint` (índices em negrito) marca
// as linhas sintéticas. colunas: [{ nome, alinhar?, moeda?, largura? }].
export async function gerarExcelDominio({ empresa = '', cnpj = '', periodo = '', titulo, colunas, linhas, sint = new Set(), arquivo, aba = 'Relatório' }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(String(aba).slice(0, 28) || 'Relatório', { views: [{ showGridLines: false }] })
  const n = colunas.length
  ws.columns = colunas.map(c => ({ width: c.largura || (c.moeda ? 15 : 22) }))

  ws.getCell(1, 1).value = `Empresa: ${empresa}`
  ws.getCell(2, 1).value = `C.N.P.J.: ${cnpj}`
  ws.getCell(3, 1).value = `Período: ${periodo}`
  for (let r = 1; r <= 3; r++) ws.getCell(r, 1).font = { size: 10, bold: r === 1 }
  ws.mergeCells(5, 1, 5, n)
  const t = ws.getCell(5, 1); t.value = titulo; t.font = { bold: true, size: 12 }; t.alignment = { horizontal: 'center' }

  const hdr = ws.getRow(7); hdr.height = 18
  colunas.forEach((c, i) => {
    const cell = hdr.getCell(i + 1)
    cell.value = c.nome
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } }
    cell.alignment = { horizontal: c.alinhar === 'right' ? 'right' : 'left' }
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }
  })
  let r = 8
  for (let li = 0; li < (linhas || []).length; li++) {
    const row = ws.getRow(r)
    const negrito = sint.has(li)
    for (let i = 0; i < n; i++) {
      const col = colunas[i] || {}
      const val = linhas[li][i]
      const cell = row.getCell(i + 1)
      cell.value = (val === undefined || val === null) ? '' : val
      cell.alignment = { horizontal: col.alinhar === 'right' ? 'right' : 'left' }
      if (col.moeda && typeof val === 'number') cell.numFmt = '#,##0.00'
      if (negrito) cell.font = { bold: true }
    }
    r++
  }
  baixar(await wb.xlsx.writeBuffer(), arquivo)
}
