import { supabase } from './supabase'
import { parsePlano } from './balancete'
import { aplicarPerfil, catByRowDeMerges, expandirMerges } from './financeiro'

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
const soDigitos = s => String(s ?? '').replace(/\D/g, '')

// Tipo de documento pelo DESTINO/extensão: PDF (extrato do banco) → 'conciliacao';
// Excel/CSV (planilha do sistema do cliente) → 'integracao'.
export function tipoPorExtensao(ext) {
  const e = String(ext || '').toLowerCase()
  if (e === 'pdf') return 'conciliacao'
  if (['xlsx', 'xls', 'csv'].includes(e)) return 'integracao'
  return ''
}

// Palpite do tipo pela DESCRIÇÃO do documento — o FORMATO manda: "(Excel)"/"planilha" →
// integração; "(PDF)"/"extrato" → conciliação. Serve quando o documento não tem tipo à mão.
export function inferirTipoDoc(name) {
  const n = String(name || '').toLowerCase()
  if (/\(excel\)|\bxlsx?\b|planilha/.test(n)) return 'integracao'
  if (/\(pdf\)|extrato/.test(n)) return 'conciliacao'
  return ''
}

// Tipo efetivo do documento: o marcado à mão vence; senão, o palpite pela descrição.
export function tipoEfetivoDoc(doc) {
  return (doc?.tipo && String(doc.tipo)) || inferirTipoDoc(doc?.name)
}

// Impressão digital de uma conta bancária (agência|conta, só dígitos). É a CHAVE da memória:
// o mesmo banco/conta gera a mesma chave todo mês, então o roteamento vira automático.
export function chaveContaBanco(agencia, conta) {
  const c = soDigitos(conta)
  return c ? `${soDigitos(agencia)}|${c}` : ''
}

// Acha os identificadores no TEXTO do documento: todos os CNPJs (14 díg.) e a agência/conta
// bancária (best-effort por palavras-chave). Serve para casar o CLIENTE (CNPJ) e lembrar a
// CONTA (impressão digital). Não decide nada sozinho — a grade de conferência confirma.
export function extrairIdentificadores(texto) {
  const t = String(texto || '')
  const cnpjs = []
  const re = /\d{2}[.\-/\s]?\d{3}[.\-/\s]?\d{3}[.\-/\s]?\d{4}[.\-/\s]?\d{2}/g
  let m
  while ((m = re.exec(t))) { const d = soDigitos(m[0]); if (d.length === 14 && !cnpjs.includes(d)) cnpjs.push(d) }
  const ag = t.match(/ag[eê]ncia\D{0,8}(\d{3,6})/i) || t.match(/\bag\.?\s*[:\s]\s*(\d{3,6})\b/i)
  const cc = t.match(/conta\s*(?:corrente|c\/c)?\D{0,8}(\d{3,12}[-\s]?\d?)/i) || t.match(/\bc\/c\D{0,4}(\d{3,12}[-\s]?\d?)/i)
  return { cnpjs, agencia: ag ? soDigitos(ag[1]) : '', conta: cc ? soDigitos(cc[1]) : '' }
}

// Lê o CONTEÚDO do arquivo (PDF: texto; Excel/CSV: primeiras linhas) e extrai os
// identificadores. Best-effort e tolerante a falha (devolve vazio se não conseguir ler).
export async function lerIdentificacao(file) {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  let texto = ''
  try {
    if (ext === 'pdf') {
      const { extrairTextoPdf } = await import('./pdfText')
      texto = await extrairTextoPdf(file)
    } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const partes = []
      for (const nome of wb.SheetNames.slice(0, 2)) {
        const arr = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: '' })
        for (const r of arr.slice(0, 60)) partes.push(r.join(' '))
      }
      texto = partes.join('\n')
    }
  } catch { texto = '' }
  return { ...extrairIdentificadores(texto), ext }
}

