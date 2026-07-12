import { supabase } from './supabase'
import { extrairEntidade, tokensHist, aprender } from './financeiro'

// ============================================================================
// Sugestões geradas AO IMPORTAR O RAZÃO, que caem no Painel de Sugestões:
//  1) Apropriações do mês (seguro + despesa a apropriar) — a partir do cronograma
//     dos contratos ativos, se ainda não lançadas.
//  2) Correções recorrentes — quando uma conta que já foi corrigida antes (memória
//     de correção, SEM banco) reaparece no razão com a mesma entidade.
// A partida (D/C/valor/data) é embutida no `detalhe` da auditoria, entre [[P]],
// para o Painel de Sugestões já abrir com o lançamento preenchido.
// ============================================================================

const MARCA = ' [[P]]'
export function encodePartida(humano, { conta_debito, conta_credito, valor, data }) {
  return `${humano}${MARCA}D=${conta_debito || ''};C=${conta_credito || ''};V=${Number(valor) || 0};DT=${data || ''}`
}
export function decodePartida(detalhe) {
  const s = String(detalhe || '')
  const i = s.indexOf(MARCA)
  if (i < 0) return { humano: s, partida: null }
  const humano = s.slice(0, i)
  const p = {}
  for (const kv of s.slice(i + MARCA.length).split(';')) { const [k, v] = kv.split('='); p[k] = v ?? '' }
  return { humano, partida: { conta_debito: p.D || '', conta_credito: p.C || '', valor: Number(p.V) || 0, data: p.DT || '' } }
}

// --- Cronograma de apropriação (espelha src/pages/OutrasContabilizacoes.jsx; manter em sincronia) ---
const r2 = v => Math.round((v || 0) * 100) / 100
function parseISO(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null }
function cronogramaContrato(c, metodo) {
  const total = Number(c.premio_total ?? c.valor_total) || 0
  const vi = parseISO(c.vigencia_inicio)
  if (metodo === 'dia') {
    const vf = parseISO(c.vigencia_fim)
    if (!vi || !vf || vf < vi || !total) return []
    const totalDias = Math.round((vf - vi) / 86400000) + 1
    const linhas = []
    let cursor = new Date(vi.getFullYear(), vi.getMonth(), vi.getDate()), acum = 0
    while (cursor <= vf) {
      const ano = cursor.getFullYear(), mes = cursor.getMonth()
      const fimMes = new Date(ano, mes + 1, 0)
      const ate = fimMes < vf ? fimMes : vf
      const dias = Math.round((ate - cursor) / 86400000) + 1
      const prox = new Date(ano, mes + 1, 1)
      const valor = prox > vf ? r2(total - acum) : r2(total * dias / totalDias)
      acum = r2(acum + valor)
      linhas.push({ comp: `${String(mes + 1).padStart(2, '0')}/${ano}`, valor })
      cursor = prox
    }
    return linhas
  }
  const nParc = Number(c.num_parcelas) || 0
  const mensal = Number(c.valor_parcela) || (nParc ? total / nParc : 0)
  const linhas = []
  if (vi && mensal > 0 && nParc > 0) {
    let ym = vi.getFullYear() * 12 + vi.getMonth()
    for (let i = 0; i < nParc; i++) {
      const ano = Math.floor(ym / 12), mes = (ym % 12) + 1
      const valor = i === nParc - 1 ? r2(total - mensal * (nParc - 1)) : r2(mensal)
      linhas.push({ comp: `${String(mes).padStart(2, '0')}/${ano}`, valor })
      ym++
    }
  }
  return linhas
}
function valorApropriacaoMes(c, competencia) {
  const l = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual').find(x => x.comp === competencia)
  return l ? l.valor : 0
}
function parcelaDoMes(c, competencia) {
  const sched = cronogramaContrato(c, c.por_dia ? 'dia' : 'igual')
  const idx = sched.findIndex(x => x.comp === competencia)
  return idx < 0 ? { num: 0, total: sched.length } : { num: idx + 1, total: sched.length }
}

// ---------------------------------------------------------------------------
// Memória de correção contábil (SEM banco): { termo, conta (errada), certa }.
// Alimentada pelas correções do Comparativo quando a contrapartida NÃO é banco.
export async function aprenderCorrecaoContabil(clienteId, { historico, contaErrada, contaCerta, usuario }) {
  const termo = extrairEntidade(historico)
  if (!clienteId || !termo || !tokensHist(termo).length || !contaErrada || !contaCerta) return null
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'memoria_correcao').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const atual = Array.isArray(data?.dados) ? data.dados : []
  // Chave = termo + conta errada. Substitui a conta certa se já existir.
  const key = `${termo}|${contaErrada}`
  const nova = atual.filter(x => `${x.termo}|${x.conta}` !== key)
  nova.push({ termo, conta: String(contaErrada), certa: String(contaCerta), usuario: usuario || null })
  await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', 'memoria_correcao')
  await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: 'memoria_correcao', dados: nova, usuario, obs: 'memória de correção contábil' })
  return `${termo} → ${contaCerta}`
}

