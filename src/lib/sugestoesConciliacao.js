import { supabase } from './supabase'
import { lerTudo } from './lerTudo'
import { parsePlano, composicaoAbertura } from './balancete'
import { aplicarAjuste, tokensNome, mesmoCliente, ehPorEntidade, nfKey, itensAbertosConta } from './aberturaArrasto'
import { encodePartida } from './sugestoesRazao'

// ============================================================================
// Sugestões a partir da CONCILIAÇÃO de clientes/fornecedores. Duas famílias:
//
//  1) DESCONTO / JUROS — quando um título (NF) casa com o cliente/fornecedor mas
//     o valor não fecha, e a BAIXA veio do BANCO (contrapartida = conta bancária
//     cadastrada na Integração Financeira). A direção decide:
//       · recebeu/pagou MENOS que o título → Desconto
//       · recebeu/pagou MAIS  que o título → Juros
//     REGRA DO BANCO: só trato como pagamento/recebimento o que veio do banco;
//     se a baixa não veio do banco, pode ser outra natureza → não sugiro.
//
//  2) BAIXA DE ADIANTAMENTO — quando o MESMO cliente/fornecedor tem saldo em
//     "adiantamento" E em "a receber/a pagar", compenso o MENOR dos dois
//     (encontro de contas: debita o credor, credita o devedor).
//
// Tudo cai no Painel de Sugestões (auditoria tipo 'Sugestão') com a partida já
// montada — a plataforma NÃO lança nada; só sugere. Confirmar vira lançamento.
// ============================================================================

const dig = v => String(v ?? '').replace(/\D/g, '')
const baixa = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const fmt = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })

function dataFimMes(competencia) {
  const [m, a] = String(competencia || '').split('/').map(Number)
  if (!m || !a) return ''
  return `${a}-${String(m).padStart(2, '0')}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`
}

// É conta de adiantamento? (nome contém "adiant")
const ehAdiantamento = nome => /adiantament/.test(baixa(nome))

// Carrega os lançamentos (abertura + razão do mês, com leitura) de uma conta de composição.
async function lancComposicao(empresaId, compId, conta) {
  const abertura = await composicaoAbertura(empresaId, compId, conta.cod, conta.classifRaw, conta.nome)
  const [rz, { data: aj }] = await Promise.all([
    lerTudo(() => supabase.from('razao').select('id, data, contrapartida, historico, debito, credito')
      .eq('competencia_id', compId).eq('conta', conta.cod).order('data')),
    supabase.from('ajuste_leitura').select('razao_id, nf, entidade, historico').eq('competencia_id', compId),
  ])
  const ajById = {}; for (const a of (aj || [])) ajById[a.razao_id] = a
  const razaoLanc = (rz || []).map(l => aplicarAjuste(l, ajById[l.id]))
  return [...(abertura || []), ...razaoLanc]
}

// Saldo líquido (D − C) por entidade dos itens em aberto de uma conta.
async function saldoPorEntidade(empresaId, compId, conta) {
  const abertura = await composicaoAbertura(empresaId, compId, conta.cod, conta.classifRaw, conta.nome)
  const itens = await itensAbertosConta(compId, conta.cod, conta.nome, conta.classifRaw, abertura)
  const map = {}
  for (const l of itens) {
    const e = l.leitura?.entidade || ''
    if (!e) continue
    map[e] = (map[e] || 0) + (Number(l.debito) || 0) - (Number(l.credito) || 0)
  }
  return Object.entries(map).map(([entidade, saldo]) => ({ entidade, tokens: tokensNome(entidade), saldo }))
}

