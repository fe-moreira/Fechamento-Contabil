import { supabase } from './supabase'

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

// Títulos em aberto de ABERTURA de uma conta (só na competência inicial), devolvidos como
// lançamentos sintéticos: entram na conciliação como "saldo anterior" e casam por NF com as
// baixas do mês (recebimento/pagamento), zerando o que já foi liquidado.
export async function composicaoAbertura(empresaId, compId, contaCod, classifRaw) {
  if (!(await ehCompetenciaInicial(empresaId, compId))) return []
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

// Balancete hierárquico (sintéticas + analíticas) de uma competência.
// Os movimentos (razão/balancete) vêm pelo CÓDIGO da conta (reduzido); o plano traduz
// cada código para a sua CLASSIFICAÇÃO hierárquica (coluna O) e nome, e as sintéticas
// são os totais agregados por prefixo da classificação (segundo a máscara).
export async function montarBalancete(empresaId, compId) {
  const { data: planoCarga } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const plano = parsePlano(planoCarga?.dados)
  const mascara = (plano.find(p => p.mascara)?.mascara) || '9.9.9.999.9999'
  const cortes = cortesDaMascara(mascara)
  const temPlano = plano.length > 0

  // Índices do plano: por código (reduzido → conta) e por classificação (classif → conta).
  const porReduzido = {}, porClassif = {}
  for (const p of plano) {
    if (p.reduzido && !porReduzido[p.reduzido]) porReduzido[p.reduzido] = p
    if (p.classif && !porClassif[p.classif]) porClassif[p.classif] = p
  }

  const { data: bal } = await supabase.from('balancete')
    .select('conta, nome, debito, credito, saldo_inicial').eq('competencia_id', compId)
  const movs = bal || []

  const map = {}
  const ensure = classif => map[classif] || (map[classif] = {
    reduzido: '', classif, nome: '', folha: false, debito: 0, credito: 0, saldo_inicial: 0,
  })

  for (const mv of movs) {
    const cod = String(mv.conta || '').trim(); if (!cod) continue
    const deb = Number(mv.debito) || 0, cre = Number(mv.credito) || 0, ini = Number(mv.saldo_inicial) || 0
    const p = porReduzido[cod]
    const classif = p ? p.classif : cod
    const folha = ensure(classif)
    folha.folha = true
    folha.debito += deb; folha.credito += cre; folha.saldo_inicial += ini
    if (!folha.nome && (p?.nome || mv.nome)) folha.nome = p?.nome || mv.nome
    if (!folha.reduzido) folha.reduzido = p?.reduzido || cod
    // Ancestrais (sintéticas): prefixos da classificação nos cortes da máscara (com plano),
    // ou pelos pontos do próprio código (fallback sem plano).
    if (p) {
      for (const corte of cortes) { if (corte < classif.length) { const e = ensure(classif.slice(0, corte)); e.debito += deb; e.credito += cre; e.saldo_inicial += ini } }
    } else {
      const segs = classif.split('.')
      for (let i = 1; i < segs.length; i++) { const e = ensure(segs.slice(0, i).join('.')); e.debito += deb; e.credito += cre; e.saldo_inicial += ini }
    }
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
        if (jaTinha.has(classif)) continue
        const folha = ensure(classif); folha.folha = true
        if (!folha.nome && p?.nome) folha.nome = p.nome
        if (!folha.reduzido) folha.reduzido = p?.reduzido || cod
        folha.saldo_inicial += val
        if (p) { for (const corte of cortes) { if (corte < classif.length) ensure(classif.slice(0, corte)).saldo_inicial += val } }
        else { const segs = classif.split('.'); for (let i = 1; i < segs.length; i++) ensure(segs.slice(0, i).join('.')).saldo_inicial += val }
      }
    }
  }

  // Enriquecer cada nó com nome/reduzido do plano (sintéticas inclusive).
  for (const e of Object.values(map)) {
    const p = porClassif[e.classif]
    if (p) { if (p.reduzido) e.reduzido = p.reduzido; if (p.nome) e.nome = p.nome }
  }

  const comMov = l => Math.abs(l.debito) > 0.005 || Math.abs(l.credito) > 0.005 || Math.abs(l.saldo_inicial) > 0.005
  // Ordem de balancete = ordem da árvore: comparação lexicográfica da classificação.
  // Como a máscara tem tamanhos fixos por nível, o prefixo (sintética) vem sempre antes
  // dos seus filhos — diferente da ordem numérica, que misturaria os níveis.
  const ordena = (a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0
  const grauDe = classif => temPlano ? Math.max(1, cortes.filter(c => c <= classif.length).length) : classif.split('.').length

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
