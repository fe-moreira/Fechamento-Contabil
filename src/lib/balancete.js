import { supabase } from './supabase'
import { itensAbertosConta } from './aberturaArrasto'
import { aberturaComp } from './cargaInicial'

const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Regra: NUNCA lançar em conta SINTÉTICA (só analíticas recebem lançamento).
// Recebe o plano (useAppData().plano = [{cod, sintetica}]) e os códigos da partida;
// devolve a mensagem de erro se algum for sintético, senão string vazia.
export function erroContaSintetica(plano, ...contas) {
  const sint = new Map((plano || []).map(p => [String(p.cod), { sintetica: p.sintetica, nome: p.nome }]))
  const ruins = [...new Set(contas.filter(Boolean).map(String))].filter(c => sint.get(c)?.sintetica)
  if (!ruins.length) return ''
  const lista = ruins.map(c => `${c}${sint.get(c)?.nome ? ' · ' + sint.get(c).nome : ''}`).join('; ')
  return `Conta sintética não recebe lançamento: ${lista}. Use a conta analítica correspondente.`
}

// Diferença de conciliação respeitando a NATUREZA da conta. O documento (guia,
// extrato, relatório) vem SEMPRE positivo. Numa conta DEVEDORA (saldo > 0) a
// diferença é saldo − documento; numa CREDORA (saldo < 0) é saldo + documento.
// Assim, quando |saldo| == |documento|, a diferença é zero — não importa o sinal.
export function difConciliacao(saldo, doc) {
  const s = Number(saldo) || 0
  const v = Math.abs(Number(doc) || 0)
  const nat = s < 0 ? -1 : 1 // credora subtrai o documento (soma ao saldo negativo)
  return Math.round((s - nat * v) * 100) / 100
}

