// Relatório de Distribuição de Lucros / JCP por empresa (para gerar em massa, zipado).
// Fonte: dist_lucros_config.ata.socios ({ nome, cpf, conta, valor, pagamentos:[{data,valor}] }).
// Separa por CONTA CONTÁBIL; filtra os pagamentos pela DATA DO PAGAMENTO dentro do período.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { HEADER_IMG, RODAPE } from './pdf'

const NAVY = [27, 42, 74]
const BAND = [223, 230, 243]
const money = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const brData = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }
const p2 = x => String(x).padStart(2, '0')
const ultimoDia = (ano, mes) => new Date(ano, mes, 0).getDate() // mes 1-12

// Período selecionável → { label (nome do arquivo), ini, fim (ISO), titulo (no PDF) }.
//  mensal 202601 · trimestral 1T2026 · semestral 1S2026 · anual 2026
export function periodoDistribuicao(tipo, ano, n) {
  ano = Number(ano); n = Number(n) || 1
  if (tipo === 'mensal') return { label: `${ano}${p2(n)}`, ini: `${ano}-${p2(n)}-01`, fim: `${ano}-${p2(n)}-${p2(ultimoDia(ano, n))}`, titulo: `${p2(n)}/${ano}` }
  if (tipo === 'trimestral') { const m0 = (n - 1) * 3 + 1, mf = m0 + 2; return { label: `${n}T${ano}`, ini: `${ano}-${p2(m0)}-01`, fim: `${ano}-${p2(mf)}-${p2(ultimoDia(ano, mf))}`, titulo: `${n}º Trimestre / ${ano}` } }
  if (tipo === 'semestral') { const m0 = (n - 1) * 6 + 1, mf = m0 + 5; return { label: `${n}S${ano}`, ini: `${ano}-${p2(m0)}-01`, fim: `${ano}-${p2(mf)}-${p2(ultimoDia(ano, mf))}`, titulo: `${n}º Semestre / ${ano}` } }
  return { label: `${ano}`, ini: `${ano}-01-01`, fim: `${ano}-12-31`, titulo: `Ano ${ano}` }
}

// Agrupa os pagamentos do período por conta contábil. `nomeMap[cod] = nome da conta`.
export function montarDistribuicao(cfg, nomeMap, ini, fim) {
  const socios = cfg?.ata?.socios || []
  const grupos = new Map()
  let total = 0
  for (const s of socios) {
    const conta = String(s.conta || '').trim() || '—'
    const pags = (s.pagamentos || []).filter(p => p.data && p.data >= ini && p.data <= fim)
    if (!pags.length) continue
    const g = grupos.get(conta) || { conta, contaNome: (nomeMap && nomeMap[conta]) || '', itens: [], subtotal: 0 }
    for (const p of pags.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
      const v = Number(p.valor) || 0
      g.itens.push({ nome: s.nome || '—', cpf: s.cpf || '', data: p.data, valor: v })
      g.subtotal = Math.round((g.subtotal + v) * 100) / 100
      total = Math.round((total + v) * 100) / 100
    }
    grupos.set(conta, g)
  }
  return { secoes: [...grupos.values()].sort((a, b) => String(a.conta).localeCompare(String(b.conta))), total }
}

// Gera o PDF (Blob) de UMA empresa no papel timbrado.
export function pdfDistribuicao({ empresaCod, empresaNome, cnpj, periodoTitulo, dados }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const chrome = () => {
    try { doc.addImage(HEADER_IMG, 'PNG', 28, 16, W - 56, 42) } catch { /* sem logo */ }
    doc.setFontSize(7); doc.setTextColor(130)
    doc.text(String(RODAPE), W / 2, H - 18, { align: 'center', maxWidth: W - 56 })
    doc.setTextColor(0)
  }
  // Título + empresa (só na 1ª página; as demais repetem o cabeçalho via didDrawPage).
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...NAVY)
  doc.text('Distribuição de Lucros / JCP', 28, 82)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(70)
  doc.text(`${empresaCod} · ${empresaNome}${cnpj ? '   —   CNPJ ' + cnpj : ''}`, 28, 97)
  doc.setFontSize(9.5); doc.setTextColor(110)
  doc.text(`Período: ${periodoTitulo}`, 28, 110)
  doc.setTextColor(0)

  let y = 122
  const tabOpts = { margin: { top: 70, bottom: 42 }, styles: { fontSize: 9, cellPadding: 4 }, headStyles: { fillColor: NAVY, textColor: 255 }, didDrawPage: chrome, theme: 'grid' }

  if (!dados.secoes.length) {
    autoTable(doc, { ...tabOpts, startY: y, body: [['Sem distribuição de lucros paga no período selecionado.']], styles: { ...tabOpts.styles, textColor: 90 } })
  }
  for (const sec of dados.secoes) {
    autoTable(doc, {
      ...tabOpts,
      startY: y + 8,
      head: [
        [{ content: `Conta ${sec.conta}${sec.contaNome ? ' · ' + sec.contaNome : ''}`, colSpan: 4, styles: { halign: 'left', fillColor: BAND, textColor: NAVY, fontStyle: 'bold' } }],
        ['Nome do Sócio', 'CPF', 'Data do pagamento', 'Valor'],
      ],
      body: sec.itens.map(it => [it.nome, it.cpf || '—', brData(it.data), money(it.valor)]),
      foot: [[{ content: 'Subtotal', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } }, { content: money(sec.subtotal), styles: { halign: 'right', fontStyle: 'bold' } }]],
      footStyles: { fillColor: [242, 244, 249], textColor: 20 },
      columnStyles: { 2: { halign: 'center' }, 3: { halign: 'right' } },
    })
    y = doc.lastAutoTable.finalY
  }
  // Total geral.
  autoTable(doc, {
    ...tabOpts, startY: y + 10,
    body: [[{ content: 'Total distribuído no período', styles: { halign: 'right', fontStyle: 'bold', fillColor: NAVY, textColor: 255 } }, { content: 'R$ ' + money(dados.total), styles: { halign: 'right', fontStyle: 'bold', fillColor: NAVY, textColor: 255 } }]],
    columnStyles: { 0: { cellWidth: (W - 56) * 0.7 }, 1: { halign: 'right' } },
  })
  return doc.output('blob')
}

// Nome do arquivo dentro do zip: "Código - Nome - Período - Distribuição de Lucros_JCP.pdf".
// Troca a barra "/" por "_" (barra não é permitida em nome de arquivo).
export function nomeArquivoDistribuicao(cod, nome, label) {
  const limpo = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return `${limpo(cod)} - ${limpo(nome)} - ${label} - Distribuição de Lucros_JCP.pdf`
}
