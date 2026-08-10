// Núcleo PURO (sem React/Supabase) da classificação da Conciliação.
//
// Extrai, como funções puras e testáveis, três decisões que hoje vivem embutidas na tela
// `src/pages/Conciliacao.jsx`:
//   1) resolverEntidade  — qual é o nome FINAL de um lançamento (apelido normal × vínculo
//      forçado × correção manual soberana).
//   2) classificarGrupos — quais grupos ZERARAM (conciliados) e quais seguem EM ABERTO.
//   3) aplicarLink        — o LINK/Vincular manual: unifica nomes num canônico e diz quais
//      correções anteriores precisam ser limpas (o link é a ação mais recente e vence).
//
// Regras replicadas fielmente de Conciliacao.jsx (bump ~905-953, ehResolvida ~1178,
// vincularLote ~1755, chaveNome ~685). tokensNome/mesmoCliente são cópia dos de
// aberturaArrasto.js — reimplementados aqui para manter este módulo 100% puro (importar
// aberturaArrasto arrastaria `./supabase`, que instancia um client e quebra fora do browser).

// --- normalização de nomes (cópia fiel de baixaTxt/chaveNome de Conciliacao.jsx) -----------
const baixaTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// chaveNome: minúsculo, sem acento, espaços colapsados. (Igual ao de Conciliacao.jsx —
// NÃO remove pontuação; o comentário de lá diz "sem pontuação", mas o código não a remove.)
export const chaveNome = s => baixaTxt(s).replace(/\s+/g, ' ').trim()

// --- tokensNome / mesmoCliente (cópia fiel de aberturaArrasto.js) --------------------------
const GENERICAS = new Set(['COMPANHIA', 'CIA', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'ENERGIA', 'ENERGIAS', 'ELETRICA', 'ELETRICAS', 'FORCA', 'LUZ', 'COMERCIO', 'COMERCIAL', 'INDUSTRIA', 'INDUSTRIAL', 'SERVICO', 'SERVICOS', 'BRASIL', 'NACIONAL', 'GRUPO', 'HOLDING', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'TRANSPORTE', 'TRANSPORTES', 'LOGISTICA', 'SOLUCOES', 'TECNOLOGIA', 'SISTEMAS', 'ASSOCIACAO', 'INSTITUTO', 'FUNDACAO', 'BANCO', 'SUPERMERCADO', 'SUPERMERCADOS', 'ALIMENTOS',
  'SERV', 'PROPAGANDA', 'CUMULATIVO', 'ACUM', 'PREST', 'PRESTACAO', 'CONTABIL', 'CONTABEIS', 'CONTABILIDADE', 'CONTABILISTAS', 'ASSESSORIA', 'ASSESSORIAS', 'CONSULTORIA', 'CONSULTORIAS', 'EMPRESARIAL', 'EMPRESARIAIS', 'GESTAO', 'TRIBUTARIA', 'ADMINISTRATIVA', 'ADMINISTRATIVOS', 'PERICIA', 'AUDITORIA', 'AUDITORES', 'ESCRITORIO', 'FINANCEIRA', 'RECURSOS', 'HUMANOS', 'NEGOCIOS', 'ESPECIALIZADA', 'PROJETOS', 'INVESTIMENTOS', 'CONTADORES',
  'LTDA', 'EIRELI', 'EPP', 'MEI', 'CF', 'RPS',
  'DO', 'DA', 'DE', 'DOS', 'DAS', 'E', 'EM'])
const normNome = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
export function tokensNome(nome) {
  const todos = normNome(nome).split(' ').filter(Boolean)
  const dist = todos.filter(t => t.length >= 3 && !GENERICAS.has(t))
  if (dist.length) return dist
  const naoGen = todos.filter(t => !GENERICAS.has(t))
  return naoGen.length ? naoGen : todos
}
export function mesmoCliente(a, b) {
  const inter = a.filter(t => b.includes(t))
  if (!inter.length) return false
  const menor = Math.min(a.length, b.length)
  if (a.length === b.length && inter.length === menor) return true
  if (menor === 1) return inter.length === 1 && inter[0].length >= 5
  if (inter.length === menor) return true
  return inter.length / menor >= 0.6 && inter.some(t => t.length >= 4)
}

// --- ov padrão para os testes (débito - crédito) -------------------------------------------
export const ovDC = l => (Number(l.debito) || 0) - (Number(l.credito) || 0)