// Contas Ativo/Passivo ainda "em aberto" na conciliação: saldo efetivo (balancete +
// lançamentos) ≠ 0 e SEM documento que bate nem justificativa. Fonte única para o gate
// do Status e para o badge do menu (assim os dois números batem). Devolve [{conta, saldo_final}].
export async function contasConciliacaoAbertas(empresaId, compId) {
  // Usa o MESMO balancete montado que a Conciliação usa (não a tabela `balancete` crua),
  // para o saldo bater exatamente com o painel — assim badge/Status/financeiro ficam iguais.
  const { linhas } = await montarBalancete(empresaId, compId)
  const [{ data: conc }, { data: lancs }, { data: planoCarga }] = await Promise.all([
    supabase.from('conciliacao_conta').select('conta, saldo_documento, documento_path, conciliada, justificativa').eq('competencia_id', compId),
    supabase.from('lancamentos').select('conta_debito, conta_credito, valor').eq('competencia_id', compId),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  const conf = {}; for (const r of (conc || [])) conf[String(r.conta)] = r
  const aj = {}
  for (const l of (lancs || [])) {
    const v = Number(l.valor) || 0
    if (l.conta_debito) aj[String(l.conta_debito)] = (aj[String(l.conta_debito)] || 0) + v
    if (l.conta_credito) aj[String(l.conta_credito)] = (aj[String(l.conta_credito)] || 0) - v
  }
  const saldoBal = {}, classifDe = {}
  for (const l of linhas) {
    if (l.sintetica) continue
    const cod = String(l.reduzido || ''); if (!cod) continue
    saldoBal[cod] = Number(l.saldo_final) || 0
    classifDe[cod] = String(l.classifRaw || l.classif || '')
  }
  // Contas que só têm lançamento (não vieram no balancete) → classifica pelo plano.
  for (const p of parsePlano(planoCarga?.dados)) if (p.reduzido && !classifDe[String(p.reduzido)]) classifDe[String(p.reduzido)] = String(p.classif || '')
  const ehAP = c => { const d = String(classifDe[String(c)] || '').trim()[0]; return d === '1' || d === '2' }
  const cands = new Set([...Object.keys(saldoBal), ...Object.keys(aj)].filter(ehAP))
  const conciliada = (c, saldoEf) => {
    const reg = conf[String(c)]; if (!reg) return false
    if (reg.documento_path && reg.saldo_documento != null && Math.abs(difConciliacao(saldoEf, reg.saldo_documento)) < 0.05) return true
    if (reg.conciliada && reg.justificativa) return true
    return false
  }
  const out = []
  for (const c of cands) { const saldoEf = (saldoBal[c] || 0) + (aj[c] || 0); if (Math.abs(saldoEf) > 0.005 && !conciliada(c, saldoEf)) out.push({ conta: c, saldo_final: saldoEf }) }
  return out
}

// Confere o BALANCETE importado (exportado do Domínio depois de subir as correções) contra
// o saldo EFETIVO da conciliação (balancete do razão + acertos pendentes) das contas de
// Ativo/Passivo. Casa cada conta pelo código reduzido OU pela classificação (tanto faz) e
// compara em MÓDULO (não depende do sinal/convenção D-C do arquivo). Retorna as divergências.
// `importado`: [{ cod, classif, saldo }] lido do arquivo do balancete.
export async function conferirBalanceteEncerramento(empresaId, compId, importado) {
  const { linhas } = await montarBalancete(empresaId, compId)
  const { data: lancs } = await supabase.from('lancamentos').select('conta_debito, conta_credito, valor').eq('competencia_id', compId)
  const aj = {}
  for (const l of (lancs || [])) {
    const v = Number(l.valor) || 0
    if (l.conta_debito) aj[String(l.conta_debito)] = (aj[String(l.conta_debito)] || 0) + v
    if (l.conta_credito) aj[String(l.conta_credito)] = (aj[String(l.conta_credito)] || 0) - v
  }
  const dig = s => String(s || '').replace(/\D/g, '')
  const porCod = {}, porClassif = {}
  for (const r of (importado || [])) {
    if (r.saldo == null) continue
    if (r.cod) porCod[String(r.cod).trim()] = Number(r.saldo)
    if (r.classif) porClassif[dig(r.classif)] = Number(r.saldo)
  }
  const divergencias = []
  let verificados = 0
  for (const l of linhas) {
    if (l.sintetica) continue
    const d = dig(l.classifRaw || l.classif)[0]
    if (d !== '1' && d !== '2') continue // só Ativo/Passivo (escopo da conciliação)
    const efetivo = Math.round(((Number(l.saldo_final) || 0) + (aj[String(l.reduzido)] || 0)) * 100) / 100
    if (Math.abs(efetivo) < 0.005) continue // conta zerada não precisa constar
    verificados++
    let imp = porCod[String(l.reduzido)]
    if (imp == null) imp = porClassif[dig(l.classifRaw || l.classif)]
    if (imp == null) { divergencias.push({ conta: l.reduzido, nome: l.nome, esperado: efetivo, importado: null, dif: efetivo }); continue }
    const dif = Math.round((Math.abs(efetivo) - Math.abs(imp)) * 100) / 100
    if (Math.abs(dif) >= 0.05) divergencias.push({ conta: l.reduzido, nome: l.nome, esperado: efetivo, importado: imp, dif })
  }
  return { verificados, bate: verificados > 0 && divergencias.length === 0, divergencias }
}

// Aplica a máscara do Domínio (ex.: "9.9.9.999.9999") a uma classificação sem pontos.
// "1110010001" → "1.1.1.001.0001"; aceita códigos parciais (sintéticas): "111001" → "1.1.1.001".
export function applyMask(code, mask) {
  const c = String(code ?? '')
  if (!mask || !c) return c
  const tams = String(mask).split('.').map(s => s.length)
  const out = []
  let i = 0
  for (const t of tams) {
    if (i >= c.length) break
    out.push(c.slice(i, i + t))
    i += t
  }
  return out.join('.')
}

// Comprimentos acumulados de cada nível da máscara: "9.9.9.999.9999" → [1,2,3,6,10].
function cortesDaMascara(mask) {
  const tams = String(mask || '').split('.').map(s => s.length).filter(Boolean)
  const cortes = []
  let acc = 0
  for (const t of tams) { acc += t; cortes.push(acc) }
  return cortes
}

// Lê o plano de contas importado (export do Domínio) → [{ reduzido, classif, nome, sintetica, mascara }].
// reduzido = código da conta (o que aparece no razão); classif = classificação hierárquica (coluna O).
export function parsePlano(dados) {
  const rows = Array.isArray(dados) ? dados : []
  if (!rows.length) return []
  const keys = Object.keys(rows[0])
  const find = (...res) => { for (const re of res) { const k = keys.find(k => re.test(baixa(k))); if (k) return k } return null }
  const kClass = find(/classifica/, /classif/)
  const kRed = find(/codigo.?conta/, /codigo|reduz/, /^cod/)
  const kNome = find(/nome.?conta/, /nome|descri/)
  const kTipo = find(/tipo.?conta/) || keys.find(k => baixa(k) === 't') || find(/^tipo$/)
  const kMask = find(/mascara.?relat/, /mascara/)
  const out = []
  for (const r of rows) {
    const classif = String((kClass != null ? r[kClass] : '') ?? '').trim()
    if (!classif || !/^\d/.test(classif)) continue
    const tipo = String((kTipo != null ? r[kTipo] : '') ?? '').trim().toUpperCase().slice(0, 1)
    out.push({
      reduzido: String((kRed != null ? r[kRed] : '') ?? '').trim(),
      classif,
      nome: String((kNome != null ? r[kNome] : '') ?? '').trim(),
      sintetica: tipo === 'S',
      mascara: String((kMask != null ? r[kMask] : '') ?? '').trim(),
    })
  }
  // Robustez entre formatos: além da coluna "tipo", uma conta é SINTÉTICA (conta-mãe) se
  // tiver DESCENDENTES no plano — a classificação de outra conta a estende. Cobre os
  // formatos em que a coluna de tipo não vem (ou vem diferente), onde a mãe (ex.: FRETE)
  // era lida como analítica e a hierarquia não somava. Nunca marca uma folha como sintética
  // (folha não tem descendente). Detecção O(n log n): no plano ORDENADO pela classificação,
  // a conta é mãe quando a PRÓXIMA classificação começa com a dela (respeitando o separador).
  const comCl = out.filter(p => p.classif)
  const ord = [...comCl].sort((a, b) => (a.classif < b.classif ? -1 : a.classif > b.classif ? 1 : 0))
  for (let i = 0; i < ord.length - 1; i++) {
    if (ord[i].sintetica) continue
    const c = ord[i].classif, prox = ord[i + 1].classif
    if (prox.length > c.length && prox.startsWith(c) && (c.includes('.') ? prox[c.length] === '.' : true)) ord[i].sintetica = true
  }
  return out
}

// ---- Carga inicial (abertura): saldos + composições digitados na Base de Informações ----
// Gravada em cargas_cadastro tipo 'financeiro' com dados no formato
// { saldos:[...], composicoes:[...] } (a carga mensal de financeiro é um array simples).
const normCK = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const campoPor = (obj, re) => { const k = Object.keys(obj || {}).find(k => re.test(normCK(k))); return k ? obj[k] : '' }
const soDig = v => String(v ?? '').replace(/\D/g, '')
const codConta = r => campoPor(r, /^conta$/) || campoPor(r, /^codigo$/) || campoPor(r, /codigo|conta/)
function numBR(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '')
  if (!s) return 0
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s); return isNaN(n) ? 0 : n
}
// Saldo com sinal: D (devedor) +, C (credor) −. Usa a coluna D/C; na falta, o sinal do número.
function saldoSinalAb(valor, dc) {
  const n = numBR(valor), s = String(dc ?? '').trim()
  if (/c/i.test(s)) return -Math.abs(n)
  if (/d/i.test(s)) return Math.abs(n)
  return n
}