// Memória de contas bancárias do cliente: chave (agência|conta) → conta CONTÁBIL. Vem do
// cadastro `contas_bancarias` (campos agencia/conta preenchidos pelo aprendizado abaixo).
export async function lerMemoriaContas(empresaId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const rows = Array.isArray(data?.dados) ? data.dados : []
  const map = {}
  for (const r of rows) {
    const fp = chaveContaBanco(r.agencia, r.conta)
    if (fp && r.conta_contabil) map[fp] = String(r.conta_contabil)
  }
  return map
}

// Aprende: grava no cadastro `contas_bancarias` o número da conta/agência que o usuário
// confirmou para uma conta contábil. Assim o próximo mês reconhece sozinho. Completa a
// linha existente da conta contábil (ou cria uma), preservando o resto do cadastro.
export async function lembrarContaBancaria(empresaId, { conta_contabil, agencia, conta }) {
  const cc = soDigitos(conta)
  if (!cc || !conta_contabil) return
  const { data } = await supabase.from('cargas_cadastro').select('id, dados, obs')
    .eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const rows = Array.isArray(data?.dados) ? data.dados.map(r => ({ ...r })) : []
  const ag = soDigitos(agencia)
  const hit = rows.find(r => String(r.conta_contabil) === String(conta_contabil))
  if (hit) { hit.conta = cc; if (ag) hit.agencia = ag }
  else rows.push({ conta: cc, agencia: ag, conta_contabil: String(conta_contabil) })
  if (data?.id) await supabase.from('cargas_cadastro').update({ dados: rows }).eq('id', data.id)
  else await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: 'contas_bancarias', dados: rows })
}

// Lê o saldo de um extrato PDF (destaque amarelo → texto → OCR), como na Conciliação.
// Devolve { saldo, via, n }: via = 'amarelo' (soma de n destaques), 'texto' ou 'ocr'
// (palpite automático), ou null quando não achou — para o upload avisar COMO leu.
async function lerSaldoPdf(file) {
  const { extrairTextoPdf, palpiteSaldo, ocrPdf, somaDestaquesPdf } = await import('./pdfText')
  try {
    const destaque = await somaDestaquesPdf(file).catch(() => null)
    if (destaque && destaque.valores?.length) return { saldo: destaque.soma, via: 'amarelo', n: destaque.valores.length }
    const texto = await extrairTextoPdf(file)
    let s = palpiteSaldo(texto, null)
    if (s == null && texto.replace(/\s/g, '').length < 20) {
      try { s = palpiteSaldo(await ocrPdf(file, () => {}), null); if (s != null) return { saldo: s, via: 'ocr', n: 0 } } catch { /* imagem sem OCR */ }
    }
    return { saldo: s, via: s != null ? 'texto' : null, n: 0 }
  } catch { return { saldo: null, via: null, n: 0 } }
}

// Anexa o extrato PDF na conta (Storage + conciliacao_conta), lendo o saldo. Espelha
// exatamente o que a tela de Conciliação faz ao subir o documento.
export async function anexarExtratoPdf({ compId, conta, file }) {
  const { saldo, via, n } = await lerSaldoPdf(file)
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const path = `${sanit(compId + '/' + conta)}/extrato${ext}`
  const { error: eUp } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (eUp) throw new Error(eUp.message)
  const campos = { competencia_id: compId, conta: String(conta), documento: file.name, documento_path: path }
  if (saldo != null) campos.saldo_documento = saldo
  const { data: ex } = await supabase.from('conciliacao_conta').select('id')
    .eq('competencia_id', compId).eq('conta', String(conta)).limit(1)
  const { error: eConc } = (ex && ex[0])
    ? await supabase.from('conciliacao_conta').update(campos).eq('id', ex[0].id)
    : await supabase.from('conciliacao_conta').insert(campos)
  if (eConc) throw new Error('anexo salvo, mas falhou ao ligar na conciliação: ' + eConc.message)
  return { saldoLido: saldo, via, n, path }
}

// Abre (link assinado) um arquivo guardado no bucket 'extratos'.
export async function verArquivoImportado(path) {
  const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300)
  if (error) throw new Error(error.message)
  window.open(data.signedUrl, '_blank', 'noopener')
}

