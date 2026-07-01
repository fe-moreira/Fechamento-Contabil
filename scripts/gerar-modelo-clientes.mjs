// Regenera public/modelo-importacao-clientes.xlsx — a planilha-modelo do cadastro
// de clientes. Sai EM BRANCO (só o cabeçalho, sem clientes de exemplo) e no padrão
// visual da Attentive: logo no topo, cabeçalho navy, larguras ajustadas, cabeçalho
// congelado e listas suspensas nos campos de escolha.
//
// Rodar: node scripts/gerar-modelo-clientes.mjs
import ExcelJS from 'exceljs'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAVY = 'FF1B2A4A'

// Logo reaproveitada do pdf.js (extrai só o data URI, sem executar o módulo).
const pdfSrc = readFileSync(join(raiz, 'src/lib/pdf.js'), 'utf8')
const HEADER_IMG = (pdfSrc.match(/HEADER_IMG\s*=\s*'(data:image\/png;base64,[^']+)'/) || [])[1] || null

// Colunas na MESMA ordem/nome que o importador espera (Clientes.jsx).
const COLS = [
  { nome: 'Código no Domínio', largura: 16 },
  { nome: 'Tipo', largura: 12, lista: ['Matriz', 'Filial'] },
  { nome: 'Código da Matriz', largura: 16 },
  { nome: 'Razão Social', largura: 40 },
  { nome: 'Nome Fantasia', largura: 26 },
  { nome: 'CNPJ', largura: 22 },
  { nome: 'Regime Tributário', largura: 18, lista: ['Simples', 'Presumido', 'Real'] },
  { nome: 'Tipo de Fechamento', largura: 22 },
  { nome: 'Prazo de entrega do balancete', largura: 28, lista: ['Dia 5', 'Dia 10', 'Dia 15', 'Dia 20', 'Dia 25', 'Dia 30'] },
  { nome: 'Competência de início (mm/aaaa)', largura: 26 },
  { nome: 'Fazer carga inicial de saldos', largura: 24, lista: ['Sim', 'Não'] },
  { nome: 'Coleta automática do razão', largura: 24, lista: ['Sim', 'Não'] },
  { nome: 'Sistema financeiro', largura: 20 },
  { nome: 'Integração financeira', largura: 20, lista: ['Não usa', 'Sistema', 'Excel'] },
  { nome: 'Analista responsável', largura: 22 },
  { nome: 'Observações', largura: 40 },
]

const wb = new ExcelJS.Workbook()
wb.creator = 'Attentive Contabilidade'

// ---- Aba Instruções ----
const wi = wb.addWorksheet('Instruções', { views: [{ showGridLines: false }] })
wi.getColumn(1).width = 118
const INSTR = [
  ['Layout de Importação de Clientes — Contabilidade by Attentive', 'titulo'],
  ['', ''],
  ['Preencha uma linha por empresa na aba “Clientes”. Não apague o cabeçalho.', ''],
  ['Matriz e filiais ficam na mesma aba: a coluna “Tipo” diz se é Matriz ou Filial, e “Código da Matriz” liga a filial à matriz (deixe em branco na linha da matriz).', ''],
  ['CNPJ é a chave do cadastro — não é possível cadastrar dois clientes com o mesmo CNPJ.', ''],
  ['Prazo de entrega do balancete: dia do mês (5, 10, 15, 20, 25 ou 30). É esse prazo que alimenta o painel de prazos do dashboard.', ''],
  ['Sistema financeiro (coluna M): qual sistema o cliente usa — ex.: Conta Azul.', ''],
  ['Integração financeira (coluna N): “Excel” habilita a importação por Excel na plataforma; “Sistema” indica que o financeiro vem do próprio sistema (coluna M); “Não usa” quando não há integração.', ''],
]
INSTR.forEach((row, i) => {
  const cell = wi.getCell(i + 1, 1)
  cell.value = row[0]
  cell.font = row[1] === 'titulo' ? { bold: true, size: 14, color: { argb: NAVY } } : { size: 11, color: { argb: 'FF333333' } }
  cell.alignment = { wrapText: true, vertical: 'middle' }
})

// ---- Aba Clientes (em branco) ----
const linhaHdr = HEADER_IMG ? 3 : 1
const ws = wb.addWorksheet('Clientes', { views: [{ state: 'frozen', ySplit: linhaHdr, showGridLines: false }] })
ws.columns = COLS.map(c => ({ width: c.largura }))

if (HEADER_IMG) {
  const id = wb.addImage({ base64: HEADER_IMG.replace(/^data:image\/png;base64,/, ''), extension: 'png' })
  ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 300, height: 49 } })
  ws.getRow(1).height = 40
  ws.mergeCells(2, 1, 2, COLS.length)
  const t = ws.getCell(2, 1)
  t.value = 'Cadastro de Clientes — uma linha por empresa (matriz e filiais)'
  t.font = { italic: true, size: 10, color: { argb: 'FF666666' } }
}

const header = ws.getRow(linhaHdr)
header.height = 32
COLS.forEach((c, i) => {
  const cell = header.getCell(i + 1)
  cell.value = c.nome
  cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
})

// Listas suspensas nas próximas 200 linhas dos campos de escolha.
const prim = linhaHdr + 1, ult = linhaHdr + 200
COLS.forEach((c, i) => {
  if (!c.lista) return
  for (let r = prim; r <= ult; r++) {
    ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.lista.join(',')}"`] }
  }
})

const buf = await wb.xlsx.writeBuffer()
writeFileSync(join(raiz, 'public/modelo-importacao-clientes.xlsx'), Buffer.from(buf))
console.log('OK — public/modelo-importacao-clientes.xlsx gerado (em branco, %d colunas).', COLS.length)
