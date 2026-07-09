import { supabase } from './supabase'
import { normalizaCompetencia } from './balancete'

// CRUD genérico das tabelas de Outras Contabilizações (todas por cliente_id).
export async function listar(tabela, clienteId) {
  const { data, error } = await supabase.from(tabela).select('*')
    .eq('cliente_id', clienteId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function inserir(tabela, row) {
  const { data, error } = await supabase.from(tabela).insert(row).select().single()
  if (error) throw error
  return data
}

export async function remover(tabela, id) {
  const { error } = await supabase.from(tabela).delete().eq('id', id)
  if (error) throw error
}

export async function atualizar(tabela, id, row) {
  const { error } = await supabase.from(tabela).update(row).eq('id', id)
  if (error) throw error
}

// Lê um documento (PDF/imagem) via IA e devolve os campos extraídos.
// Chama a Edge Function `ler-documento` — a chave da IA fica no servidor.
export async function lerDocumento(tipo, file) {
  const arquivo_base64 = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
    r.readAsDataURL(file)
  })
  const { data, error } = await supabase.functions.invoke('ler-documento', {
    body: { tipo, arquivo_base64, mime: file.type || '' },
  })
  if (error) {
    // A Edge Function devolve mensagem amigável no corpo mesmo em erro (501/502…).
    let msg = error.message
    try { const ctx = await error.context?.json(); if (ctx?.error) msg = ctx.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return data?.dados || {}
}

// Saldo que falta apropriar de um contrato (seguro/despesa a apropriar) na
// ABERTURA — isto é, no início da competência inicial do cliente. É o valor total
// menos as apropriações mensais já reconhecidas ANTES da competência de início.
export function saldoApropriarNaAbertura(c, compIni) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  const nParc = Number(c.num_parcelas) || 0
  const mensal = Number(c.valor_parcela) || (nParc ? total / nParc : 0)
  if (!total || !mensal) return 0
  const mi = String(compIni || '').match(/^(\d{2})\/(\d{4})$/)
  const vi = String(c.vigencia_inicio || '').match(/^(\d{4})-(\d{2})/)
  if (!mi || !vi) return Math.round(total * 100) / 100 // sem datas, assume tudo a apropriar
  const mesesAntes = (Number(mi[2]) * 12 + Number(mi[1])) - (Number(vi[1]) * 12 + Number(vi[2]))
  const apropriadas = Math.max(0, Math.min(mesesAntes, nParc || mesesAntes))
  return Math.max(0, Math.round((total - apropriadas * mensal) * 100) / 100)
}

// Data (último dia do mês ANTERIOR à competência de início) em "DD/MM/AAAA".
function dataAberturaBR(compIni) {
  const mi = String(compIni || '').match(/^(\d{2})\/(\d{4})$/)
  if (!mi) return ''
  let m = Number(mi[1]) - 1, a = Number(mi[2]); if (m < 1) { m = 12; a-- }
  const dia = new Date(a, m, 0).getDate()
  return `${String(dia).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`
}

// Envia (ou atualiza) o saldo de abertura de um contrato de apropriação para a
// CARGA INICIAL do cliente. Idempotente por origem+id: reenviar substitui a linha
// daquele contrato (não duplica). Grava uma linha de saldo e uma de composição na
// conta "a apropriar", que se conferem entre si.
export async function enviarSaldoInicialContrato({ clienteId, origem, contrato, usuario }) {
  const { data: cli } = await supabase.from('clientes').select('competencia_inicio').eq('id', clienteId).maybeSingle()
  const compIni = normalizaCompetencia(cli?.competencia_inicio)
  if (!/^\d{2}\/\d{4}$/.test(compIni)) throw new Error('Defina a competência de início do cliente (Base de Informações) antes de enviar ao saldo inicial.')
  const conta = contrato.conta_apropriar
  if (!conta) throw new Error('Informe a conta "a apropriar" do contrato.')
  const restante = saldoApropriarNaAbertura(contrato, compIni)
  const dataBR = dataAberturaBR(compIni)
  const hist = origem === 'seguro'
    ? `Seguro ${contrato.seguradora || ''} ${contrato.apolice || ''}`.trim()
    : `${contrato.tipo || 'Despesa a apropriar'} ${contrato.descricao || ''}`.trim()

  const { data: cargas } = await supabase.from('cargas_cadastro').select('id, dados, obs')
    .eq('cliente_id', clienteId).eq('tipo', 'financeiro').order('created_at', { ascending: false })
  const iniciais = (cargas || []).filter(c => String(c.obs || '').startsWith('Carga inicial'))
  const atual = iniciais[0]
  const base = (atual?.dados && !Array.isArray(atual.dados)) ? atual.dados : {}
  const tag = `${origem}:${contrato.id}`
  const saldos = (base.saldos || []).filter(r => r._origem !== tag)
  const composicoes = (base.composicoes || []).filter(r => r._origem !== tag)
  if (restante > 0.005) {
    saldos.push({ Data: dataBR, 'Código': conta, Nome: hist, Saldo: restante, 'D/C': 'D', _origem: tag })
    composicoes.push({ Data: dataBR, Conta: conta, 'Histórico': hist, 'Competência': contrato.vigencia_fim || '', Valor: restante, 'D/C': 'D', _origem: tag })
  }
  const dados = { saldos, composicoes }
  // NÃO apaga a carga (isso já apagou a carga manual por corrida). ATUALIZA a carga
  // ativa no lugar (preserva clientes/fornecedores/etc.); só cria uma se não existir.
  if (atual) {
    const { error } = await supabase.from('cargas_cadastro').update({ dados, usuario }).eq('id', atual.id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: 'financeiro', vigencia: compIni, dados, usuario, obs: 'Carga inicial · contratos' })
    if (error) throw error
  }
  await supabase.from('clientes').update({ carga_inicial_feita: true }).eq('id', clienteId)
  return restante
}

