import { supabase } from './supabase'

// ============================================================================
// Importação em massa de documentos. O NOME do arquivo carrega o roteamento:
//   <codigoCliente>-<contaContabil>-<resto>.<ext>
// A extensão decide o caminho:
//   .pdf                → Conciliação (anexa + lê o saldo → conta fica verde)
//   .xlsx / .xls / .csv → Integração Financeira (arquivo pronto para importar)
// Determinístico e seguro: se o código não bate ou a conta não está cadastrada,
// o arquivo NÃO sobe errado — vira uma linha de erro no relatório.
// ============================================================================

export function parseNomeArquivo(name) {
  const raw = String(name || '')
  const ext = (raw.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  const semExt = raw.replace(/\.[a-z0-9]+$/i, '')
  const parts = semExt.split(/[-_]/).map(s => s.trim()).filter(Boolean)
  return { cli: parts[0] || '', conta: parts[1] || '', resto: parts.slice(2).join('-'), ext }
}

const sanit = s => String(s).replace(/[^a-zA-Z0-9/_-]/g, '_')

// Lê o saldo de um extrato PDF (destaque amarelo → texto → OCR), como na Conciliação.
async function lerSaldoPdf(file) {
  const { extrairTextoPdf, palpiteSaldo, ocrPdf, somaDestaquesPdf } = await import('./pdfText')
  try {
    const destaque = await somaDestaquesPdf(file).catch(() => null)
    if (destaque && destaque.valores?.length) return destaque.soma
    const texto = await extrairTextoPdf(file)
    let s = palpiteSaldo(texto, null)
    if (s == null && texto.replace(/\s/g, '').length < 20) {
      try { s = palpiteSaldo(await ocrPdf(file, () => {}), null) } catch { /* imagem sem OCR */ }
    }
    return s
  } catch { return null }
}

// Anexa o extrato PDF na conta (Storage + conciliacao_conta), lendo o saldo. Espelha
// exatamente o que a tela de Conciliação faz ao subir o documento.
export async function anexarExtratoPdf({ compId, conta, file }) {
  const saldo = await lerSaldoPdf(file)
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const path = `${sanit(compId + '/' + conta)}/extrato${ext}`
  const { error: eUp } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (eUp) throw new Error(eUp.message)
  const campos = { competencia_id: compId, conta: String(conta), documento: file.name, documento_path: path }
  if (saldo != null) campos.saldo_documento = saldo
  const { data: ex } = await supabase.from('conciliacao_conta').select('id')
    .eq('competencia_id', compId).eq('conta', String(conta)).limit(1)
  if (ex && ex[0]) await supabase.from('conciliacao_conta').update(campos).eq('id', ex[0].id)
  else await supabase.from('conciliacao_conta').insert(campos)
  return { saldoLido: saldo }
}

// Guarda o extrato Excel amarrado à conta/competência, pronto para a Integração Financeira.
export async function anexarExtratoExcel({ compId, conta, file }) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.xlsx'])[0].toLowerCase()
  const path = `${sanit(compId + '/' + conta)}/integracao${ext}`
  const { error } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return { path }
}
