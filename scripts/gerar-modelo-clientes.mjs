// Regenera public/modelo-importacao-clientes.xlsx — a planilha-modelo do cadastro
// de clientes. Sai EM BRANCO (só o cabeçalho, sem clientes de exemplo): cabeçalho
// navy, larguras ajustadas, cabeçalho congelado e listas suspensas nos campos de
// escolha. (Sem logo, a pedido — só o cabeçalho colorido.)
//
// Rodar: node scripts/gerar-modelo-clientes.mjs
import ExcelJS from 'exceljs'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAVY = 'FF1B2A4A'

// Colunas na MESMA ordem/nome que o importador espera (Clientes.jsx).
const COLS = [
  { nome: 'Código no Domínio', largura: 16 },
  { nome: 'Tipo', largura: 12, lista: ['Matriz', 'Filial'] },
  { nome: 'Código da Matriz', largura: 16 },
  { nome: 'Razão Social', largura: 40 },
  { nome: 'Nome Fantasia', largura: 26 },
  { nome: 'CNPJ', largura: 22 },
  { nome: 'Regime Tributário', largura: 22, lista: ['SIMPLES NACIONAL', 'LUCRO PRESUMIDO', 'LUCRO REAL', 'LUCRO REAL TRIMESTRAL', 'ISENTA FEDERAL'] },
  { nome: 'Tipo de Fechamento', largura: 22, lista: ['Consolidado', 'Individualizado'] },
  { nome: 'Prazo de entrega do balancete', largura: 28 },
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
  ['Matriz e filiais ficam na mesma aba: a coluna “Tipo” diz se é Matriz ou Filial, e “Código da Matriz” liga a filial à matriz (obrigatório na filial, em branco na matriz).', ''],
  ['CNPJ é a chave do cadastro — não é possível cadastrar dois clientes com o mesmo CNPJ.', ''],
  ['Tipo de fechamento: “Consolidado” = a filial fecha junto da matriz (não abre fechamento próprio); “Individualizado” = a filial tem fechamento próprio. Na matriz, use “Consolidado”.', ''],
  ['Prazo de entrega do balancete: dia do mês (1 a 31). É esse prazo que alimenta o painel de prazos do dashboard.', ''],
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
const linhaHdr = 1
const ws = wb.addWorksheet('Clientes', { views: [{ state: 'frozen', ySplit: linhaHdr, showGridLines: false }] })
ws.columns = COLS.map(c => ({ width: c.largura }))

const header = ws.getRow(linhaHdr)
header.height = 32
COLS.forEach((c, i) => {
  const cell = header.getCell(i + 1)
  cell.value = c.nome
  cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
})

// Linhas de preenchimento: desenha bordas leves + zebra e coloca as listas
// suspensas, para ficar com cara de planilha (e não um branco total).
const N_LINHAS = 1000
const bordaClara = { style: 'thin', color: { argb: 'FFDCE0E8' } }
const prim = linhaHdr + 1, ult = linhaHdr + N_LINHAS
for (let r = prim; r <= ult; r++) {
  const row = ws.getRow(r)
  const zebra = (r - prim) % 2 === 1
  for (let i = 0; i < COLS.length; i++) {
    const cell = row.getCell(i + 1)
    cell.border = { top: bordaClara, bottom: bordaClara, left: bordaClara, right: bordaClara }
    if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FB' } }
    if (COLS[i].lista) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${COLS[i].lista.join(',')}"`] }
  }
}

const buf = await wb.xlsx.writeBuffer()
writeFileSync(join(raiz, 'public/modelo-importacao-clientes.xlsx'), Buffer.from(buf))
console.log('OK — public/modelo-importacao-clientes.xlsx gerado (em branco, %d colunas).', COLS.length)