// Competência de início do cliente (abertura), em "MM/AAAA".
export async function competenciaInicioCliente(clienteId) {
  const { data } = await supabase.from('clientes').select('competencia_inicio').eq('id', clienteId).maybeSingle()
  return normalizaCompetencia(data?.competencia_inicio)
}

// Anexo do contrato (apólice/documento) no Storage privado, guardado por contrato.
export async function anexarArquivoContrato(tabela, id, file) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const path = `contratos/${tabela}/${id}${ext}`
  const { error } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (error) throw error
  await supabase.from(tabela).update({ arquivo: path }).eq('id', id)
  return path
}
export async function urlArquivoContrato(path) {
  const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}
export async function removerArquivoContrato(tabela, id, path) {
  if (path) await supabase.storage.from('extratos').remove([path])
  await supabase.from(tabela).update({ arquivo: null }).eq('id', id)
}

// Apropriações (lançamentos) já geradas nesta competência para uma origem (seguro/despesa).
// Usado para marcar cada contrato como "Apropriado" na lista assim que o lançamento é feito.
export async function apropriacoesDoMes(clienteId, competencia, origem) {
  const [m, a] = String(competencia || '').split('/').map(Number)
  if (!m || !a) return []
  const { data: comp } = await supabase.from('competencias').select('id')
    .eq('cliente_id', clienteId).eq('ano', a).eq('mes', m).maybeSingle()
  if (!comp) return []
  const { data } = await supabase.from('lancamentos')
    .select('documento, historico, valor, conta_debito, conta_credito').eq('competencia_id', comp.id).eq('origem', origem)
  return (data || []).filter(l => /apropria/i.test(l.historico || ''))
}

// Gera um lançamento real na fila que alimenta o Status / arquivo do Domínio.
export async function gerarLancamento(l) {
  const { error } = await supabase.from('lancamentos').insert({
    competencia_id: l.competencia_id,
    data: l.data || null,
    conta_debito: l.conta_debito || null,
    conta_credito: l.conta_credito || null,
    valor: Number(l.valor) || 0,
    historico: l.historico || null,
    origem: l.origem || 'outras',
    documento: l.documento || null,
    usuario: l.usuario || null,
  })
  if (error) throw error
}