// Data de uma célula de planilha em "AAAA-MM-DD": aceita Date, "DD/MM/AAAA" e o
// número de série do Excel (ex.: 46120 → 2026-04-08). Usada para mostrar a data
// REAL dos títulos de abertura (jan/fev/mar…), e não "abertura".
function dataCelulaISO(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  if (typeof v === 'number' && v > 20000 && v < 90000) {
    const d = new Date(Math.round((v - 25569) * 86400000)) // 25569 = 1970-01-01 no serial do Excel
    if (!isNaN(d)) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }
  const s = String(v ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/)
  if (m) { let [, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}` }
  return ''
}

// Normaliza um valor de competência para "MM/AAAA". Aceita "MM/AAAA", "M/AAAA",
// ISO "AAAA-MM(-DD)", "MM-AAAA" e o número de série de data do Excel (ex.: 46174 → 06/2026,
// que é como uma célula de data vem da planilha). Retorna '' quando não reconhece.
export function normalizaCompetencia(v) {
  if (v == null) return ''
  const s = String(v).trim()
  if (!s) return ''
  let m = s.match(/^(\d{1,2})\/(\d{4})$/)
  if (m) return `${String(+m[1]).padStart(2, '0')}/${m[2]}`
  m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/)        // ISO AAAA-MM(-DD)
  if (m) return `${String(+m[2]).padStart(2, '0')}/${m[1]}`
  m = s.match(/^(\d{1,2})[-.](\d{4})$/)                          // MM-AAAA / MM.AAAA
  if (m) return `${String(+m[1]).padStart(2, '0')}/${m[2]}`
  const noAno = y => y >= 2000 && y <= 2099
  if (/^\d+(\.\d+)?$/.test(s)) {                                 // série de data do Excel
    const serial = Math.floor(parseFloat(s))
    if (serial > 59 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      if (noAno(d.getUTCFullYear())) return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
    }
  }
  const d = new Date(s)                                          // data textual reconhecível
  if (!isNaN(d.getTime()) && noAno(d.getFullYear())) return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
  return ''
}

// Carga inicial mais recente do cliente (saldos de abertura + composições de abertura).
export async function carregarCargaInicial(empresaId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados, vigencia, created_at')
    .eq('cliente_id', empresaId).eq('tipo', 'financeiro').order('created_at', { ascending: false })
  for (const c of (data || [])) {
    const d = c?.dados
    if (d && !Array.isArray(d) && (Array.isArray(d.saldos) || Array.isArray(d.composicoes)))
      return { saldos: d.saldos || [], composicoes: d.composicoes || [], vigencia: c.vigencia }
  }
  return { saldos: [], composicoes: [], vigencia: null }
}

// A competência informada é a de ABERTURA do cliente (== competencia_inicio)?
export async function ehCompetenciaInicial(empresaId, compId) {
  const [{ data: comp }, { data: cli }] = await Promise.all([
    supabase.from('competencias').select('ano, mes').eq('id', compId).maybeSingle(),
    supabase.from('clientes').select('competencia_inicio').eq('id', empresaId).maybeSingle(),
  ])
  const m = normalizaCompetencia(cli?.competencia_inicio).match(/^(\d{2})\/(\d{4})$/)
  if (!comp || !m) return false
  return comp.mes === +m[1] && comp.ano === +m[2]
}

// Competência imediatamente ANTERIOR (mesmo cliente) para o arrasto de saldos, mas só
// a partir do mês seguinte ao início — antes do início são meses só do comparativo, que
// não arrastam. Devolve o id da competência anterior (>= início) ou null.
export async function competenciaAnterior(empresaId, compId) {
  const [{ data: atual }, { data: cli }] = await Promise.all([
    supabase.from('competencias').select('ano, mes').eq('id', compId).maybeSingle(),
    supabase.from('clientes').select('competencia_inicio').eq('id', empresaId).maybeSingle(),
  ])
  if (!atual) return null
  const ord = atual.ano * 12 + atual.mes
  const mi = normalizaCompetencia(cli?.competencia_inicio).match(/^(\d{2})\/(\d{4})$/)
  const ordInicio = mi ? (+mi[2]) * 12 + (+mi[1]) : -Infinity
  if (ord <= ordInicio) return null // início (ou antes) não arrasta de meses anteriores
  const { data: comps } = await supabase.from('competencias').select('id, ano, mes').eq('cliente_id', empresaId)
  let melhor = null
  for (const c of (comps || [])) {
    const o = c.ano * 12 + c.mes
    if (o < ord && o >= ordInicio && (!melhor || o > melhor.o)) melhor = { id: c.id, o }
  }
  return melhor ? melhor.id : null
}

// Títulos em aberto de ABERTURA de uma conta como lançamentos sintéticos: entram na
// conciliação como "saldo anterior" e casam por NF com as baixas do mês (recebimento/
// pagamento), zerando o que já foi liquidado.
// - Competência INICIAL do cliente: vêm da CARGA INICIAL (composições informadas).
// - Demais competências: ARRASTO — o que ficou em aberto no mês ANTERIOR (recursivo).
//   Assim, se você mexer no mês anterior, a abertura deste mês atualiza sozinha.
export async function composicaoAbertura(empresaId, compId, contaCod, classifRaw, contaNome = '', _depth = 0) {
  if (await ehCompetenciaInicial(empresaId, compId)) {
    const { composicoes } = await carregarCargaInicial(empresaId)
    if (!composicoes.length) return []
    const alvo = new Set([soDig(contaCod), soDig(classifRaw)].filter(Boolean))
    const out = []
    let i = 0
    for (const r of composicoes) {
      if (!alvo.has(soDig(codConta(r)))) continue
      const valor = saldoSinalAb(campoPor(r, /valor|saldo/), campoPor(r, /^d\/?c$|natureza/))
      if (Math.abs(valor) < 0.005) continue
      const cliente = String(campoPor(r, /cliente|fornec|nome|descri|histor/) || '').trim()
      const nf = String(campoPor(r, /\bnf\b|nota|document/) || '').trim()
      // Data REAL do título (jan/fev/mar…), mesmo sem os meses anteriores fechados.
      // Tudo isso compõe o saldo inicial (entendido como o último dia antes da abertura).
      const dt = dataCelulaISO(campoPor(r, /data/))
      out.push({
        id: `abertura-${i++}`, data: dt || 'abertura', contrapartida: '',
        historico: `Saldo anterior · ${cliente}${nf ? ' · NF ' + nf : ''}`,
        debito: valor > 0 ? valor : 0, credito: valor < 0 ? -valor : 0, abertura: true,
        leitura: { nf, entidade: cliente, ident: !!cliente, conf: (cliente && nf) ? 'alta' : cliente ? 'media' : 'baixa', abertura: true },
      })
    }
    return out
  }
  // Fora da competência inicial: arrasta o que ficou em aberto no mês anterior.
  if (_depth > 24) return []
  const ant = await competenciaAnterior(empresaId, compId)
  if (!ant) return []
  const aberturaAnt = await composicaoAbertura(empresaId, ant, contaCod, classifRaw, contaNome, _depth + 1)
  return await itensAbertosConta(ant, contaCod, contaNome, classifRaw, aberturaAnt)
}

// Exclui UMA linha da composição (e o saldo gêmeo, se houver) da carga inicial que casa
// com o item de "Saldo anterior" clicado na Conciliação — para tirar um saldo inicial
// duplicado/errado sem ir à Base de Informações. Bloqueia se a competência de abertura
// estiver FECHADA (mexer no saldo inicial arrasta para os meses seguintes). Registra
// auditoria. `alvo`: { conta, classifRaw, valor (D−C com sinal), cliente, data (ISO) }.
export async function excluirLinhaAbertura(empresaId, alvo, usuario) {
  const { data: cli } = await supabase.from('clientes').select('competencia_inicio').eq('id', empresaId).maybeSingle()
  const compIni = normalizaCompetencia(cli?.competencia_inicio)
  const ab = await aberturaComp(empresaId, compIni)
  if (ab.fechada) throw new Error('A competência de abertura está FECHADA — reabra-a para excluir o saldo inicial.')

  const { data: cargas } = await supabase.from('cargas_cadastro').select('id, dados, obs')
    .eq('cliente_id', empresaId).eq('tipo', 'financeiro').order('created_at', { ascending: false })
  const rec = (cargas || []).find(c => { const d = c?.dados; return d && !Array.isArray(d) && (Array.isArray(d.composicoes) || Array.isArray(d.saldos)) })
  if (!rec) throw new Error('Não encontrei a carga inicial para excluir a linha.')

  const alvoContas = new Set([soDig(alvo.conta), soDig(alvo.classifRaw)].filter(Boolean))
  const cliAlvo = String(alvo.cliente ?? '').trim()
  const casa = r => {
    if (!alvoContas.has(soDig(codConta(r)))) return false
    const v = saldoSinalAb(campoPor(r, /valor|saldo/), campoPor(r, /^d\/?c$|natureza/))
    if (Math.abs(v - (Number(alvo.valor) || 0)) > 0.005) return false
    if (cliAlvo) { const c = String(campoPor(r, /cliente|fornec|nome|descri|histor/) || '').trim(); if (c !== cliAlvo) return false }
    if (alvo.data) { if (dataCelulaISO(campoPor(r, /data/)) !== alvo.data) return false }
    return true
  }
  // Remove no máximo UMA composição e, se houver, o saldo gêmeo (mesmos conta+valor+nome+data).
  const comps = Array.isArray(rec.dados.composicoes) ? [...rec.dados.composicoes] : []
  const saldos = Array.isArray(rec.dados.saldos) ? [...rec.dados.saldos] : []
  const iComp = comps.findIndex(casa)
  if (iComp >= 0) comps.splice(iComp, 1)
  const iSaldo = saldos.findIndex(casa)
  if (iSaldo >= 0) saldos.splice(iSaldo, 1)
  if (iComp < 0 && iSaldo < 0) return { removidas: 0 }

  const { error } = await supabase.from('cargas_cadastro').update({ dados: { ...rec.dados, composicoes: comps, saldos }, usuario }).eq('id', rec.id)
  if (error) throw error
  if (ab.id) {
    try {
      await supabase.from('auditoria').insert({
        competencia_id: ab.id, modulo: 'Conciliação', item: `Saldo inicial ${alvo.conta}`, tipo: 'Correção',
        detalhe: `Linha do saldo inicial excluída — ${cliAlvo || 's/ nome'}${alvo.data ? ' · ' + alvo.data : ''} · ${(Number(alvo.valor) || 0).toFixed(2)}`,
        usuario: usuario || null,
      })
    } catch { /* auditoria é best-effort */ }
  }
  return { removidas: (iComp >= 0 ? 1 : 0) + (iSaldo >= 0 ? 1 : 0) }
}

// Balancete hierárquico (sintéticas + analíticas) de uma competência.
// Os movimentos (razão/balancete) vêm pelo CÓDIGO da conta (reduzido); o plano traduz
// cada código para a sua CLASSIFICAÇÃO hierárquica (coluna O) e nome, e as sintéticas
// são os totais agregados por prefixo da classificação (segundo a máscara).
// opts.comLancamentos: sobrepõe os LANÇAMENTOS gerados (correções, apropriações,
// contabilizações confirmadas — tabela `lancamentos`) sobre o razão importado, para
// que os relatórios/cockpit/documentos leiam o razão "vivo" (mescla de tudo). É a fonte
// ÚNICA das correções: nenhum fluxo mexe no balancete importado; todo ajuste vira um
// lançamento e aparece por esta sobreposição. LIGAR nos consumidores que mostram o razão
// vivo (Relatórios, Cockpit, Book, Comparativo Completo, Comparativo de Movimento).
// DESLIGAR só na Conciliação, que faz a própria sobreposição por conta (não contar em dobro).
export async function montarBalancete(empresaId, compId, _depth = 0, opts = {}) {
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  const mascara = (plano.find(p => p.mascara)?.mascara) || '9.9.9.999.9999'
  const cortes = cortesDaMascara(mascara)
  const temPlano = plano.length > 0

  // Ancestrais (sintéticas) de uma classificação = as sintéticas REAIS do plano cujo código
  // de classificação é PREFIXO desta. A hierarquia do Domínio é por prefixo, mas com larguras
  // IRREGULARES (ex.: 1 → 11 → 111 → 1110010 → 1110010000000001), e a máscara declarada
  // muitas vezes NÃO bate com os níveis reais — cortar pela máscara criava níveis fantasma
  // ("—" sem nome) e deixava sintéticas (ex.: DISPONIBILIDADES) sem somar. Usar as sintéticas
  // reais resolve para qualquer formato de plano.
  const sintSet = new Set(plano.filter(p => p.sintetica && p.classif).map(p => p.classif))
  const sintLens = [...new Set([...sintSet].map(c => c.length))].sort((a, b) => a - b)
  const ancestraisDe = classif => {
    const out = []
    for (const L of sintLens) { if (L < classif.length) { const pref = classif.slice(0, L); if (sintSet.has(pref)) out.push(pref) } }
    return out
  }
  // Agrega o valor da analítica nas suas sintéticas (com plano, por prefixo real; sem plano,
  // pelos pontos da classificação).
  const agregar = (classif, temP, fn) => {
    if (temP && sintSet.size) { for (const anc of ancestraisDe(classif)) fn(ensure(anc)) }
    else { const segs = classif.split('.'); for (let i = 1; i < segs.length; i++) fn(ensure(segs.slice(0, i).join('.'))) }
  }

  // Índices do plano: por código (reduzido → conta) e por classificação (classif → conta).
  const porReduzido = {}, porClassif = {}
  for (const p of plano) {
    if (p.reduzido && !porReduzido[p.reduzido]) porReduzido[p.reduzido] = p
    if (p.classif && !porClassif[p.classif]) porClassif[p.classif] = p
  }

  const { data: bal } = await supabase.from('balancete')
    .select('conta, nome, debito, credito, saldo_inicial').eq('competencia_id', compId)
  const movs = [...(bal || [])]

  // SISTEMA VIVO: sobrepõe os lançamentos confirmados sobre o razão. Cada lançamento
  // vira dois movimentos sintéticos (débito numa conta, crédito na outra), processados
  // pelo MESMO caminho das linhas do balancete (folha + ancestrais). Vale para a própria
  // competência e para o arrasto recursivo (mexeu no mês anterior → saldo inicial deste
  // mês acompanha).
  if (opts.comLancamentos) {
    const { data: lancs } = await supabase.from('lancamentos')
      .select('conta_debito, conta_credito, valor').eq('competencia_id', compId)
    for (const l of (lancs || [])) {
      const v = Number(l.valor) || 0
      if (Math.abs(v) < 0.005) continue
      const cd = String(l.conta_debito || '').trim(), cc = String(l.conta_credito || '').trim()
      if (cd) movs.push({ conta: cd, nome: '', debito: v, credito: 0, saldo_inicial: 0 })
      if (cc) movs.push({ conta: cc, nome: '', debito: 0, credito: v, saldo_inicial: 0 })
    }
  }

  const map = {}
  // `key` = identidade do nó no mapa. FOLHAS (analíticas) são keyed pelo CÓDIGO REDUZIDO
  // (#reduzido) — nunca pela classificação, porque várias analíticas dividem a mesma
  // classificação (ex.: todos os bancos = 1101030100) e se fundiriam numa linha só.
  // SINTÉTICAS (totais) continuam keyed pelo prefixo da classificação. `classif` guarda a
  // classificação (crua) para ordenar e montar a máscara.
  const ensure = (key, classif = key) => map[key] || (map[key] = {
    reduzido: '', classif, nome: '', folha: false, debito: 0, credito: 0, saldo_inicial: 0,
  })
  // Chave da folha: o código reduzido do plano; sem plano, o próprio código do arquivo.
  const folhaKey = (p, cod, classif) => p?.reduzido ? '#' + p.reduzido : classif

  for (const mv of movs) {
    const cod = String(mv.conta || '').trim(); if (!cod) continue
    const deb = Number(mv.debito) || 0, cre = Number(mv.credito) || 0, ini = Number(mv.saldo_inicial) || 0
    // Casa pelo código do arquivo: primeiro como reduzido (o normal), senão como classificação.
    const p = porReduzido[cod] || porClassif[cod]
    const classif = p ? p.classif : cod
    const folha = ensure(folhaKey(p, cod, classif), classif)
    folha.folha = true
    folha.debito += deb; folha.credito += cre; folha.saldo_inicial += ini
    if (!folha.nome && (p?.nome || mv.nome)) folha.nome = p?.nome || mv.nome
    if (!folha.reduzido) folha.reduzido = p?.reduzido || cod
    // Ancestrais (sintéticas): pelas sintéticas REAIS do plano (prefixo), não pela máscara.
    agregar(classif, !!p, e => { e.debito += deb; e.credito += cre; e.saldo_inicial += ini })
  }

  // Saldo de ABERTURA (carga inicial) — só na competência inicial do cliente e só nas contas
  // cujo saldo não veio já no balancete importado (evita duplicar).
  if (await ehCompetenciaInicial(empresaId, compId)) {
    const { saldos, composicoes } = await carregarCargaInicial(empresaId)
    // Saldo de abertura por conta (código): o bloco de saldos; e, para as contas de
    // COMPOSIÇÃO (clientes, fornecedores, IRRF…), a SOMA dos itens (D − C) — que É o
    // saldo da conta. Se a conta veio nos dois, o bloco de saldos manda (a composição
    // apenas confere), para não somar em dobro.
    const saldoBloco = {}, compBloco = {}
    for (const r of (saldos || [])) {
      const cod = String(codConta(r) || '').trim(); if (!cod) continue
      saldoBloco[cod] = (saldoBloco[cod] || 0) + saldoSinalAb(campoPor(r, /saldo|valor/), campoPor(r, /^d\/?c$|natureza/))
    }
    for (const r of (composicoes || [])) {
      const cod = String(codConta(r) || '').trim(); if (!cod) continue
      compBloco[cod] = (compBloco[cod] || 0) + saldoSinalAb(campoPor(r, /valor|saldo/), campoPor(r, /^d\/?c$|natureza/))
    }
    const saldoPorCod = {}
    for (const cod of new Set([...Object.keys(saldoBloco), ...Object.keys(compBloco)])) {
      saldoPorCod[cod] = (cod in saldoBloco) ? saldoBloco[cod] : compBloco[cod]
    }
    if (Object.keys(saldoPorCod).length) {
      const byRedDig = {}, byClsDig = {}, byMask = {}
      for (const p of plano) {
        if (p.reduzido) byRedDig[soDig(p.reduzido)] = p
        if (p.classif) { byClsDig[soDig(p.classif)] = p; byMask[applyMask(p.classif, mascara)] = p }
      }
      const jaTinha = new Set(Object.keys(map).filter(k => Math.abs(map[k].saldo_inicial) > 0.005))
      for (const [cod, val] of Object.entries(saldoPorCod)) {
        if (Math.abs(val) < 0.005) continue
        const p = porReduzido[cod] || byRedDig[soDig(cod)] || porClassif[cod] || byClsDig[soDig(cod)] || byMask[cod]
        const classif = p ? p.classif : cod
        const chave = folhaKey(p, cod, classif)
        if (jaTinha.has(chave)) continue
        const folha = ensure(chave, classif); folha.folha = true
        if (!folha.nome && p?.nome) folha.nome = p.nome
        if (!folha.reduzido) folha.reduzido = p?.reduzido || cod
        folha.saldo_inicial += val
        agregar(classif, !!p, e => { e.saldo_inicial += val })
      }
    }
  } else if (_depth < 24) {
    // ARRASTO DE SALDOS (rollforward): fora da competência inicial, o saldo inicial de
    // cada conta PATRIMONIAL (Ativo 1 / Passivo+PL 2) = saldo FINAL do mês anterior,
    // calculado AO VIVO (recursivo). Se você mexer no mês anterior, o saldo inicial deste
    // mês — e a conciliação — se atualizam sozinhos. Contas de RESULTADO (3/4/5) NÃO
    // arrastam: o comparativo mostra o movimento do mês.
    const ant = await competenciaAnterior(empresaId, compId)
    if (ant) {
      const { linhas: linhasAnt } = await montarBalancete(empresaId, ant, _depth + 1, opts)
      for (const lp of linhasAnt) {
        if (lp.sintetica) continue // sintéticas são recompostas por agregação abaixo
        const d = String(lp.classifRaw || '').trim()[0]
        if (d !== '1' && d !== '2') continue // só patrimoniais arrastam
        const val = Number(lp.saldo_final) || 0
        if (Math.abs(val) < 0.005) continue
        const classif = lp.classifRaw
        const folha = ensure(lp.reduzido ? '#' + lp.reduzido : classif, classif); folha.folha = true
        if (!folha.nome && lp.nome) folha.nome = lp.nome
        if (!folha.reduzido) folha.reduzido = lp.reduzido
        folha.saldo_inicial += val
        agregar(classif, temPlano, e => { e.saldo_inicial += val })
      }
    }
  }

  // Enriquecer cada nó com nome/reduzido do plano (sintéticas inclusive). NÃO sobrescreve o
  // que a folha já resolveu: como várias analíticas dividem a classificação, porClassif
  // devolveria só a primeira — o nome/reduzido corretos da folha já vieram do movimento.
  for (const e of Object.values(map)) {
    const p = porClassif[e.classif]
    if (p) { if (p.reduzido && !e.reduzido) e.reduzido = p.reduzido; if (p.nome && !e.nome) e.nome = p.nome }
  }

  const comMov = l => Math.abs(l.debito) > 0.005 || Math.abs(l.credito) > 0.005 || Math.abs(l.saldo_inicial) > 0.005
  // Ordem de balancete = ordem da árvore: comparação lexicográfica da classificação.
  // Como a máscara tem tamanhos fixos por nível, o prefixo (sintética) vem sempre antes
  // dos seus filhos — diferente da ordem numérica, que misturaria os níveis.
  // Ordena pela classificação; empate (analíticas que dividem a mesma classificação, ex.:
  // bancos) desempata pelo código reduzido, para a ordem ficar estável.
  const rd = x => String(x.reduzido ?? '')
  const ordena = (a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : (rd(a) < rd(b) ? -1 : rd(a) > rd(b) ? 1 : 0)
  // Grau (nível de indentação) = nº de sintéticas ancestrais + 1 (pela hierarquia real do
  // plano; sem plano, pelos pontos). A máscara não serve porque os níveis reais podem ter
  // larguras irregulares.
  const grauDe = classif => (temPlano && sintSet.size) ? ancestraisDe(classif).length + 1 : classif.split('.').length

  const linhas = Object.values(map).map(e => ({
    reduzido: e.reduzido,
    classif: temPlano ? applyMask(e.classif, mascara) : e.classif,
    classifRaw: e.classif,
    nome: e.nome,
    grau: grauDe(e.classif),
    sintetica: !e.folha,
    saldo_inicial: e.saldo_inicial, debito: e.debito, credito: e.credito,
    saldo_final: e.saldo_inicial + e.debito - e.credito,
  })).filter(comMov).sort(ordena)
  return { temPlano, linhas }
}