// Exclui o arquivo recebido de um documento: apaga do Storage e, se aquele arquivo era o
// anexo de conciliação da conta, limpa o documento/saldo lá (não mexe se for outro anexo).
export async function excluirArquivoRecebido({ path, conta, compId }) {
  if (path) { try { await supabase.storage.from('extratos').remove([path]) } catch { /* já pode não existir */ } }
  if (conta && compId && path) {
    const { data: ex } = await supabase.from('conciliacao_conta').select('id, documento_path')
      .eq('competencia_id', compId).eq('conta', String(conta)).limit(1)
    if (ex && ex[0] && ex[0].documento_path === path) {
      await supabase.from('conciliacao_conta').update({ documento_path: null, documento: null, saldo_documento: null }).eq('id', ex[0].id)
    }
  }
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
    const { saldoLido, via, n, path } = await anexarExtratoPdf({ compId, conta, file })
    return { path, destino: 'conciliacao', saldoLido, via, n }
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
  const [{ data: cb }, { data: mem }, { data: planoCarga }, { data: ccCarga }] = await Promise.all([
    supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'centro_custo').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  // Centros de custo (código/nome) — p/ resolver o CC da planilha (vem código OU nome).
  const kByCC = (o, re) => { const k = Object.keys(o || {}).find(k => re.test(String(k).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))); return k ? String(o[k] ?? '').trim() : '' }
  const centros = (Array.isArray(ccCarga?.dados) ? ccCarga.dados : []).map(r => ({ cod: kByCC(r, /cod/), nome: kByCC(r, /nome|descri/), resp: kByCC(r, /respons/) })).filter(c => c.cod || c.nome)
  // Perfil de leitura POR BANCO: usa o específico da conta; cai no legado (cadastro
  // antigo com um só perfil) apenas se o banco ainda não tiver o seu.
  let perfil = null
  try {
    const o = JSON.parse(cb?.obs || '')
    if (o && typeof o === 'object') {
      if (o.perfis && typeof o.perfis === 'object' && o.perfis[String(conta)]) perfil = o.perfis[String(conta)]
      if (!perfil && o.perfil) perfil = o.perfil
    }
  } catch { /* obs antigo */ }
  if (!perfil) return { classificado: false, motivo: 'perfil de leitura não configurado para este banco' }
  const memoria = Array.isArray(mem?.dados) ? mem.dados : []
  const adiantContas = new Set(parsePlano(planoCarga?.dados).filter(p => /adiant/i.test(p.nome || '')).map(p => String(p.reduzido)))

  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  const catByRow = catByRowDeMerges(ws['!merges'], arr)
  expandirMerges(arr, ws['!merges']) // preenche Data/Documento/Natureza mescladas

  // Classifica por banco (a conta é um lado da partida; a contrapartida nunca é o próprio banco).
  const excl = new Set([String(conta)])
  const norm = aplicarPerfil(arr, perfil, memoria, catByRow, adiantContas, excl, centros)
    .map(l => ({ ...l, banco: String(conta), contra: String(l.contra || '') === String(conta) ? '' : l.contra }))
  if (!norm.length) return { classificado: false, motivo: 'o perfil não encontrou lançamentos' }

  // Grava o rascunho preservando o restante do estado das integrações.
  const { data: comp } = await supabase.from('competencias').select('integracoes').eq('id', compId).maybeSingle()
  const integ = (comp?.integracoes && typeof comp.integracoes === 'object') ? comp.integracoes : {}
  const fin = (integ.financeira && typeof integ.financeira === 'object') ? integ.financeira : {}
  const bancos = { ...(fin.bancos || {}) }
  const prev = bancos[String(conta)] || {}
  // Guarda o arquivo bruto (arr + mesclas) para permitir "Ajustar leitura" depois, sem reimportar.
  bancos[String(conta)] = { estado: 'rascunho', doc: file.name, usuario, draft: norm, saldoExtrato: prev.saldoExtrato || null, cruza: prev.cruza || null, concluido: false, arr, catByRow }
  await supabase.from('competencias').update({ integracoes: { ...integ, financeira: { ...fin, bancos } } }).eq('id', compId)

  return { classificado: true, total: norm.length, classificadas: norm.filter(l => l.contra).length }
}
