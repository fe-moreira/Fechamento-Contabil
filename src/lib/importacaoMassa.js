import { supabase } from './supabase'
import { parsePlano } from './balancete'
import { aplicarPerfil, catByRowDeMerges } from './financeiro'

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
  return { saldoLido: saldo, path }
}

// Abre (link assinado) um arquivo guardado no bucket 'extratos'.
export async function verArquivoImportado(path) {
  const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300)
  if (error) throw new Error(error.message)
  window.open(data.signedUrl, '_blank', 'noopener')
}

// Guarda um arquivo avulso (documento sem conta que roteie — ex.: folha, acumulador).
export async function anexarDocumentoAvulso({ compId, chave, file }) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const path = `${sanit(compId + '/docs/' + (chave || 'doc'))}${ext}`
  const { error } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return { path }
}

// Rota unificada de recebimento de UM arquivo, usada pelo upload individual e pela massa.
// Deduz o destino pela extensão: PDF → Conciliação (anexa + lê saldo); Excel → Integração
// (guarda + classifica/sugere). Sem conta (ou formato desconhecido) → arquivo avulso.
export async function receberArquivo({ compId, empresaId, conta, file }) {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  if (conta && ext === 'pdf') {
    const { saldoLido, path } = await anexarExtratoPdf({ compId, conta, file })
    return { path, destino: 'conciliacao', saldoLido }
  }
  if (conta && ['xlsx', 'xls', 'csv'].includes(ext)) {
    const { path } = await anexarExtratoExcel({ compId, conta, file })
    let integ = null
    try { integ = await alimentarIntegracaoFinanceira({ compId, empresaId, conta, file }) } catch (e) { integ = { classificado: false, motivo: e.message } }
    return { path, destino: 'integracao', integ }
  }
  const { path } = await anexarDocumentoAvulso({ compId, chave: conta || file.name, file })
  return { path, destino: 'arquivo' }
}

// Guarda o extrato Excel amarrado à conta/competência (referência/consulta).
export async function anexarExtratoExcel({ compId, conta, file }) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.xlsx'])[0].toLowerCase()
  const path = `${sanit(compId + '/' + conta)}/integracao${ext}`
  const { error } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return { path }
}

// Alimenta a INTEGRAÇÃO FINANCEIRA de forma headless: usa o perfil de leitura e a memória
// do cliente para classificar o extrato Excel e grava o RASCUNHO em
// competencias.integracoes.financeira.bancos[conta] — o mesmo que a tela mostra ao abrir.
// Não conclui o banco (fica como rascunho, com os lançamentos já sugeridos).
export async function alimentarIntegracaoFinanceira({ compId, empresaId, conta, file, usuario = null }) {
  const [{ data: cb }, { data: mem }, { data: planoCarga }] = await Promise.all([
    supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  let perfil = null
  try { const o = JSON.parse(cb?.obs || ''); if (o && typeof o === 'object' && o.perfil) perfil = o.perfil } catch { /* obs antigo */ }
  if (!perfil) return { classificado: false, motivo: 'perfil de leitura não configurado' }
  const memoria = Array.isArray(mem?.dados) ? mem.dados : []
  const adiantContas = new Set(parsePlano(planoCarga?.dados).filter(p => /adiant/i.test(p.nome || '')).map(p => String(p.reduzido)))

  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  const catByRow = catByRowDeMerges(ws['!merges'], arr)

  // Classifica por banco (a conta é um lado da partida; a contrapartida nunca é o próprio banco).
  const excl = new Set([String(conta)])
  const norm = aplicarPerfil(arr, perfil, memoria, catByRow, adiantContas, excl)
    .map(l => ({ ...l, banco: String(conta), contra: String(l.contra || '') === String(conta) ? '' : l.contra }))
  if (!norm.length) return { classificado: false, motivo: 'o perfil não encontrou lançamentos' }

  // Grava o rascunho preservando o restante do estado das integrações.
  const { data: comp } = await supabase.from('competencias').select('integracoes').eq('id', compId).maybeSingle()
  const integ = (comp?.integracoes && typeof comp.integracoes === 'object') ? comp.integracoes : {}
  const fin = (integ.financeira && typeof integ.financeira === 'object') ? integ.financeira : {}
  const bancos = { ...(fin.bancos || {}) }
  const prev = bancos[String(conta)] || {}
  bancos[String(conta)] = { estado: 'rascunho', doc: file.name, usuario, draft: norm, saldoExtrato: prev.saldoExtrato || null, cruza: prev.cruza || null, concluido: false }
  await supabase.from('competencias').update({ integracoes: { ...integ, financeira: { ...fin, bancos } } }).eq('id', compId)

  return { classificado: true, total: norm.length, classificadas: norm.filter(l => l.contra).length }
}
