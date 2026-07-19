// Relatório de Distribuição de Lucros por empresa (para gerar em massa).
// DOIS blocos por empresa, ambos por sócio (conta contábil como coluna, data por linha,
// subtotal por sócio e total do bloco):
//   1) Distribuição NORMAL (do período): lançamentos do razão nas contas observadas
//      (cfg.contas), casados ao sócio pela identificação (cfg.socios[].ident).
//   2) Distribuição da ATA (lucros apurados até 2025): pagamentos registrados em ata
//      (cfg.ata.socios[].pagamentos), filtrados pela data dentro do período.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { HEADER_IMG, RODAPE } from './pdf'

const NAVY = [27, 42, 74]
const SUB = [238, 242, 249]
const money = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const brData = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '' }
const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const r2 = x => Math.round((Number(x) || 0) * 100) / 100
const p2 = x => String(x).padStart(2, '0')
const ultimoDia = (ano, mes) => new Date(ano, mes, 0).getDate() // mes 1-12

// Período selecionável → { label (nome do arquivo), ini, fim (ISO), titulo (no PDF) }.
//  mensal 01.2026 · trimestral 1T2026 · semestral 1S2026 · anual 2026 · personalizado (ini/fim).
export function periodoDistribuicao(tipo, ano, n, ini, fim) {
  ano = Number(ano); n = Number(n) || 1
  if (tipo === 'personalizado') {
    const lbl = s => brData(s).replace(/\//g, '.')
    const i = ini || `${ano}-01-01`, f = fim || `${ano}-12-31`
    return { label: `${lbl(i)} a ${lbl(f)}`, ini: i, fim: f, titulo: `${brData(i)} a ${brData(f)}` }
  }
  if (tipo === 'mensal') return { label: `${p2(n)}.${ano}`, ini: `${ano}-${p2(n)}-01`, fim: `${ano}-${p2(n)}-${p2(ultimoDia(ano, n))}`, titulo: `${p2(n)}/${ano}` }
  if (tipo === 'trimestral') { const m0 = (n - 1) * 3 + 1, mf = m0 + 2; return { label: `${n}T${ano}`, ini: `${ano}-${p2(m0)}-01`, fim: `${ano}-${p2(mf)}-${p2(ultimoDia(ano, mf))}`, titulo: `${n}º Trimestre / ${ano}` } }
  if (tipo === 'semestral') { const m0 = (n - 1) * 6 + 1, mf = m0 + 5; return { label: `${n}S${ano}`, ini: `${ano}-${p2(m0)}-01`, fim: `${ano}-${p2(mf)}-${p2(ultimoDia(ano, mf))}`, titulo: `${n}º Semestre / ${ano}` } }
  return { label: `${ano}`, ini: `${ano}-01-01`, fim: `${ano}-12-31`, titulo: `Ano ${ano}` }
}

// Bloco NORMAL: lançamentos do razão (contas observadas), por sócio (casado pela identificação).
// `razaoLancs`: [{ data, conta, historico, debito, credito }]. CPF vem do cadastro da ata (por nome).
export function blocoNormal(cfg, nomeMap, razaoLancs, ini, fim) {
  const socios = cfg?.socios || []
  const cpfPorNome = {}
  for (const s of (cfg?.ata?.socios || [])) if (s.nome) cpfPorNome[baixa(s.nome)] = s.cpf || ''
  const grupos = new Map(); let total = 0
  for (const l of (razaoLancs || [])) {
    if (!l.data || l.data < ini || l.data > fim) continue
    const v = (Number(l.debito) || 0) + (Number(l.credito) || 0)
    if (Math.abs(v) < 0.005) continue
    let nome = '(não identificado)'
    for (const s of socios) { const id = baixa(s.ident || s.nome); if (id && baixa(l.historico).includes(id)) { nome = s.nome || '(sócio)'; break } }
    const key = baixa(nome)
    const g = grupos.get(key) || { nome, cpf: cpfPorNome[key] || '', itens: [], subtotal: 0 }
    g.itens.push({ conta: String(l.conta || '—'), contaNome: (nomeMap && nomeMap[String(l.conta)]) || '', data: l.data, valor: v })
    g.subtotal = r2(g.subtotal + v); total = r2(total + v)
    grupos.set(key, g)
  }
  for (const g of grupos.values()) g.itens.sort((a, b) => String(a.data).localeCompare(String(b.data)))
  const arr = [...grupos.values()].sort((a, b) => (a.nome === '(não identificado)' ? 1 : 0) - (b.nome === '(não identificado)' ? 1 : 0) || String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
  return { socios: arr, total }
}

// Bloco ATA (lucros até 2025): pagamentos registrados em ata, por sócio, filtrados pela data.
export function blocoAta(cfg, nomeMap, ini, fim) {
  const grupos = new Map(); let total = 0
  for (const s of (cfg?.ata?.socios || [])) {
    const pags = (s.pagamentos || []).filter(p => p.data && p.data >= ini && p.data <= fim)
    if (!pags.length) continue
    const key = baixa(s.nome) + '·' + (s.cpf || '')
    const g = grupos.get(key) || { nome: s.nome || '—', cpf: s.cpf || '', itens: [], subtotal: 0 }
    for (const p of pags.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
      const v = Number(p.valor) || 0
      g.itens.push({ conta: String(s.conta || '—'), contaNome: (nomeMap && nomeMap[String(s.conta)]) || '', data: p.data, valor: v })
      g.subtotal = r2(g.subtotal + v); total = r2(total + v)
    }
    grupos.set(key, g)
  }
  return { socios: [...grupos.values()], total }
}

export function criarDocDistribuicao() { return new jsPDF({ unit: 'pt', format: 'a4' }) }
export function docBlob(doc) { return doc.output('blob') }

// Renderiza UMA empresa (Bloco 1 + Bloco 2) num doc. `primeira=false` → quebra de página antes
// (para o "relatório único" com várias empresas).
export function renderEmpresaDistribuicao(doc, { empresaCod, empresaNome, cnpj, periodoTitulo, normal, ata }, primeira = true) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight()
  const chrome = () => {
    try { doc.addImage(HEADER_IMG, 'PNG', 28, 16, W - 56, 42) } catch { /* sem logo */ }
    doc.setFontSize(7); doc.setTextColor(130)
    doc.text(String(RODAPE), W / 2, H - 18, { align: 'center', maxWidth: W - 56 }); doc.setTextColor(0)
  }
  if (!primeira) doc.addPage()
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...NAVY)
  doc.text('Distribuição de Lucros', 28, 82)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(70)
  doc.text(`${empresaCod || ''} · ${empresaNome || ''}${cnpj ? '   —   CNPJ ' + cnpj : ''}`, 28, 97)
  doc.setTextColor(110); doc.text(`Período: ${periodoTitulo}`, 28, 110); doc.setTextColor(0)

  const tabOpts = {
    margin: { top: 70, bottom: 42 }, styles: { fontSize: 8.5, cellPadding: 3.5 }, theme: 'grid',
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 8.5 }, didDrawPage: chrome,
    columnStyles: { 0: { cellWidth: 148 }, 1: { cellWidth: 78 }, 3: { halign: 'center', cellWidth: 56 }, 4: { halign: 'right', cellWidth: 74 } },
  }
  const faixa = (y, titulo) => {
    doc.setFillColor(...NAVY); doc.rect(28, y, W - 56, 18, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255)
    doc.text(titulo, 34, y + 12.5); doc.setTextColor(0); doc.setFont('helvetica', 'normal')
    return y + 18
  }
  const bloco = (startY, titulo, dados, totalLabel) => {
    let y = faixa(startY, titulo)
    if (!dados.socios.length) {
      autoTable(doc, { ...tabOpts, startY: y, body: [[{ content: 'Sem distribuição no período selecionado.', colSpan: 5, styles: { textColor: 90 } }]] })
      return doc.lastAutoTable.finalY
    }
    const body = []
    for (const s of dados.socios) {
      for (const it of s.itens) body.push([s.nome, s.cpf || '—', `${it.conta}${it.contaNome ? ' · ' + it.contaNome : ''}`, brData(it.data), money(it.valor)])
      body.push([{ content: `Subtotal · ${s.nome}`, colSpan: 4, styles: { halign: 'right', fontStyle: 'bold', fillColor: SUB, textColor: NAVY } }, { content: money(s.subtotal), styles: { halign: 'right', fontStyle: 'bold', fillColor: SUB, textColor: NAVY } }])
    }
    autoTable(doc, {
      ...tabOpts, startY: y,
      head: [['Nome do Sócio', 'CPF', 'Conta contábil', 'Data', 'Valor (R$)']],
      body,
      foot: [[{ content: totalLabel, colSpan: 4, styles: { halign: 'right', fontStyle: 'bold' } }, { content: 'R$ ' + money(dados.total), styles: { halign: 'right', fontStyle: 'bold' } }]],
      footStyles: { fillColor: NAVY, textColor: 255 },
    })
    return doc.lastAutoTable.finalY
  }

  let y = bloco(122, '1 · Distribuição Normal (do período)', normal, 'Total distribuído no período')
  bloco(y + 16, '2 · Distribuição da Ata (Lucros Apurados até 2025)', ata, 'Total em ata (lucros até 2025)')
}

// PDF (Blob) de UMA empresa.
export function pdfDistribuicaoEmpresa(params) {
  const doc = criarDocDistribuicao()
  renderEmpresaDistribuicao(doc, params, true)
  return doc.output('blob')
}

// Nome do arquivo: "Código - Empresa - Período - Distribuição de Lucros.pdf".
export function nomeArquivoDistribuicao(cod, nome, label) {
  const limpo = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return `${limpo(cod)} - ${limpo(nome)} - ${label} - Distribuição de Lucros.pdf`
}