// ---------------------------------------------------------------------------
// Decide, a partir de uma correção, se aprende no BANCO (memória financeira) ou
// como CORREÇÃO CONTÁBIL (esta memória). Devolve texto "termo → conta" ou null.
export async function aprenderDaCorrecao({ clienteId, historico, contrapartida, contaErrada, contaCerta, usuario }) {
  if (!clienteId) return null
  const dig = v => String(v ?? '').replace(/\D/g, '')
  const contra = dig(contrapartida)
  const { data: cb } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const bancos = new Set((Array.isArray(cb?.dados) ? cb.dados : []).map(b => dig(b.conta_contabil)).filter(Boolean))
  const termo = extrairEntidade(historico)
  if (!termo || !tokensHist(termo).length) return null
  if (contra && bancos.has(contra)) {
    // Contra o banco → memória da integração financeira (histórico → conta corrigida).
    const { data } = await supabase.from('cargas_cadastro').select('dados, obs')
      .eq('cliente_id', clienteId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle()
    const nova = aprender(Array.isArray(data?.dados) ? data.dados : [], [{ termo, conta: contaCerta }])
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', clienteId).eq('tipo', 'memoria_financeira')
    await supabase.from('cargas_cadastro').insert({ cliente_id: clienteId, tipo: 'memoria_financeira', dados: nova, usuario, obs: data?.obs || 'aprendizado por correção' })
    return `${termo} → ${contaCerta}`
  }
  // Sem banco → memória de correção contábil (para sugerir quando reaparecer).
  return await aprenderCorrecaoContabil(clienteId, { historico, contaErrada, contaCerta, usuario })
}

// ---------------------------------------------------------------------------
// Gera as sugestões (apropriações + correções recorrentes) na competência.
// Idempotente: não duplica sugestões já existentes nem itens já lançados.
export async function gerarSugestoesDoRazao(clienteId, competenciaId, competencia, usuario) {
  if (!clienteId || !competenciaId || !competencia) return { apropriacoes: 0, correcoes: 0 }
  // Sugestões já existentes nesta competência (por item), para não duplicar. Inclui as
  // já CONFIRMADAS e DESCARTADAS (tipo 'Sugestão*') — uma sugestão tratada não volta.
  const { data: jaSug } = await supabase.from('auditoria').select('item')
    .eq('competencia_id', competenciaId).like('tipo', 'Sugest%')
  const itensExist = new Set((jaSug || []).map(s => s.item))
  const novas = []

  // ---- 1) APROPRIAÇÕES (seguro + despesa) ----
  const { data: lancs } = await supabase.from('lancamentos').select('origem, documento, historico')
    .eq('competencia_id', competenciaId).in('origem', ['seguro', 'despesa', 'sugestao'])
  const jaApropriado = new Set((lancs || []).filter(l => /apropria/i.test(l.historico || '')).map(l => String(l.documento || '').trim()).filter(Boolean))

  const fontes = [
    { tabela: 'seguros', origem: 'seguro', doc: c => c.apolice, nome: c => `seguro ${c.seguradora || ''} ${c.apolice || ''}`.trim() },
    { tabela: 'despesas_apropriar', origem: 'despesa', doc: c => c.documento, nome: c => `despesa ${c.tipo || c.descricao || ''}`.trim() },
  ]
  for (const f of fontes) {
    const { data: contratos } = await supabase.from(f.tabela).select('*').eq('cliente_id', clienteId)
    for (const c of (contratos || [])) {
      const valor = valorApropriacaoMes(c, competencia)
      if (!(valor > 0) || !c.conta_despesa || !c.conta_apropriar) continue
      const docId = String(f.doc(c) || '').trim()
      if (docId && jaApropriado.has(docId)) continue // já foi lançada manualmente
      const item = `Apropriação · ${f.nome(c)}`
      if (itensExist.has(item)) continue
      const { num, total } = parcelaDoMes(c, competencia)
      const humano = `Apropriação ${f.nome(c)}${total ? ` · parcela ${num}/${total}` : ''} · ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
      novas.push({
        competencia_id: competenciaId, modulo: 'Apropriação', item, tipo: 'Sugestão', usuario,
        detalhe: encodePartida(humano, { conta_debito: c.conta_despesa, conta_credito: c.conta_apropriar, valor, data: dataFimMes(competencia) }),
      })
    }
  }
  const nApr = novas.length

  // ---- 2) CORREÇÕES RECORRENTES (memória de correção × razão do mês) ----
  const { data: memRow } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'memoria_correcao').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const memoria = Array.isArray(memRow?.dados) ? memRow.dados : []
  if (memoria.length) {
    const { data: razao } = await supabase.from('razao').select('id, conta, historico, debito, credito')
      .eq('competencia_id', competenciaId)
    for (const l of (razao || [])) {
      const htoks = new Set(tokensHist(l.historico))
      if (!htoks.size) continue
      for (const m of memoria) {
        if (String(l.conta) !== String(m.conta)) continue // mesma conta errada
        const tt = tokensHist(m.termo)
        if (!tt.length || !tt.every(t => htoks.has(t))) continue // mesma entidade
        const foiDeb = Number(l.debito) > 0
        const valor = Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0))
        if (!(valor > 0)) continue
        const cd = foiDeb ? m.certa : m.conta
        const cc = foiDeb ? m.conta : m.certa
        const item = `Correção · ${m.conta} → ${m.certa} · ${String(l.historico || '').slice(0, 30)}`
        if (itensExist.has(item)) continue
        itensExist.add(item)
        const humano = `Reclassificar ${m.conta} → ${m.certa} · ${l.historico || ''}`.trim()
        novas.push({
          competencia_id: competenciaId, modulo: 'Correção', item, tipo: 'Sugestão', usuario,
          detalhe: encodePartida(humano, { conta_debito: cd, conta_credito: cc, valor, data: dataFimMes(competencia) }),
        })
        break // uma sugestão por linha
      }
    }
  }

  if (novas.length) {
    for (let i = 0; i < novas.length; i += 200) await supabase.from('auditoria').insert(novas.slice(i, i + 200))
  }
  return { apropriacoes: nApr, correcoes: novas.length - nApr }
}

function dataFimMes(competencia) {
  const [m, a] = String(competencia || '').split('/').map(Number)
  if (!m || !a) return ''
  return `${a}-${String(m).padStart(2, '0')}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`
}