// ===========================================================================================
// 1) resolverEntidade
// Dado o nome lido de UMA linha e o estado de apelidos da conta, devolve o nome FINAL.
// Ordem (réplica do bump de Conciliacao.jsx):
//   a) APELIDO NORMAL: só troca se for MESMO cliente (compartilha token distintivo).
//   b) VÍNCULO FORÇADO: troca mesmo entre nomes diferentes (o usuário mandou juntar) — MAS a
//      linha CORRIGIDA à mão é soberana: o vínculo forçado NÃO a pega (sai da união).
// ===========================================================================================
export function resolverEntidade(nomeLido, { corrigido = false, aliasNormal = {}, aliasForcado = {} } = {}) {
  let nome = String(nomeLido ?? '').trim()
  if (!nome) return nome
  // CORREÇÃO MANUAL é SOBERANA: uma linha que o usuário corrigiu não é sobrescrita por NADA
  // (nem apelido normal, nem vínculo forçado — e, na tela, nem pelo nome do fiscal por NF). O
  // nome fica exatamente o que o usuário pôs. Ver testes C, D, G e "correção-vence-tudo".
  if (corrigido) return nome
  // a) apelido normal (com trava do "mesmo cliente")
  const al = aliasNormal[chaveNome(nome)]
  if (al && al !== nome && mesmoCliente(tokensNome(nome), tokensNome(al))) nome = al
  // b) vínculo forçado (o usuário mandou juntar) — aplica mesmo entre nomes diferentes
  const alF = aliasForcado[chaveNome(nome)]
  if (alF && alF !== nome) nome = alF
  return nome
}

// ===========================================================================================
// 2) classificarGrupos
// Agrupa por l.leitura.entidade (nome JÁ RESOLVIDO pelo chamador) e decide EM ABERTO × CONCILIADO.
// - Ignora quem já saiu por baixa/estorno (baixados/autoConc) e quem é ~zero (|ov|<0.005).
// - Sem nome/ident → "(não identificado)", SEMPRE em aberto.
// - REGRA-CHAVE: um grupo vai para CONCILIADOS só se somar ZERO (|total|<0.005) E todas as
//   linhas estiverem tratadas (l.acerto || jaTratada(l)). Caso contrário → EM ABERTO.
//   (Assim saldo inicial sem par, mesmo confirmado, fica em aberto; nada que não zere concilia.)
// ===========================================================================================
const NAO_IDENT = '(não identificado)'
export function classificarGrupos(lancs, { ov = ovDC, jaTratada = () => false, baixados = new Set(), autoConc = new Set() } = {}) {
  const grupos = new Map()   // nome -> lancs[]
  const jaBaixados = []
  for (const l of (lancs || [])) {
    if (baixados.has(l) || autoConc.has(l)) { jaBaixados.push(l); continue }
    if (Math.abs(ov(l)) < 0.005) continue
    const identificado = !!(l.leitura && l.leitura.ident && String(l.leitura.entidade || '').trim())
    const nome = identificado ? String(l.leitura.entidade).trim() : NAO_IDENT
    if (!grupos.has(nome)) grupos.set(nome, [])
    grupos.get(nome).push(l)
  }
  const emAberto = [], conciliados = []
  for (const [nome, gl] of grupos) {
    const total = gl.reduce((s, l) => s + ov(l), 0)
    const grupo = { nome, lancs: gl, total }
    const unk = nome === NAO_IDENT
    const zerou = Math.abs(total) < 0.005 && gl.length > 0 && gl.every(l => l.acerto || jaTratada(l))
    if (!unk && zerou) conciliados.push(grupo)
    else emAberto.push(grupo)
  }
  return { emAberto, conciliados, jaBaixados }
}

// ===========================================================================================
// 3) aplicarLink
// Simula o LINK/Vincular manual (réplica de vincularLote). Dado os `ids` selecionados
// (que devem somar zero), unifica os nomes num canônico (o mais longo entre os identificados,
// salvo `nomeAlvo` explícito) via aliasForcado (força, sem a trava do "mesmo cliente") e
// devolve quais ids devem ter a correção (ajustado) LIMPA — porque o link é a ação MAIS
// RECENTE e vence uma correção anterior (corrigir-e-depois-linkar passa a funcionar).
// Não muta a entrada; devolve novos objetos.
// ===========================================================================================
export function aplicarLink(lancs, ids, aliasForcado = {}, nomeAlvo = '') {
  const idSet = new Set(ids || [])
  const selecionados = (lancs || []).filter(l => idSet.has(l.id))
  const comNome = selecionados.filter(l => String(l?.leitura?.entidade || '').trim() || l.acerto)
  // Canônico: o digitado; senão o nome identificado MAIS LONGO entre os selecionados.
  let alvo = String(nomeAlvo || '').trim()
  if (!alvo) {
    alvo = comNome
      .map(l => String(l?.leitura?.entidade || '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || ''
  }
  const kAlvo = chaveNome(alvo)
  const novoAliasForcado = { ...aliasForcado }
  const correcoesLimpas = []
  for (const l of comNome) {
    const nome = String(l?.leitura?.entidade || '').trim()
    const k = chaveNome(nome)
    if (k && k !== kAlvo) {
      novoAliasForcado[k] = alvo                       // força o vínculo para os próximos meses
      if (l?.leitura?.ajustado) correcoesLimpas.push(l.id)  // link vence correção anterior
    }
  }
  return { aliasForcado: novoAliasForcado, correcoesLimpas, canonical: alvo }
}
