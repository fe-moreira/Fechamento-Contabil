import JSZip from 'jszip'
import { supabase } from './supabase'
import { gerarExcelTimbrado } from './excel'
import { theme } from './theme'

// Geração do pacote (.zip) do Book de Composições — EXTRAÍDA do componente para poder
// rodar em SEGUNDO PLANO (sobrevive à troca de tela). Recebe as contas já montadas na
// tela e devolve { blob, nomeArquivo } — quem chama decide quando baixar/avisar.

const num = v => Number(v) || 0
const baixa = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const dataBR = d => { const s = String(d || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s === 'abertura' ? 'abertura' : s) }
const dataBRhora = iso => { const dt = new Date(iso); return isNaN(dt) ? '' : dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const fmtCnpj = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 14 ? `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12)}` : (c || '—') }

// Situação da amarração de uma conta patrimonial (mesma régua da tela).
export function statusConta(c) {
  if (c.dif != null && Math.abs(c.dif) < 0.05 && c.documento_path) return { txt: 'Conciliado — documento', cor: theme.green }
  if (c.conciliada && c.justificativa) return { txt: 'Conciliado — justificativa', cor: theme.yellow }
  if (c.dif != null && Math.abs(c.dif) >= 0.05) return { txt: 'Diferença a resolver', cor: theme.red }
  return { txt: 'Sem documento', cor: theme.yellow }
}

// Gera um .zip com a planilha timbrada + a pasta anexos/ com os PDFs originais.
export async function gerarZipBook(contas, meta) {
  const { empresaNome, cnpj, competencia } = meta || {}
  const zip = new JSZip()
  const pasta = zip.folder('anexos')
  const linkDe = {}
  for (const c of contas) {
    if (!c.documento_path) continue
    try {
      const { data, error } = await supabase.storage.from('extratos').download(c.documento_path)
      if (error || !data) continue
      const ext = (c.documento_path.match(/\.[a-z0-9]+$/i)?.[0]) || (c.documento?.match(/\.[a-z0-9]+$/i)?.[0]) || '.pdf'
      const cod = String(c.conta).replace(/[^\w.-]+/g, '_')
      const nomeConta = baixa(c.nome || '').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50)
      const fname = `${cod}_${nomeConta || 'documento'}${ext}`
      pasta.file(fname, await data.arrayBuffer())
      linkDe[c.conta] = `anexos/${fname}`
    } catch { /* pula anexo com erro, segue os demais */ }
  }

  const totSaldo = contas.reduce((s, c) => s + num(c.saldo_final), 0)
  const sub = `${empresaNome} · CNPJ ${fmtCnpj(cnpj)} · competência ${competencia} · ${contas.length} contas patrimoniais`
  const colunas = [
    { nome: 'Conta / item', largura: 16 },
    { nome: 'Nome / histórico', largura: 44, wrap: true },
    { nome: 'Saldo / valor', alinhar: 'right', moeda: true },
    { nome: 'Documento', alinhar: 'right', moeda: true },
    { nome: 'Diferença', alinhar: 'right', moeda: true },
    { nome: 'Situação / anexo', largura: 26 },
  ]
  const secoes = [{
    titulo: 'Amarração geral — contas patrimoniais',
    linhas: contas.map(c => [
      c.conta, `${c.comentarios?.length ? '* ' : ''}${c.nome}`, num(c.saldo_final),
      c.saldo_documento == null ? '' : num(c.saldo_documento),
      c.dif == null ? '' : num(c.dif),
      linkDe[c.conta] ? { text: 'Abrir PDF', hyperlink: linkDe[c.conta] } : statusConta(c).txt,
    ]),
    totais: ['', 'Total patrimonial', num(totSaldo), '', '', ''],
  }]
  for (const c of contas) {
    const anexo = linkDe[c.conta] ? { text: 'Abrir PDF', hyperlink: linkDe[c.conta] } : (c.documento_path ? '(anexo indisponível)' : '')
    const st = statusConta(c)
    const linhasSec = []
    if (c.composicao.length) {
      for (const i of c.composicao) linhasSec.push([dataBR(i.data), i.historico, num(i.debito) - num(i.credito), '', '', ''])
      linhasSec.push(['', 'Saldo da conta (composição)', num(c.saldo_final), '', '', ''])
    }
    linhasSec.push(['Amarração', `saldo × documento × diferença · ${st.txt}`, num(c.saldo_final),
      c.saldo_documento == null ? '' : num(c.saldo_documento), c.dif == null ? '' : num(c.dif), anexo])
    const sup = c.documento ? `Documento: ${c.documento}`
      : (c.justificativa ? `Justificativa: ${c.justificativa}` : 'Sem documento nem justificativa anexados')
    linhasSec.push(['Documento-suporte', sup, '', '', '', anexo])
    for (const m of (c.comentarios || [])) {
      const quem = m.usuario ? ` · ${String(m.usuario).split('@')[0]}` : ''
      linhasSec.push(['Comentário', `${m.texto}  (${dataBRhora(m.created_at)}${quem})`, '', '', '', ''])
    }
    secoes.push({
      titulo: `${c.conta} · ${c.nome} — ${c.grupo} (natureza ${c.natureza})`,
      linhas: linhasSec,
    })
  }
  const buf = await gerarExcelTimbrado({ titulo: 'Book de Composições — contas patrimoniais', sub, colunas, secoes, aba: 'Book', retornarBuffer: true })
  const nomeBase = `book_composicoes_${(empresaNome || 'cliente').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}_${String(competencia).replace('/', '-')}`
  zip.file(`${nomeBase}.xlsx`, buf)

  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, nomeArquivo: `${nomeBase}.zip` }
}