export async function gerarSugestoesConciliacao(clienteId, competenciaId, competencia, usuario) {
  const zero = { descontos: 0, juros: 0, adiantamentos: 0 }
  if (!clienteId || !competenciaId || !competencia) return zero

  // Plano (para achar conta de desconto/juros por nome) e contas bancárias.
  const [{ data: planoCarga }, { data: bancoCarga }, { data: jaSug }] = await Promise.all([
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', clienteId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', clienteId).eq('tipo', 'contas_bancarias')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('auditoria').select('item').eq('competencia_id', competenciaId).like('tipo', 'Sugest%'),
  ])
  const plano = parsePlano(planoCarga?.dados)
  const bancos = new Set((Array.isArray(bancoCarga?.dados) ? bancoCarga.dados : []).map(b => dig(b.conta_contabil)).filter(Boolean))
  const itensExist = new Set((jaSug || []).map(s => s.item))
  const achaConta = re => plano.find(p => p.reduzido && !p.sintetica && re.test(baixa(p.nome)))?.reduzido || ''
  // Conta da diferença conforme a natureza: cliente (grupo 1, recebimento) vs fornecedor
  // (grupo 2, pagamento). Tenta a específica (concedido/obtido, recebido/pago) e cai na genérica.
  const contaDiferenca = (desconto, grupo) => {
    if (desconto) return (grupo === '1' ? achaConta(/desconto.*conced|conced.*desconto/) : achaConta(/desconto.*obtid|obtid.*desconto/)) || achaConta(/desconto/)
    return (grupo === '1' ? achaConta(/juros.*receb|receb.*juros|juros.*ativ/) : achaConta(/juros.*pag|juros.*passiv|encargo|multa/)) || achaConta(/juros|encargo|multa/)
  }

  // Contas de composição por entidade (cliente/fornecedor/adiantamento), analíticas, patrimoniais.
  const contas = plano
    .filter(p => p.reduzido && !p.sintetica && ehPorEntidade(p.nome))
    .map(p => ({ cod: String(p.reduzido), nome: p.nome || '', classifRaw: String(p.classif || ''), grupo: String(p.classif || '').trim()[0] }))
    .filter(c => c.grupo === '1' || c.grupo === '2')

  const novas = []
  const data = dataFimMes(competencia)

  // ---- 1) DESCONTO / JUROS (só contas de título: cliente/fornecedor, NÃO adiantamento) ----
  const contasTitulo = contas.filter(c => !ehAdiantamento(c.nome))
  for (const conta of contasTitulo) {
    let lanc
    try { lanc = await lancComposicao(clienteId, competenciaId, conta) } catch { continue }
    // Agrupa por NF.
    const porNF = {}
    for (const l of lanc) { const k = nfKey(l.leitura?.nf); if (k) (porNF[k] = porNF[k] || []).push(l) }
    for (const k in porNF) {
      const grp = porNF[k]
      const temD = grp.some(l => Number(l.debito) > 0.005)
      const temC = grp.some(l => Number(l.credito) > 0.005)
      if (!temD || !temC) continue // precisa de título e baixa
      const residuo = grp.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
      if (Math.abs(residuo) < 0.005) continue // fechou: já baixado, sem diferença
      // Cliente/fornecedor tem que bater entre os lançamentos da NF.
      const nomes = [...new Set(grp.map(l => (l.leitura?.ident && l.leitura.entidade) ? l.leitura.entidade : null).filter(Boolean))]
      let mesmo = true
      for (let i = 1; i < nomes.length; i++) if (!mesmoCliente(tokensNome(nomes[0]), tokensNome(nomes[i]))) { mesmo = false; break }
      if (!mesmo) continue
      // REGRA DO BANCO: a perna de BAIXA (oposta ao título) tem que ter contrapartida
      // numa conta bancária. Ativo(1): baixa = crédito. Passivo(2): baixa = débito.
      const baixaLegs = conta.grupo === '1' ? grp.filter(l => Number(l.credito) > 0.005) : grp.filter(l => Number(l.debito) > 0.005)
      const veioDoBanco = baixaLegs.some(l => l.contrapartida && bancos.has(dig(l.contrapartida)))
      if (!veioDoBanco) continue
      // Direção: desconto se sobrou saldo na natureza normal (recebeu/pagou menos); senão juros.
      const desconto = (conta.grupo === '1' && residuo > 0) || (conta.grupo === '2' && residuo < 0)
      const contraConta = contaDiferenca(desconto, conta.grupo)
      if (!contraConta) continue // sem conta no plano → não sugiro (evita partida inválida)
      const v = Math.abs(residuo)
      const creditaConta = residuo > 0 // resíduo > 0: conta ainda devedora → credita para zerar
      const conta_credito = creditaConta ? conta.cod : contraConta
      const conta_debito = creditaConta ? contraConta : conta.cod
      const nomeCli = nomes[0] || ''
      const item = `Diferença · ${conta.cod} · NF ${k} · ${desconto ? 'desconto' : 'juros'}`
      if (itensExist.has(item)) continue
      itensExist.add(item)
      const humano = `${desconto ? 'Desconto' : 'Juros'} · ${conta.nome}${nomeCli ? ' · ' + nomeCli : ''} · NF ${grp.find(l => l.leitura?.nf)?.leitura?.nf || k} · ${fmt(v)}`
      novas.push({
        competencia_id: competenciaId, modulo: desconto ? 'Desconto' : 'Juros', item, tipo: 'Sugestão', usuario,
        detalhe: encodePartida(humano, { conta_debito, conta_credito, valor: v, data }),
      })
    }
  }
  const nDesc = novas.filter(n => n.modulo === 'Desconto').length
  const nJur = novas.filter(n => n.modulo === 'Juros').length

  // ---- 2) BAIXA DE ADIANTAMENTO (compensa o menor entre adiantamento × a receber/a pagar) ----
  const adiantamentos = contas.filter(c => ehAdiantamento(c.nome))
  for (const adi of adiantamentos) {
    // Contrapartida: adiantamento de CLIENTE (passivo) ↔ contas a RECEBER (ativo);
    // adiantamento a FORNECEDOR (ativo) ↔ contas a PAGAR (passivo). Casa pelo grupo oposto.
    const grupoContra = adi.grupo === '1' ? '2' : '1'
    const contrapartes = contasTitulo.filter(c => c.grupo === grupoContra)
    if (!contrapartes.length) continue
    let entsAdi
    try { entsAdi = await saldoPorEntidade(clienteId, competenciaId, adi) } catch { continue }
    const comSaldo = entsAdi.filter(e => Math.abs(e.saldo) > 0.005)
    if (!comSaldo.length) continue
    for (const parte of contrapartes) {
      let entsParte
      try { entsParte = await saldoPorEntidade(clienteId, competenciaId, parte) } catch { continue }
      for (const a of comSaldo) {
        for (const c of entsParte) {
          if (Math.abs(c.saldo) < 0.005) continue
          if (!mesmoCliente(a.tokens, c.tokens)) continue
          if (a.saldo * c.saldo >= 0) continue // mesmo sinal → não há o que compensar
          const v = Math.min(Math.abs(a.saldo), Math.abs(c.saldo))
          if (v < 0.005) continue
          // Debita o credor (saldo < 0), credita o devedor (saldo > 0).
          const adiCredor = a.saldo < 0
          const conta_debito = adiCredor ? adi.cod : parte.cod
          const conta_credito = adiCredor ? parte.cod : adi.cod
          const item = `Adiantamento · ${adi.cod}×${parte.cod} · ${a.entidade}`
          if (itensExist.has(item)) continue
          itensExist.add(item)
          const humano = `Baixa de adiantamento · ${a.entidade} · ${adi.nome} × ${parte.nome} · ${fmt(v)}`
          novas.push({
            competencia_id: competenciaId, modulo: 'Adiantamento', item, tipo: 'Sugestão', usuario,
            detalhe: encodePartida(humano, { conta_debito, conta_credito, valor: v, data }),
          })
        }
      }
    }
  }
  const nAdi = novas.filter(n => n.modulo === 'Adiantamento').length

  if (novas.length) {
    for (let i = 0; i < novas.length; i += 200) await supabase.from('auditoria').insert(novas.slice(i, i + 200))
  }
  return { descontos: nDesc, juros: nJur, adiantamentos: nAdi }
}
