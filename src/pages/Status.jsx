import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { apurarDistribuicao } from '../lib/distribuicao'
import { apurarBancoResultado } from '../lib/bancoResultado'
import { apurarVariacoes } from '../lib/variacoes'
import { contasConciliacaoAbertas, conferirBalanceteEncerramento, erroContaSintetica } from '../lib/balancete'
import { theme, money } from '../lib/theme'
import InfoTela from '../components/InfoTela'
import { abrePdfTimbrado } from '../lib/pdf'
import { gerarExcelTimbrado } from '../lib/excel'
import { gerarDominioCSV } from '../lib/dominio'
import { anexarArquivoContrato } from '../lib/outras'
import CampoConta from '../components/CampoConta'
import RateioCC from '../components/RateioCC'
import { carregarResolverCC, lancamentoExigeCC, rateioValido } from '../lib/centroCusto'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '9px 12px', fontSize: 13, color: theme.text, verticalAlign: 'top' }
const INTEGRACOES = [
  { key: 'fiscal', nome: 'Fiscal' },
  { key: 'folha', nome: 'Folha' },
  { key: 'patrimonio', nome: 'Patrimônio' },
  { key: 'financeira', nome: 'Financeira' },
]

export default function Status() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, plano, empresas, refreshStatusCompetencia } = useAppData()
  const { user } = useAuth()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))
  const contaInfo = c => { const p = planoMap[String(c)]; return { cod: String(c), classif: p?.classif || '', nome: p?.nome || '' } }
  // Cliente usa centro de custo? (Metroform usa.) Carrega os centros cadastrados para o
  // rateio obrigatório ao editar um lançamento de conta de resultado.
  const usaCC = !!(empresas || []).find(e => e.id === empresaId)?.usa_centro_custo
  const [centrosCC, setCentrosCC] = useState([])
  useEffect(() => {
    if (!empresaId || !usaCC) { setCentrosCC([]); return }
    carregarResolverCC(empresaId).then(r => setCentrosCC(r.centros || [])).catch(() => setCentrosCC([]))
  }, [empresaId, usaCC])

  const [compId, setCompId] = useState(null)
  const [status, setStatus] = useState(null) // 'andamento' | 'fechado' | 'pendente'
  const [dados, setDados] = useState(null)    // { temRazao, docsPendentes:[], contasAbertas:[] }
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null)        // gate aberto (painel de itens)
  const [modal, setModal] = useState(null)    // { item, tipo } modal de texto
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [verDominio, setVerDominio] = useState(false) // modal com os lançamentos p/ o Domínio
  const [editLanc, setEditLanc] = useState(null)      // lançamento em edição (modal)
  const [balConf, setBalConf] = useState(null)        // conferência do balancete importado (encerramento)
  const [balBusy, setBalBusy] = useState(false)
  const progressoRef = useRef(null)                   // % de progresso calculado no render (persiste em competencias.pct)

  async function carregar(silent) {
    setMsg('') // NÃO fecha o painel (sel) — ao justificar/corrigir, recarrega e mantém aberto atualizado
    if (!empresaId) { setCarregando(false); return }
    if (!silent) setCarregando(true) // recarga silenciosa (após justificar) não pisca a tela toda

    const { data: cli } = await supabase.from('clientes')
      .select('carga_saldos, carga_inicial_feita, integracao_financeira').eq('id', empresaId).maybeSingle()
    const cargaInicialPendente = !!(cli?.carga_saldos && !cli?.carga_inicial_feita)
    const integracaoFin = cli?.integracao_financeira || 'Não usa'

    // Contas bancárias cadastradas (uma importação por banco na Integração Financeira).
    const { data: bc } = await supabase.from('cargas_cadastro')
      .select('dados').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    const contasBancarias = Array.isArray(bc?.dados) ? bc.dados : []

    // Contratos (seguro / despesa a apropriar) — para cobrar o documento anexado.
    const [{ data: seg }, { data: dsp }] = await Promise.all([
      supabase.from('seguros').select('id, seguradora, apolice, arquivo, vigencia_inicio, vigencia_fim').eq('cliente_id', empresaId),
      supabase.from('despesas_apropriar').select('id, tipo, descricao, arquivo, vigencia_inicio, vigencia_fim').eq('cliente_id', empresaId),
    ])
    const contratos = [
      ...(seg || []).map(r => ({ tabela: 'seguros', id: r.id, label: `Seguro ${r.seguradora || ''}${r.apolice ? ' · apólice ' + r.apolice : ''}`.trim(), arquivo: r.arquivo, vi: r.vigencia_inicio, vf: r.vigencia_fim })),
      ...(dsp || []).map(r => ({ tabela: 'despesas_apropriar', id: r.id, label: `${r.tipo || 'Despesa a apropriar'}${r.descricao ? ' · ' + r.descricao : ''}`.trim(), arquivo: r.arquivo, vi: r.vigencia_inicio, vf: r.vigencia_fim })),
    ]

    const [mes, ano] = competencia.split('/').map(Number)
    const { data: comp } = await supabase.from('competencias')
      .select('id, status, documentos, integracoes')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()

    let temRazao = false, docsPendentes = [], contasAbertas = [], integracoes = {}, observacoes = [], lancamentos = [], contratosJust = new Set()
    if (comp) {
      setCompId(comp.id); setStatus(comp.status || 'andamento')
      const { count: razaoCount } = await supabase.from('razao')
        .select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
      const { data: obs } = await supabase.from('auditoria')
        .select('modulo, item, detalhe, created_at').eq('competencia_id', comp.id)
        .eq('tipo', 'Justificativa').order('created_at', { ascending: false })
      const { data: lancs } = await supabase.from('lancamentos')
        .select('*').eq('competencia_id', comp.id).order('data') // '*' p/ trazer o `rateio` (CC) e reabrir o lançamento com o centro já preenchido
      const docs = Array.isArray(comp.documentos) ? comp.documentos : []
      temRazao = (razaoCount || 0) > 0
      // Só documento indeciso (pendente) bloqueia. "Não tem" e "Não enviou" não
      // bloqueiam o Status (o "não enviou" vai para o relatório de pendências).
      docsPendentes = docs.filter(d => { const s = d?.situacao ?? (d?.rec ? 'recebido' : ''); return s === '' })

      // Conciliação: pendente = conta Ativo/Passivo ainda VERMELHA (fonte única, igual
      // ao badge do menu — os números batem).
      contasAbertas = await contasConciliacaoAbertas(empresaId, comp.id)
      integracoes = comp.integracoes || {}
      // Restaura a conferência do balancete guardada nesta competência (persiste na tela).
      if (integracoes.balanceteConf) setBalConf(integracoes.balanceteConf)
      observacoes = obs || []
      lancamentos = lancs || []
      // Contratos já tratados nesta competência (documento justificado / pendência).
      const { data: audC } = await supabase.from('auditoria').select('item')
        .eq('competencia_id', comp.id).eq('modulo', 'Contratos')
      contratosJust = new Set((audC || []).map(a => a.item))
    } else {
      setCompId(null); setStatus(null)
    }

    const dist = await apurarDistribuicao(empresaId, comp?.id)
    const br = await apurarBancoResultado(empresaId, comp?.id)
    const variacoes = await apurarVariacoes(empresaId)

    setDados({ temRazao, docsPendentes, contasAbertas, cargaInicialPendente, integracaoFin, contasBancarias, dist, br, variacoes, integracoes, observacoes, lancamentos, contratos, contratosJust })
    setCarregando(false)
  }

  useEffect(() => {
    setCompId(null); setStatus(null); setDados(null); setSel(null); setBalConf(null)
    carregar()
  }, [empresaId, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  // Persiste o % de progresso (calculado no render, a partir dos gates) em competencias.pct,
  // para o card da lista de Fechamentos refletir o andamento. Roda sempre que os dados
  // recarregam (após justificar/corrigir) — o render já atualizou progressoRef antes do efeito.
  useEffect(() => {
    if (!compId) return
    if (status === 'fechado') return // competência fechada é somente leitura — não grava pct
    const p = progressoRef.current
    if (p == null) return
    // IMPORTANTE: o builder do supabase-js é lazy — sem await/then a requisição NÃO é
    // enviada. Precisa disparar de fato para gravar o pct.
    ;(async () => { await supabase.from('competencias').update({ pct: p }).eq('id', compId).then(() => {}, () => {}) })()
  }, [compId, dados, status])

  if (!empresaId) {
    return <Wrapper><Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." /></Wrapper>
  }
  if (carregando) {
    return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  }
  if (!dados) {
    return <Wrapper nome={empresaNome} comp={competencia}><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  }

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')

  // Integração Financeira: cliente por Excel valida um extrato por banco (ou uma
  // planilha combinada que cobre todos). Enquanto um banco não for importado nem
  // marcado "sem movimento" na Integração, ele fica pendente aqui no Status.
  function itensFinanceira() {
    const fin = dados.integracoes?.financeira || {}
    if (dados.integracaoFin !== 'Excel') {
      return fin.estado ? [] : [{
        item: 'Integração Financeira não validada',
        detalhe: 'Nenhum documento importado. Importe em Integração ou marque “Não tem movimento”.',
        integracao: 'financeira',
      }]
    }
    if (fin.combinado?.estado === 'validado') return []
    const contas = dados.contasBancarias || []
    if (!contas.length) return [{
      item: 'Integração Financeira — cadastre as contas bancárias',
      detalhe: 'Cadastre os bancos do cliente na Integração Financeira para liberar a importação dos extratos.',
      finPendente: true,
    }]
    // Resolvido só quando concluído (validado) ou sem movimento. Rascunho (em
    // andamento) continua pendente até concluir.
    // A chave dos bancos é o conta_contabil SEM espaços (é como a Integração grava/consulta).
    // Sem o .trim(), um espaço à direita fazia um banco JÁ CONCLUÍDO aparecer como pendente.
    // E o "concluído" é o flag `concluido` (é o que a Integração usa para pintar de verde) —
    // não só estado==='validado' (que pode ter virado 'rascunho' num salvamento posterior).
    const regBanco = c => fin.bancos?.[String(c.conta_contabil).trim()]
    const resolvido = c => { const b = regBanco(c); return !!b && (b.concluido === true || b.estado === 'validado' || b.estado === 'sem_movimento') }
    return contas
      .filter(c => !resolvido(c))
      .map(c => {
        const e = regBanco(c)?.estado
        return {
          item: `Integração Financeira — ${nomeBanco(c.conta_contabil)} ${e === 'rascunho' ? 'em andamento' : 'pendente'}`,
          detalhe: e === 'rascunho'
            ? 'Extrato importado, mas ainda não concluído. Finalize a classificação e clique em “Concluir banco”.'
            : 'Extrato ainda não importado. Importe o extrato ou marque “Não houve movimentação” na Integração Financeira.',
          finPendente: true,
        }
      })
  }

  // Contratos (seguro/despesa) ativos na competência e SEM documento anexado, que
  // ainda não foram justificados neste mês. Pede importar o documento ou justificar.
  function itensContratos() {
    const [m, a] = competencia.split('/').map(Number)
    const ini = `${a}-${String(m).padStart(2, '0')}-01`, fim = `${a}-${String(m).padStart(2, '0')}-31`
    const ativo = c => !(c.vi && c.vi > fim) && !(c.vf && c.vf < ini)
    return (dados.contratos || [])
      .filter(c => ativo(c) && !c.arquivo && !dados.contratosJust?.has(`${c.label} — documento`))
      .map(c => ({
        item: `${c.label} — documento`,
        detalhe: 'Anexe o documento (apólice/carnê) ou justifique. "Cliente não enviou" vai ao relatório de pendências.',
        contratoDoc: { tabela: c.tabela, id: c.id },
      }))
  }
  // Anexa o documento do contrato direto do Status → zera a pendência.
  async function importarContratoDoc(it, file) {
    if (!file) return
    try { await anexarArquivoContrato(it.contratoDoc.tabela, it.contratoDoc.id, file); setMsg('Documento anexado.'); carregar() }
    catch (e) { setMsg('Erro ao anexar: ' + e.message) }
  }
  // Justifica a falta do documento. "Cliente não enviou" → relatório de pendências.
  async function registrarContrato(it, txt, pendCliente) {
    const id = await getCompetenciaId()
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Contratos', item: it.item,
      tipo: pendCliente ? 'Pendência' : 'Justificativa', detalhe: txt, usuario: user?.email,
    })
    setMsg(pendCliente ? 'Registrado como pendência do cliente (relatório de pendências).' : 'Justificativa registrada.')
    setModal(null); carregar()
  }

  const gates = [
    {
      key: 'cargainicial',
      nome: 'Carga inicial de saldos',
      icon: 'ti-cloud-upload',
      descricao: 'Saldo de abertura lançado (empresas que não são novas).',
      itens: dados.cargaInicialPendente
        ? [{ item: 'Carga inicial de saldos pendente', detalhe: 'Lance o saldo de abertura em Base de Informações → Período de início (ou marque a empresa como nova).' }]
        : [],
    },
    {
      key: 'razao',
      nome: 'Razão importado',
      icon: 'ti-file-import',
      descricao: 'Razão do Domínio importado para a competência.',
      itens: dados.temRazao ? [] : [{ item: 'Razão não importado nesta competência', detalhe: 'Nenhum lançamento encontrado na tabela razao.' }],
    },
    {
      key: 'documentos',
      nome: 'Documentos',
      icon: 'ti-files',
      descricao: 'Documentos pendentes de recebimento/conferência.',
      itens: dados.docsPendentes.map(d => ({
        item: `Documento: ${d.name || '(sem nome)'}`,
        detalhe: 'Documento ainda não recebido/conferido.',
      })),
    },
    {
      key: 'conciliacao',
      nome: 'Conciliação',
      icon: 'ti-arrows-left-right',
      descricao: 'Contas Ativo/Passivo ainda em vermelho na conciliação (sem documento que bate nem justificativa).',
      itens: dados.contasAbertas.map(c => ({
        item: `Conta ${c.conta} · saldo ${money(c.saldo_final)}`,
        detalhe: `Saldo ${money(c.saldo_final)} ainda não conciliado — importe o documento e confira, ou justifique na Conciliação.`,
      })),
    },
    {
      key: 'variacoes',
      nome: 'Variações sem justificativa',
      icon: 'ti-arrows-diff',
      descricao: 'Contas com variação acima de 10% em relação ao mês anterior, ainda não justificadas (Comp. Movimento).',
      // Uma linha por CONTA (não por lançamento): é a conta que distorce; o culpado
      // exato o usuário confere no Comp. Movimento. Os meses afetados vão no detalhe.
      itens: Object.values((dados.variacoes?.itens || []).reduce((acc, v) => {
        const k = String(v.conta)
        if (!acc[k]) acc[k] = { conta: v.conta, nome: v.nome, meses: [] }
        if (!acc[k].meses.includes(v.mes)) acc[k].meses.push(v.mes)
        return acc
      }, {})).map(g => ({
        item: `${g.conta}${g.nome ? ' · ' + g.nome : ''}`,
        detalhe: `Variação acima de 10% do mês anterior em ${g.meses.sort((a, b) => a - b).map(m => MESES[m - 1]).join(', ')}. Justifique ou corrija no Comp. Movimento.`,
      })),
    },
    {
      key: 'banco',
      nome: 'Lançamentos banco × resultado',
      icon: 'ti-building-bank',
      descricao: dados.br?.temCarga
        ? 'Banco lançado direto em conta de resultado não liberada.'
        : 'Importe a amarração banco × resultado em Base de Informações.',
      itens: (dados.br?.lancamentos || []).map(l => {
        const b = contaInfo(l.banco), r = contaInfo(l.resultado)
        const nomeB = b.nome || `Conta ${l.banco}`, nomeR = r.nome || `Conta ${l.resultado}`
        // Direção da partida: mostra quem debitou e quem creditou (pode ser o inverso).
        const dc = l.bancoDeb ? `D ${nomeB} · C ${nomeR}` : `D ${nomeR} · C ${nomeB}`
        return {
          item: `${l.banco} → ${l.resultado} · ${money(l.valor)}`,
          sub: `Banco: ${[b.classif, b.nome].filter(Boolean).join(' · ') || '—'}  →  Resultado: ${[r.classif, r.nome].filter(Boolean).join(' · ') || '—'}`,
          detalhe: `${l.historico} · ${dc}${l.despesa ? ' — classificar dedutível/indedutível (LALUR)' : ''}`,
          lalur: l.despesa,
          tratado: !!l.tratado, pendenciaCliente: !!l.pendenciaCliente,
          justDetalhe: l.justDetalhe || '', justDedut: l.justDedut || '',
          partida: { data: l.data || '', valor: l.valor, banco: l.banco, resultado: l.resultado, bancoNome: b.nome, resultadoNome: r.nome, historico: l.historico, despesa: l.despesa },
        }
      }),
    },
    {
      key: 'distribuicao',
      nome: 'Distribuição de lucros · IRRF 2026',
      icon: 'ti-cash',
      descricao: dados.dist?.temConfig
        ? 'Sócios que ultrapassaram o limite mensal (retenção de IRRF).'
        : 'Configure limite, alíquota e sócios em Base de Informações.',
      itens: (dados.dist?.socios || []).filter(s => s.excede).map(s => ({
        item: `${s.nome} · recebeu ${money(s.total)}`,
        detalhe: `Acima do limite (${money(dados.dist.limite)}). IRRF estimado ${money(s.irrf)} — ${dados.dist.aliquota}% do total recebido no mês.`,
      })),
    },
    {
      key: 'integracoes',
      nome: 'Integrações validadas',
      icon: 'ti-plug-connected',
      descricao: 'Fiscal, Folha, Patrimônio e Financeira: documento importado ou marcado sem movimento.',
      itens: [
        // Verde só quando bate (estado 'validado') ou sem movimento. Importado mas ainda
        // com diferença (estado 'andamento') aponta a pendência de conferência.
        ...INTEGRACOES.filter(ig => ig.key !== 'financeira')
          .filter(ig => { const e = dados.integracoes?.[ig.key]?.estado; return e !== 'validado' && e !== 'sem_movimento' })
          .map(ig => {
            const reg = dados.integracoes?.[ig.key] || {}
            const emConf = reg.estado === 'andamento'
            const dif = Number(reg.dif) || 0
            const difTxt = dif > 0.005 ? ` de ${money(dif)}` : ''
            return {
              item: `Integração ${ig.nome} ${emConf ? `com diferença${difTxt} (não bateu)` : 'não validada'}`,
              detalhe: emConf
                ? `Documento importado, mas ainda há diferença${difTxt} — confira na Integração ${ig.nome}. Resolva as pendências até bater, ou clique em Justificar para aceitar a diferença (fica verde e libera o fechamento).`
                : 'Nenhum documento importado. Importe em Integração ou marque “Não tem movimento”.',
              integracao: ig.key,
              integImportada: emConf, // importada, com diferença → oferece Justificar
            }
          }),
        ...itensFinanceira(),
      ],
    },
    {
      key: 'contratos',
      nome: 'Documentos de contratos',
      icon: 'ti-paperclip',
      descricao: 'Seguros e despesas a apropriar sem o documento anexado.',
      itens: itensContratos(),
    },
    {
      key: 'observacoes',
      nome: 'Observações e justificativas',
      icon: 'ti-message-circle',
      descricao: 'Observações registradas no fechamento (visibilidade — não bloqueiam o encerramento).',
      informativo: true,
      itens: (dados.observacoes || []).map(o => ({
        item: o.item || o.modulo || 'Observação',
        sub: o.modulo,
        detalhe: o.detalhe || '',
      })),
    },
  ]

  // Pendências restantes de um gate = itens ainda não tratados (justificados/corrigidos
  // continuam na lista, mas saem da contagem). Gates informativos não contam.
  const pendDe = g => g.informativo ? 0 : g.itens.filter(it => !it.tratado).length
  // Gates informativos (observações) não bloqueiam o encerramento.
  const totalPendencias = gates.filter(g => !g.informativo).reduce((s, g) => s + pendDe(g), 0)
  const pronto = totalPendencias === 0
  const fechado = status === 'fechado'
  // Progresso = fração dos gates bloqueantes já resolvidos (sem pendência). Fechado = 100%.
  // É gravado em competencias.pct (efeito acima) para o card da lista de Fechamentos.
  const gatesBloqueantes = gates.filter(g => !g.informativo)
  const gatesFeitos = gatesBloqueantes.filter(g => pendDe(g) === 0).length
  const progresso = fechado ? 100 : (gatesBloqueantes.length ? Math.round((gatesFeitos / gatesBloqueantes.length) * 100) : 0)
  progressoRef.current = progresso
  const selGate = sel ? gates.find(g => g.key === sel) : null

  async function encerrar() {
    setSalvando(true)
    const { error } = await supabase.from('competencias').update({ status: 'fechado' }).eq('id', compId)
    setSalvando(false)
    if (!error) { setStatus('fechado'); setMsg('Fechamento encerrado.'); refreshStatusCompetencia && refreshStatusCompetencia() }
  }
  async function reabrir() {
    setSalvando(true)
    const { error } = await supabase.from('competencias').update({ status: 'andamento' }).eq('id', compId)
    setSalvando(false)
    if (!error) { setStatus('andamento'); setMsg('Fechamento reaberto.'); setBalConf(null); refreshStatusCompetencia && refreshStatusCompetencia() }
  }

  // Importa o balancete (exportado do Domínio) e confere se BATE com a conciliação —
  // conta a conta, pelo código reduzido OU pela classificação. Só com tudo batendo
  // o "Encerrar fechamento" é liberado.
  // Lê um balancete em PDF (texto extraído) → [{ cod, classif, saldo }]. Heurística para o
  // balancete do Domínio: cada linha de conta tem um código (reduzido e/ou classificação) e,
  // no fim, o SALDO ATUAL (último valor monetário) com o indicador D/C. Pula cabeçalhos/totais.
  function linhasBalancetePdf(texto) {
    const val = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g
    const parseBR = s => { const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return Number.isNaN(n) ? null : n }
    const out = []
    for (const raw of String(texto || '').split(/\r?\n/)) {
      const linha = raw.trim(); if (!linha) continue
      const nums = linha.match(val); if (!nums || !nums.length) continue  // linha de conta tem valor
      const mClass = linha.match(/\b(\d(?:\.\d+){2,})\b/)          // classificação pontuada (>=3 níveis)
      const mCod = linha.match(/^\s*(\d{1,6})(?!\.)\b/)            // reduzido no início (NÃO parte de um código pontuado)
      const classif = mClass ? mClass[1] : ''
      const cod = mCod ? mCod[1] : ''
      // Precisa ter um CÓDIGO de conta (reduzido ou classificação) — assim cabeçalhos, rodapés
      // (Folha:, Página, Empresa…) e colunas não entram. NÃO filtra por palavra-chave: nomes de
      // conta podem conter "FOLHA", "DÉBITO", "CRÉDITO" etc. (ex.: "IRRF S/ FOLHA A RECOLHER").
      if (!cod && !classif) continue
      const low = linha.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      if (/^(total|subtotal|soma)\b/.test(low)) continue           // linhas de total/subtotal
      const mDC = linha.match(/([DC])\s*$/i)
      let saldo = parseBR(nums[nums.length - 1]); if (saldo == null) continue
      if (mDC && /c/i.test(mDC[1])) saldo = -Math.abs(saldo)
      // Nome = texto entre o código e o 1º valor (para casar por NOME quando o código não bate).
      const firstNum = linha.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/)
      const nome = linha.slice(0, firstNum ? firstNum.index : linha.length).replace(/^[\s.\d]+/, '').replace(/\s+/g, ' ').trim()
      out.push({ cod, classif, saldo, nome })
    }
    return out
  }

  // Guarda a conferência do balancete NA COMPETÊNCIA para PERSISTIR na tela: o analista
  // importa, vê onde não bate, corrige e volta — o resultado (e o arquivo) continua aqui,
  // sem precisar reimportar toda hora. Reimportar atualiza.
  async function persistBalConf(conf) {
    if (!compId) return
    try {
      const { data } = await supabase.from('competencias').select('integracoes').eq('id', compId).maybeSingle()
      const atual = (data?.integracoes && typeof data.integracoes === 'object') ? data.integracoes : {}
      const slim = conf ? { bate: conf.bate, verificados: conf.verificados, nome: conf.nome, path: conf.path || null, quando: conf.quando, divergencias: (conf.divergencias || []).slice(0, 200) } : null
      await supabase.from('competencias').update({ integracoes: { ...atual, balanceteConf: slim } }).eq('id', compId)
    } catch { /* silencioso — a persistência é um conforto, não bloqueia a conferência */ }
  }

  async function importarBalancete(file) {
    if (!file || !compId) return
    setBalBusy(true); setMsg('')
    try {
      let importado
      // PDF: lê o texto e reconhece as linhas de conta (código + saldo atual).
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const { extrairTextoPdf } = await import('../lib/pdfText')
        importado = linhasBalancetePdf(await extrairTextoPdf(file))
        if (importado.length < 2) { setMsg('Li o PDF, mas não reconheci as linhas do balancete (formato diferente). Tente o Excel, ou me mande o arquivo para eu ajustar a leitura.'); setBalBusy(false); return }
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
        let h = 0
        for (let i = 0; i < Math.min(arr.length, 30); i++) { if ((arr[i] || []).filter(c => String(c ?? '').trim()).length >= 3) { h = i; break } }
        const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        const header = (arr[h] || []).map(norm)
        const col = re => header.findIndex(x => re.test(x))
        const cCod = col(/reduz|^cod|codigo|^conta/)
        const cClass = col(/classif/)
        const cNome = col(/descri|nome|conta/)
        let cSaldo = col(/saldo.*(atual|final)/); if (cSaldo < 0) cSaldo = col(/saldo/)
        const cDC = col(/^d\/?c$|natureza|deb.*cred/)
        if (cSaldo < 0 || (cCod < 0 && cClass < 0)) { setMsg('Não identifiquei as colunas do balancete (preciso de Código ou Classificação e o Saldo). Confira o arquivo.'); setBalBusy(false); return }
        const parseNum = v => { if (typeof v === 'number') return v; let s = String(v ?? '').replace(/[R$\s]/g, ''); if (!s) return null; s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s; const n = parseFloat(s); return Number.isNaN(n) ? null : n }
        importado = []
        for (const r of arr.slice(h + 1)) {
          let saldo = parseNum(r[cSaldo]); if (saldo == null) continue
          if (cDC >= 0 && /c/i.test(String(r[cDC] ?? ''))) saldo = -Math.abs(saldo)
          const cod = cCod >= 0 ? String(r[cCod] ?? '').trim() : ''
          const classif = cClass >= 0 ? String(r[cClass] ?? '').trim() : ''
          const nome = (cNome >= 0 && cNome !== cCod && cNome !== cClass) ? String(r[cNome] ?? '').trim() : ''
          if (!cod && !classif && !nome) continue
          importado.push({ cod, classif, saldo, nome })
        }
      }
      const res = await conferirBalanceteEncerramento(empresaId, compId, importado)
      // Guarda o ARQUIVO importado (mesmo padrão da carga de saldos iniciais: dá para extrair depois).
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
      const path = `balancete/${compId}/balancete${ext}`
      try { await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined }) } catch { /* segue mesmo sem guardar o arquivo */ }
      const conf = { ...res, nome: file.name, path, quando: new Date().toISOString() }
      setBalConf(conf); await persistBalConf(conf)
      setMsg(res.bate ? 'Balancete confere com a conciliação — pode encerrar.' : `Balancete não bate: ${res.divergencias.length} conta(s) divergente(s).`)
    } catch (e) { setMsg('Não consegui ler o balancete: ' + e.message) }
    setBalBusy(false)
  }

  // Extrai (baixa) o ARQUIVO do balancete que foi importado — igual ao "extrair" das cargas.
  async function extrairBalancete() {
    const path = balConf?.path
    if (!path) { setMsg('Não há arquivo guardado — reimporte o balancete para poder extrair.'); return }
    try {
      const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300, { download: balConf.nome || 'balancete' })
      if (error) throw error
      window.open(data.signedUrl, '_blank')
    } catch (e) { setMsg('Não consegui extrair o arquivo: ' + (e.message || e)) }
  }

  // "Não tem movimento": marca a integração como sem movimento → zera a pendência.
  async function marcarSemMovimento(key) {
    const id = await getCompetenciaId()
    const { data: comp } = await supabase.from('competencias').select('integracoes').eq('id', id).maybeSingle()
    const novo = { ...(comp?.integracoes || {}), [key]: { estado: 'sem_movimento', usuario: user?.email || null } }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    const nome = (INTEGRACOES.find(i => i.key === key) || {}).nome || key
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Integração', item: `Integração ${nome}`, tipo: 'Justificativa',
      detalhe: 'Sem movimento no período.', usuario: user?.email,
    })
    setMsg(`Integração ${nome} marcada como “sem movimento”.`)
    carregar()
  }

  // "Justificar" a diferença de uma integração (Fiscal/Folha) importada mas que ainda não
  // bateu: o responsável ACEITA a diferença → a integração fica VERDE (validado) e libera o
  // fechamento. Guarda a justificativa no estado (justAceita) e registra usuário e data.
  async function justificarIntegracao(key) {
    const nome = (INTEGRACOES.find(i => i.key === key) || {}).nome || key
    const texto = window.prompt(`Justificar a diferença da Integração ${nome} (ela fica verde e libera o fechamento).\n\nDescreva o porquê da diferença:`)
    if (texto == null) return
    if (!texto.trim()) { setMsg('Escreva o motivo para justificar.'); return }
    const id = await getCompetenciaId()
    const { data: comp } = await supabase.from('competencias').select('integracoes').eq('id', id).maybeSingle()
    const integ = (comp?.integracoes && typeof comp.integracoes === 'object') ? comp.integracoes : {}
    const atual = (integ[key] && typeof integ[key] === 'object') ? integ[key] : {}
    const novo = { ...integ, [key]: { ...atual, estado: 'validado', justAceita: true, justificativa: texto.trim(), justUsuario: user?.email || null } }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Integração', item: `Integração ${nome}`, tipo: 'Justificativa',
      detalhe: `Diferença aceita/justificada: ${texto.trim()}`, usuario: user?.email,
    })
    setMsg(`Integração ${nome} justificada — ficou verde e liberou o fechamento.`)
    carregar()
  }

  async function registrar(item, tipo, detalhe, dedutibilidade, pend) {
    const id = await getCompetenciaId()
    // Justificativa ÚNICA por item: substitui a anterior (reabrir e mudar atualiza, não acumula).
    await supabase.from('auditoria').delete().eq('competencia_id', id).eq('modulo', 'Status').eq('item', item)
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item, tipo, detalhe, dedutibilidade: dedutibilidade || null, usuario: user?.email,
    })
    // "Pendência do cliente": além de justificar, registra a pendência (mesmo padrão dos
    // contratos) para subir no Relatório de Pendências do cliente.
    if (pend) await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item, tipo: 'Pendência', detalhe: detalhe || 'Pendência do cliente', usuario: user?.email,
    })
    setModal(null)
    await carregar(true) // recarrega e mantém o painel aberto → item aparece como Justificado e sai da contagem
    setMsg(`${tipo} registrada${pend ? ' · pendência do cliente enviada ao relatório' : ''}.`)
  }

  // Salva a correção de UM campo em vários lançamentos — cada um com o SEU valor (mapa
  // { id: valor }). Assim dá para aplicar o MESMO valor a todos (em massa) ou valores
  // diferentes por linha (individual). `campo`: 'rateio' (CC — só conta de resultado; valor =
  // código do centro), 'conta_debito', 'conta_credito' ou 'historico'.
  async function aplicarLoteMap(campo, editsMap) {
    let n = 0, pulouCC = 0
    for (const id of Object.keys(editsMap || {})) {
      const l = (dados?.lancamentos || []).find(x => x.id === id); if (!l) continue
      const valor = editsMap[id]
      let patch = null
      if (campo === 'rateio') {
        if (!lancamentoExigeCC(plano, usaCC, l.conta_debito, l.conta_credito)) { pulouCC++; continue } // CC só em conta de resultado
        const cod = String(valor || '').trim()
        patch = cod ? { rateio: [{ cod, nome: ((centrosCC || []).find(c => String(c.cod) === cod)?.nome) || cod, valor: Number(l.valor) || 0 }] } : { rateio: null }
      } else if (campo === 'conta_debito' || campo === 'conta_credito') {
        const v = String(valor || '').trim(); if (!v) continue // conta em branco não zera
        patch = { [campo]: v }
      } else if (campo === 'historico') patch = { historico: String(valor ?? '').trim() || null }
      if (!patch) continue
      const { error } = await supabase.from('lancamentos').update({ ...patch, usuario: user?.email }).eq('id', id)
      if (error) { setMsg('Erro ao salvar: ' + error.message); return }
      n++
    }
    await carregar()
    setMsg(`Alteração salva em ${n} lançamento(s).${pulouCC ? ` (${pulouCC} sem centro — não são conta de resultado)` : ''}`)
  }

  // Desfaz (remove) um lançamento gerado pela plataforma — sai do arquivo do Domínio.
  async function desfazerLancamento(id) {
    if (!window.confirm('Desfazer este lançamento? Ele será removido e não entra no arquivo do Domínio.')) return
    const { error } = await supabase.from('lancamentos').delete().eq('id', id)
    if (error) { setMsg('Erro ao desfazer: ' + error.message); return }
    await carregar(); setMsg('Lançamento desfeito.')
  }

  // Edita um lançamento gerado pela plataforma (data, débito, crédito, valor, histórico).
  // Retorna uma mensagem de erro (string) para o modal mostrar, ou null em caso de sucesso.
  async function salvarEdicaoLancamento(campos) {
    // Conta de resultado + cliente usa CC → o centro de custo (rateio) é obrigatório.
    const exige = lancamentoExigeCC(plano, usaCC, campos.conta_debito, campos.conta_credito)
    if (exige && !rateioValido(campos.rateio, campos.valor)) {
      return 'Informe o centro de custo — a soma do rateio precisa bater com o valor do lançamento.'
    }
    const { error } = await supabase.from('lancamentos').update({
      data: campos.data || null, conta_debito: campos.conta_debito || null, conta_credito: campos.conta_credito || null,
      valor: Number(campos.valor) || 0, historico: campos.historico || null, usuario: user?.email,
      // Só toca a coluna `rateio` quando há CC obrigatório — edições comuns não dependem dela.
      ...(exige ? { rateio: campos.rateio || null } : {}),
    }).eq('id', editLanc.id)
    if (error) {
      // Coluna ainda não criada no Supabase → mensagem clara em vez de erro cru.
      if (/rateio/i.test(error.message) && /column|coluna|schema/i.test(error.message)) {
        return 'A coluna de centro de custo ainda não existe no banco. Rode no Supabase: alter table public.lancamentos add column if not exists rateio jsonb;'
      }
      return 'Erro ao editar: ' + error.message
    }
    await carregar(); setMsg('Lançamento editado.'); return null // o modal mostra "Salvo!" e fecha
  }

  // Corrigir banco × resultado: grava a partida de acerto (vai para o Contabilizar) + auditoria.
  async function registrarPartida(itemTxt, L) {
    const eSint = erroContaSintetica(plano, L.conta_debito, L.conta_credito)
    if (eSint) { setMsg(eSint); return }
    const id = await getCompetenciaId()
    await supabase.from('lancamentos').insert({
      competencia_id: id, data: L.data || null,
      conta_debito: L.conta_debito || null, conta_credito: L.conta_credito || null,
      valor: Number(L.valor) || 0, historico: L.historico || null,
      origem: 'correcao', usuario: user?.email,
    })
    await supabase.from('auditoria').delete().eq('competencia_id', id).eq('modulo', 'Status').eq('item', itemTxt)
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item: itemTxt, tipo: 'Correção',
      detalhe: `Reclassificação banco × resultado: D ${L.conta_debito} / C ${L.conta_credito} · ${money(L.valor)}`,
      dedutibilidade: L.dedutibilidade || null, usuario: user?.email,
    })
    setModal(null); await carregar(true)
    setMsg('Correção registrada — lançamento enviado para o painel Contabilizar.')
  }

  // Exporta os itens de um gate em Excel ou PDF (papel timbrado). Inclui a Situação
  // (Pendente / Justificado / Pendência do cliente) para separar no relatório.
  async function exportarGate(gate, fmt) {
    const situacao = it => it.pendenciaCliente ? 'Pendência do cliente' : it.tratado ? 'Justificado' : 'Pendente'
    const ordem = { Pendente: 0, 'Pendência do cliente': 1, Justificado: 2 }
    const itens = gate.itens.slice().sort((a, b) => ordem[situacao(a)] - ordem[situacao(b)])
    const linhas = itens.map(it => [situacao(it), it.item, it.sub || '', it.detalhe || ''])
    const nPend = gate.itens.filter(it => !it.tratado).length
    const sub = gate.informativo ? `${gate.itens.length} observação(ões)` : `${nPend} pendência(s) · ${gate.itens.filter(it => it.tratado).length} justificado(s)`
    const tituloRel = `${gate.nome} — ${empresaNome} · ${competencia}`
    if (fmt === 'excel') {
      await gerarExcelTimbrado({
        titulo: tituloRel, sub,
        colunas: [{ nome: 'Situação', largura: 20 }, { nome: 'Item', largura: 28 }, { nome: 'Contas', largura: 48 }, { nome: 'Detalhe', largura: 56, wrap: true }],
        linhas, totais: null, arquivo: `${gate.key}_${competencia.replace('/', '-')}.xlsx`, aba: 'Pendências',
      })
    } else {
      abrePdfTimbrado({
        titulo: tituloRel, sub,
        colunas: [{ nome: 'Situação' }, { nome: 'Item' }, { nome: 'Contas' }, { nome: 'Detalhe' }],
        linhas,
      })
    }
  }

  return (
    <Wrapper nome={empresaNome} comp={competencia}>
      {msg && (
        <p style={{ color: theme.green, fontSize: 13, marginBottom: 12 }}><i className="ti ti-circle-check" /> {msg}</p>
      )}

      {/* Banner topo */}
      <div style={{
        background: theme.card,
        border: `0.5px solid ${pronto ? 'rgba(48,164,108,0.4)' : 'rgba(229,72,77,0.4)'}`,
        borderRadius: 12, padding: 22, marginBottom: 18,
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: pronto ? 'rgba(48,164,108,0.14)' : 'rgba(229,72,77,0.14)',
          border: `0.5px solid ${pronto ? 'rgba(48,164,108,0.4)' : 'rgba(229,72,77,0.4)'}`,
        }}>
          <i className={`ti ${pronto ? 'ti-check' : 'ti-alert-triangle'}`} style={{ fontSize: 32, color: pronto ? theme.green : theme.red }} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          {pronto ? (
            <>
              <p style={{ fontSize: 21, fontWeight: 700, color: theme.green, margin: 0 }}>Tudo OK — fechamento liberado</p>
              <p style={{ fontSize: 13, color: theme.sub, margin: '4px 0 0' }}>Nenhuma pendência nos gates desta competência.</p>
            </>
          ) : (
            <>
              <p style={{ fontSize: 21, fontWeight: 700, color: theme.red, margin: 0 }}>
                {totalPendencias} pendência{totalPendencias > 1 ? 's' : ''} para resolver
              </p>
              <p style={{ fontSize: 13, color: theme.sub, margin: '4px 0 0' }}>Resolva os gates em vermelho ou justifique cada item.</p>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {fechado ? (
            <>
              <span style={{
                fontSize: 12, fontWeight: 600, color: theme.green, padding: '8px 12px',
                borderRadius: 8, background: 'rgba(48,164,108,0.12)', border: `0.5px solid rgba(48,164,108,0.4)`,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                <i className="ti ti-lock" /> Fechado
              </span>
              <button className="btn btn-ghost" disabled={salvando} onClick={reabrir}>
                <i className="ti ti-lock-open" /> Reabrir
              </button>
            </>
          ) : (
            <button className="btn" disabled={salvando || !pronto || !balConf?.bate} onClick={encerrar}
              title={!pronto ? 'Resolva as pendências primeiro' : !balConf?.bate ? 'Importe o balancete do Domínio que bate com a conciliação para liberar' : 'Encerrar o fechamento'}
              style={{ opacity: (pronto && balConf?.bate) ? 1 : 0.5, cursor: (pronto && balConf?.bate) ? 'pointer' : 'not-allowed' }}>
              <i className="ti ti-lock-check" /> Encerrar fechamento
            </button>
          )}
        </div>
      </div>

      {/* Arquivo do Domínio: demonstra os lançamentos já gerados pela plataforma;
          só habilita GERAR quando não há pendências. Clicar em "Ver" mostra a lista. */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '16px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ width: 42, height: 42, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(74,124,255,0.12)', border: `0.5px solid ${theme.cb}` }}>
          <i className="ti ti-file-download" style={{ fontSize: 20, color: theme.accent }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 3px' }}>Arquivo para importação no Domínio</p>
          <p style={{ fontSize: 12.5, color: theme.sub, margin: 0 }}>
            {dados.lancamentos.length
              ? <>{dados.lancamentos.length} lançamento(s) gerado(s) pela plataforma (estornos e correções). {pronto ? 'Pronto para gerar.' : 'Resolva as pendências para liberar a geração.'}</>
              : 'Nenhum lançamento gerado ainda nesta competência.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" disabled={!dados.lancamentos.length} style={{ fontSize: 13 }} onClick={() => { setVerDominio(true); setMsg('') }}><i className="ti ti-list-details" /> Ver lançamentos</button>
          <button className="btn" disabled={!dados.lancamentos.length || !pronto}
            style={{ fontSize: 13, opacity: (dados.lancamentos.length && pronto) ? 1 : 0.5, cursor: (dados.lancamentos.length && pronto) ? 'pointer' : 'not-allowed' }}
            title={!pronto ? 'Resolva todas as pendências para gerar o arquivo' : 'Gerar o CSV de importação do Domínio'}
            onClick={() => { if (pronto && dados.lancamentos.length) gerarDominioCSV(dados.lancamentos, `dominio_${competencia.replace('/', '-')}.csv`) }}>
            <i className="ti ti-download" /> Gerar arquivo
          </button>
          <label className="btn btn-ghost" style={{ fontSize: 13, cursor: pronto ? 'pointer' : 'not-allowed', opacity: pronto ? 1 : 0.5 }} title="Importe o balancete exportado do Domínio — aceita Excel (.xlsx/.xls/.csv) OU PDF. Tem que bater com a conciliação para liberar o encerramento; se não bater, mostra em quais contas. Fica guardado (dá para reabrir e extrair).">
            <i className="ti ti-file-import" /> {balBusy ? 'Conferindo…' : 'Importar balancete (Excel/PDF)'}
            <input type="file" accept=".xlsx,.xls,.csv,.pdf" style={{ display: 'none' }} disabled={!pronto || balBusy} onChange={e => importarBalancete(e.target.files?.[0])} />
          </label>
        </div>
      </div>

      {/* Conferência do balancete importado × conciliação (libera o encerramento) */}
      {balConf && (
        <div style={{ background: theme.card, border: `1px solid ${balConf.bate ? theme.green : theme.red}`, borderRadius: 12, padding: '14px 18px', marginBottom: 18 }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8, color: balConf.bate ? theme.green : theme.red }}>
            <i className={`ti ${balConf.bate ? 'ti-circle-check' : 'ti-alert-triangle'}`} />
            {balConf.bate
              ? `Balancete confere com a conciliação (${balConf.verificados} conta(s)). Pode encerrar.`
              : `Balancete NÃO bate com a conciliação — ${balConf.divergencias.length} conta(s) divergente(s). Corrija e reimporte.`}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: theme.sub, fontWeight: 400 }}>
              {balConf.nome}
              {balConf.path && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 9px' }} title="Baixar o arquivo do balancete que foi importado" onClick={extrairBalancete}><i className="ti ti-download" /> Extrair</button>}
            </span>
          </p>
          {balConf.quando && <p style={{ fontSize: 11, color: theme.sub, margin: '4px 0 0' }}>Conferido em {new Date(balConf.quando).toLocaleString('pt-BR')} · fica guardado aqui; reimporte após corrigir para atualizar.</p>}
          {!balConf.bate && balConf.divergencias.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                <thead><tr style={{ background: theme.input }}>
                  <th style={th}>Conta</th><th style={th}>Nome</th><th style={{ ...th, textAlign: 'right' }}>Conciliação</th><th style={{ ...th, textAlign: 'right' }}>Balancete</th><th style={{ ...th, textAlign: 'right' }}>Diferença</th>
                </tr></thead>
                <tbody>
                  {balConf.divergencias.slice(0, 30).map((d, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{d.conta}</td>
                      <td style={td}>{d.nome || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(d.esperado)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{d.importado == null ? <span style={{ color: theme.red }}>não veio</span> : money(d.importado)}</td>
                      <td style={{ ...td, textAlign: 'right', color: theme.red, fontWeight: 600 }}>{money(d.dif)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {balConf.divergencias.length > 30 && <p style={{ fontSize: 11.5, color: theme.sub, margin: '8px 0 0' }}>+{balConf.divergencias.length - 30} conta(s)…</p>}
            </div>
          )}
        </div>
      )}

      {/* Gates */}
      <div style={{ display: 'grid', gap: 12 }}>
        {gates.map(g => {
          const total = g.itens.length
          const info = g.informativo
          const n = info ? total : g.itens.filter(it => !it.tratado).length // pendências restantes
          const pend = !info && n > 0
          const cor = info ? (total > 0 ? theme.accent : theme.sub) : (pend ? theme.red : theme.green)
          const clicavel = total > 0 && !g.emBreve // abre mesmo com tudo tratado (para ver a lista)
          return (
            <div key={g.key}
              onClick={clicavel ? () => { setSel(g.key); setMsg('') } : undefined}
              style={{
                background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12,
                padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 16,
                cursor: clicavel ? 'pointer' : 'default',
              }}>
              <div style={{
                width: 42, height: 42, borderRadius: 10, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: g.emBreve ? 'rgba(255,255,255,0.04)' : info ? 'rgba(74,124,255,0.12)' : (pend ? 'rgba(229,72,77,0.12)' : 'rgba(48,164,108,0.12)'),
                border: `0.5px solid ${theme.cb}`,
              }}>
                <i className={`ti ${g.icon}`} style={{ fontSize: 20, color: g.emBreve ? theme.sub : cor }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {g.nome}
                  {g.emBreve && (
                    <span style={{
                      fontSize: 10.5, fontWeight: 600, color: theme.sub, textTransform: 'uppercase',
                      letterSpacing: .4, padding: '2px 7px', borderRadius: 6,
                      background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${theme.cb}`,
                    }}>
                      em breve
                    </span>
                  )}
                </p>
                <p style={{ fontSize: 12.5, color: theme.sub, margin: 0 }}>{g.descricao}</p>
              </div>

              {!g.emBreve && (
                <span style={{
                  fontSize: 13, fontWeight: 700, minWidth: 30, textAlign: 'center',
                  padding: '5px 12px', borderRadius: 999, color: '#fff',
                  background: cor,
                }}>
                  {n}
                </span>
              )}

              {/* Farol */}
              <span style={{
                display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                background: g.emBreve ? theme.sub : cor, flexShrink: 0,
              }} />

              {clicavel && <i className="ti ti-chevron-right" style={{ color: theme.sub, fontSize: 18 }} />}
            </div>
          )
        })}
      </div>

      {/* Painel de itens do gate selecionado */}
      {selGate && (
        <PainelGate
          gate={selGate}
          onExportar={(fmt) => exportarGate(selGate, fmt)}
          onClose={() => setSel(null)}
          onJustificar={(it) => setModal({ item: it, tipo: 'Justificativa' })}
          onCorrigir={(it) => setModal({ item: it, tipo: it.partida ? 'Partida' : 'Correção' })}
          onSemMovimento={(key) => marcarSemMovimento(key)}
          onJustificarIntegracao={(key) => justificarIntegracao(key)}
          onImportarContrato={importarContratoDoc}
        />
      )}

      {/* Modal de texto (justificar / corrigir simples) */}
      {modal && modal.tipo !== 'Partida' && (
        <ModalRegistro
          tipo={modal.tipo}
          alvo={modal.item.item}
          lalur={modal.item.lalur}
          contrato={!!modal.item.contratoDoc}
          initialTxt={modal.item.justDetalhe || ''}
          initialDedut={modal.item.justDedut || ''}
          initialPend={!!modal.item.pendenciaCliente}
          jaTratado={!!modal.item.tratado}
          onClose={() => setModal(null)}
          onConfirmar={(txt, dedut, pend) => modal.item.contratoDoc ? registrarContrato(modal.item, txt, pend) : registrar(modal.item.item, modal.tipo, txt, dedut, pend)}
        />
      )}

      {/* Corrigir banco × resultado: alterar o lançamento (partida → Contabilizar) */}
      {modal && modal.tipo === 'Partida' && (
        <ModalPartida
          item={modal.item}
          onClose={() => setModal(null)}
          onConfirmar={(L) => registrarPartida(modal.item.item, L)}
        />
      )}

      {/* Lançamentos gerados pela plataforma (acompanhamento) + gerar Domínio */}
      {verDominio && (
        <ModalLancamentosDominio
          lancamentos={dados.lancamentos}
          planoMap={planoMap}
          plano={plano}
          usaCC={usaCC}
          centros={centrosCC}
          pronto={pronto}
          totalPendencias={totalPendencias}
          onGerar={() => gerarDominioCSV(dados.lancamentos, `dominio_${competencia.replace('/', '-')}.csv`)}
          onDesfazer={desfazerLancamento}
          onEditar={l => setEditLanc(l)}
          onAplicarLoteMap={aplicarLoteMap}
          onClose={() => setVerDominio(false)}
        />
      )}

      {editLanc && (
        <ModalEditarLancamento lanc={editLanc} competencia={competencia} plano={plano} usaCC={usaCC} centros={centrosCC} onClose={() => setEditLanc(null)} onSalvar={salvarEdicaoLancamento} />
      )}
    </Wrapper>
  )
}

// Lista os lançamentos que a plataforma já gerou (estornos/correções) — para o
// usuário acompanhar — e permite gerar o arquivo do Domínio só quando pronto.
function ModalLancamentosDominio({ lancamentos, planoMap, plano, usaCC, centros, pronto, totalPendencias, onGerar, onDesfazer, onEditar, onAplicarLoteMap, onClose }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const [campo, setCampo] = useState('')   // '' = seleção; senão = corrigindo este campo (só selecionados na tela)
  const [edits, setEdits] = useState({})   // { id: valor } — cada linha com o seu valor (individual)
  const [preenche, setPreenche] = useState('') // valor do "preencher todos" (em massa)
  const [aplicando, setAplicando] = useState(false)
  const nomeConta = c => { const p = planoMap[String(c)]; return `${c || '—'}${p?.nome ? ' · ' + p.nome : ''}` }
  const origemLabel = { correcao: 'Correção/Estorno', sugestao: 'Sugestão', documento: 'Documento', manual: 'Manual' }
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const termo = norm(q)
  const casa = l => !termo || [l.conta_debito, l.conta_credito, planoMap[String(l.conta_debito)]?.nome, planoMap[String(l.conta_credito)]?.nome, l.historico, String(l.valor), money(l.valor)].some(c => norm(c).includes(termo))
  const nomeCentro = cod => centros?.find(c => String(c.cod) === String(cod))?.nome || cod
  const ehResult = l => lancamentoExigeCC(plano, usaCC, l.conta_debito, l.conta_credito)
  const ccDe = l => (Array.isArray(l.rateio) ? l.rateio.filter(x => x && x.cod) : [])
  const ccCel = l => { const r = ccDe(l); if (r.length) return r.map(x => nomeCentro(x.cod)).join(', '); return ehResult(l) ? <span style={{ color: theme.yellow }}>sem CC</span> : <span style={{ color: theme.sub }}>—</span> }
  const editando = !!campo
  const labelCampo = { conta_debito: 'Conta débito', conta_credito: 'Conta crédito', historico: 'Histórico', rateio: 'Centro de custo' }
  // Fora da edição: lista filtrada pela busca. Na edição: SÓ os selecionados (ignora a busca).
  const listaBusca = lancamentos.filter(casa)
  const listaMostrada = editando ? lancamentos.filter(l => sel.has(l.id)) : listaBusca
  const total = listaMostrada.reduce((s, l) => s + (Number(l.valor) || 0), 0)
  const idsFiltrados = listaBusca.map(l => l.id)
  const todosSel = idsFiltrados.length > 0 && idsFiltrados.every(id => sel.has(id))
  const toggle = id => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleTodos = () => setSel(p => { const n = new Set(p); if (todosSel) idsFiltrados.forEach(id => n.delete(id)); else idsFiltrados.forEach(id => n.add(id)); return n })
  const selResultN = [...sel].filter(id => lancamentos.find(l => l.id === id && ehResult(l))).length
  const valAtual = (l, c) => c === 'conta_debito' ? (l.conta_debito || '') : c === 'conta_credito' ? (l.conta_credito || '') : c === 'historico' ? (l.historico || '') : c === 'rateio' ? (ccDe(l)[0]?.cod || '') : ''
  function entrarEdicao(c) {
    if (!c) { setCampo(''); return }
    const init = {}; for (const id of sel) { const l = lancamentos.find(x => x.id === id); if (l) init[id] = valAtual(l, c) }
    setEdits(init); setPreenche(''); setCampo(c)
  }
  const sairEdicao = () => { setCampo(''); setEdits({}); setPreenche('') }
  const setEdit = (id, v) => setEdits(e => ({ ...e, [id]: v }))
  const preencherTodos = () => { const m = {}; for (const id of sel) m[id] = preenche; setEdits(m) }
  async function salvar() { setAplicando(true); await onAplicarLoteMap(campo, edits); setAplicando(false); sairEdicao(); setSel(new Set()) }
  // Input do campo em edição (usado no "preencher todos" e por linha). disabled = CC em conta não-resultado.
  const inputCampo = (val, onCh, opts = {}) => {
    if (campo === 'rateio') return (
      <select className="input" value={val || ''} onChange={e => onCh(e.target.value)} style={{ fontSize: 12, padding: '4px 6px', ...opts.style }} disabled={opts.disabled}>
        <option value="">{opts.disabled ? 'n/a (não é resultado)' : '— centro —'}</option>
        {(centros || []).map(c => <option key={c.cod} value={c.cod}>{c.cod} · {c.nome || 'sem nome'}</option>)}
      </select>
    )
    if (campo === 'historico') return <input className="input" value={val ?? ''} onChange={e => onCh(e.target.value)} placeholder="histórico…" style={{ fontSize: 12, padding: '4px 6px', ...opts.style }} />
    return <div style={{ minWidth: 130 }}><CampoConta value={val || ''} onChange={onCh} plano={plano} mostrarNome={false} /></div>
  }
  const thS = { ...th, position: 'sticky', top: 0, background: theme.input, zIndex: 2 }
  const cols = 1 + 4 + (usaCC ? 1 : 0) + 2 // sem checkbox: usado no colSpan da linha vazia (edição)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(880px,96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, overflow: 'hidden' }}>
        {/* ---- TOPO FIXO ---- */}
        <div style={{ padding: '20px 24px 12px', borderBottom: `1px solid ${theme.cb}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <h2 style={{ fontSize: 17, margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><i className="ti ti-file-download" style={{ color: theme.accent }} /> Lançamentos para o Domínio</h2>
            <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20, lineHeight: 1 }}><i className="ti ti-x" /></span>
          </div>
          {!editando && <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>{lancamentos.length} lançamento(s) gerado(s) pela plataforma nesta competência. Marque para <b>corrigir em lote</b> (conta, histórico ou centro de custo) — em massa ou um a um.</p>}

          {!editando && (
            <div style={{ position: 'relative', marginBottom: sel.size > 0 ? 10 : 0 }}>
              <i className="ti ti-search" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: theme.sub, fontSize: 15 }} />
              <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por conta (código ou nome), histórico ou valor…" style={{ paddingLeft: 32 }} />
            </div>
          )}

          {/* Passo 1 — selecionar e escolher o que corrigir */}
          {!editando && sel.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: theme.input, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '8px 12px' }}>
              <span style={{ fontSize: 12.5, color: theme.sub, whiteSpace: 'nowrap' }}><b style={{ color: theme.text }}>{sel.size}</b> selecionado(s) · corrigir:</span>
              <select className="input" value="" onChange={e => entrarEdicao(e.target.value)} style={{ width: 180 }}>
                <option value="">o que corrigir?</option>
                {usaCC && <option value="rateio">Centro de custo</option>}
                <option value="conta_debito">Conta débito</option>
                <option value="conta_credito">Conta crédito</option>
                <option value="historico">Histórico</option>
              </select>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setSel(new Set())}>Limpar seleção</button>
            </div>
          )}

          {/* Passo 2 — corrigindo: em massa (preencher todos) ou individual (cada linha) */}
          {editando && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: theme.input, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '8px 12px' }}>
              <span style={{ fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap' }}>Corrigindo <b>{labelCampo[campo]}</b> · {sel.size} lançamento(s)</span>
              <span style={{ fontSize: 12, color: theme.sub }}>em massa:</span>
              <div style={{ flex: 1, minWidth: 150 }}>{inputCampo(preenche, setPreenche)}</div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={preencherTodos}><i className="ti ti-arrow-bar-to-down" /> Preencher todos</button>
              <button className="btn" disabled={aplicando} onClick={salvar}><i className="ti ti-device-floppy" /> {aplicando ? 'Salvando…' : 'Salvar'}</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={sairEdicao}>Cancelar</button>
              {campo === 'rateio' && selResultN < sel.size && <span style={{ fontSize: 11, color: theme.yellow, width: '100%' }}><i className="ti ti-info-circle" /> O centro entra só nas contas de resultado ({selResultN} de {sel.size}); as demais ficam sem alteração.</span>}
              <span style={{ fontSize: 11, color: theme.sub, width: '100%' }}>Dica: edite cada linha na tabela para valores <b>diferentes</b>, ou use <b>Preencher todos</b> para o <b>mesmo</b> valor.</span>
            </div>
          )}
        </div>

        {/* ---- CORPO ROLÁVEL (cabeçalho da tabela congela) ---- */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0 24px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                {!editando && <th style={{ ...thS, width: 30 }}><input type="checkbox" checked={todosSel} onChange={toggleTodos} title="Selecionar todos (do filtro)" disabled={!idsFiltrados.length} /></th>}
                <th style={thS}>Data</th><th style={thS}>Débito</th><th style={thS}>Crédito</th>
                <th style={{ ...thS, textAlign: 'right' }}>Valor</th>{usaCC && <th style={thS}>C. Custo</th>}<th style={thS}>Histórico</th><th style={thS}>Origem</th><th style={thS} />
              </tr>
            </thead>
            <tbody>
              {listaMostrada.map(l => (
                <tr key={l.id} style={{ borderTop: `1px solid ${theme.border}`, background: (!editando && sel.has(l.id)) ? 'rgba(74,124,255,0.08)' : undefined }}>
                  {!editando && <td style={{ ...td, textAlign: 'center' }}><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} /></td>}
                  <td style={{ ...td, color: theme.sub, fontSize: 11.5, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
                  <td style={{ ...td, fontSize: 12 }}>{campo === 'conta_debito' ? inputCampo(edits[l.id], v => setEdit(l.id, v)) : nomeConta(l.conta_debito)}</td>
                  <td style={{ ...td, fontSize: 12 }}>{campo === 'conta_credito' ? inputCampo(edits[l.id], v => setEdit(l.id, v)) : nomeConta(l.conta_credito)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{money(l.valor)}</td>
                  {usaCC && <td style={{ ...td, fontSize: 11.5 }}>{campo === 'rateio' ? inputCampo(edits[l.id], v => setEdit(l.id, v), { disabled: !ehResult(l) }) : ccCel(l)}</td>}
                  <td style={{ ...td, color: theme.sub, fontSize: 11.5, maxWidth: 240 }}>{campo === 'historico' ? inputCampo(edits[l.id], v => setEdit(l.id, v)) : l.historico}</td>
                  <td style={{ ...td, fontSize: 11.5 }}><span style={{ color: theme.accent }}>{origemLabel[l.origem] || l.origem || '—'}</span></td>
                  <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {!editando && onEditar && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px', marginRight: 6 }} onClick={() => onEditar(l)} title="Editar este lançamento"><i className="ti ti-pencil" /> Editar</button>}
                    {!editando && onDesfazer && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px', color: theme.red, borderColor: theme.red }} onClick={() => onDesfazer(l.id)} title="Remover este lançamento"><i className="ti ti-arrow-back-up" /> Desfazer</button>}
                  </td>
                </tr>
              ))}
              {!listaMostrada.length && <tr><td colSpan={editando ? cols : cols + 1} style={{ ...td, textAlign: 'center', color: theme.sub, padding: '18px 12px' }}>Nenhum lançamento {editando ? 'selecionado' : `encontrado para “${q}”`}.</td></tr>}
            </tbody>
          </table>
        </div>

        {/* ---- RODAPÉ FIXO ---- */}
        <div style={{ padding: '10px 24px 18px', borderTop: `1px solid ${theme.cb}`, flexShrink: 0 }}>
          <p style={{ textAlign: 'right', fontSize: 12.5, color: theme.sub, margin: '0 2px 8px' }}>{listaMostrada.length} {editando ? 'selecionado(s)' : `de ${lancamentos.length}`} · Total: <b style={{ color: theme.text }}>{money(total)}</b></p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 12, color: pronto ? theme.green : theme.yellow, margin: 0 }}>
              {pronto ? <><i className="ti ti-circle-check" /> Sem pendências — geração liberada.</> : <><i className="ti ti-lock" /> {totalPendencias} pendência(s) em aberto — resolva para liberar a geração.</>}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
              <button className="btn" disabled={!pronto || !lancamentos.length}
                style={{ opacity: (pronto && lancamentos.length) ? 1 : 0.5, cursor: (pronto && lancamentos.length) ? 'pointer' : 'not-allowed' }}
                title={!pronto ? 'Resolva todas as pendências para gerar o arquivo' : 'Gerar o CSV de importação do Domínio'}
                onClick={() => { if (pronto && lancamentos.length) onGerar() }}>
                <i className="ti ti-download" /> Gerar arquivo
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PainelGate({ gate, onClose, onJustificar, onCorrigir, onSemMovimento, onJustificarIntegracao, onExportar, onImportarContrato }) {
  const legenda = gate.informativo
    ? 'Observações registradas (somente visualização — não bloqueiam o encerramento).'
    : gate.key === 'integracoes'
      ? 'Importe o documento em Integração ou marque “Não tem movimento” para zerar.'
      : 'Justifique ou corrija cada item — fica registrado na auditoria.'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(680px,96vw)', maxHeight: '86vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 17, margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
            <i className={`ti ${gate.icon}`} style={{ color: theme.red }} /> {gate.nome}
          </h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20, lineHeight: 1 }}><i className="ti ti-x" /></span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 16px' }}>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: 0 }}>
            {gate.informativo
              ? `${gate.itens.length} observação(ões).`
              : <>{gate.itens.filter(it => !it.tratado).length} pendência(s){gate.itens.some(it => it.tratado) ? <> · <span style={{ color: theme.green }}>{gate.itens.filter(it => it.tratado).length} justificado(s)</span></> : ''}.</>} {legenda}
          </p>
          {gate.itens.length > 0 && onExportar && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => onExportar('excel')}><i className="ti ti-file-spreadsheet" /> Excel</button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => onExportar('pdf')}><i className="ti ti-file-type-pdf" /> PDF</button>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {gate.itens.map((it, i) => (
            <div key={i} style={{ background: it.tratado ? (it.pendenciaCliente ? 'rgba(245,166,35,0.08)' : 'rgba(48,164,108,0.08)') : theme.input, border: it.tratado ? `1px solid ${it.pendenciaCliente ? 'rgba(245,166,35,0.4)' : 'rgba(48,164,108,0.4)'}` : 'none', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{it.item}</p>
                {it.sub && <p style={{ fontSize: 11.5, color: theme.accent, margin: '3px 0 0' }}>{it.sub}</p>}
                <p style={{ fontSize: 12, color: theme.sub, margin: '3px 0 0' }}>{it.detalhe}</p>
                {it.tratado && (it.justDetalhe || it.justDedut) && (
                  <p style={{ fontSize: 12, color: theme.text, margin: '5px 0 0', background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '5px 8px' }}>
                    <i className="ti ti-message-2" style={{ color: it.pendenciaCliente ? theme.yellow : theme.green }} /> {it.justDetalhe || '(sem texto)'}{it.justDedut ? <b style={{ color: theme.sub }}> · {it.justDedut}</b> : ''}
                  </p>
                )}
              </div>
              {gate.informativo ? null : it.tratado ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: it.pendenciaCliente ? theme.yellow : theme.green, background: it.pendenciaCliente ? 'rgba(245,166,35,0.14)' : 'rgba(48,164,108,0.14)', border: `1px solid ${it.pendenciaCliente ? theme.yellow : theme.green}`, borderRadius: 20, padding: '4px 11px', whiteSpace: 'nowrap' }}>
                    <i className={`ti ${it.pendenciaCliente ? 'ti-flag' : 'ti-circle-check'}`} /> {it.pendenciaCliente ? 'Pendência do cliente' : 'Justificado'}
                  </span>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => onJustificar(it)} title="Rever / alterar a justificativa">editar</button>
                </div>
              ) : it.contratoDoc ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <label className="btn" style={{ fontSize: 13, cursor: 'pointer' }}><i className="ti ti-paperclip" /> Importar
                    <input type="file" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={e => onImportarContrato(it, e.target.files?.[0])} />
                  </label>
                  <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => onJustificar(it)}><i className="ti ti-flag" /> Justificar</button>
                </div>
              ) : it.finPendente ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, color: theme.sub }}>Resolva na Integração Financeira</span>
                  <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => onJustificar(it)}><i className="ti ti-flag" /> Justificar</button>
                </div>
              ) : it.integracao ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  {it.integImportada
                    ? <button className="btn" style={{ fontSize: 13 }} onClick={() => onJustificarIntegracao(it.integracao)} title="Aceitar a diferença (fica verde e libera o fechamento) — registra usuário e data"><i className="ti ti-flag" /> Justificar</button>
                    : <button className="btn" style={{ fontSize: 13 }} onClick={() => onSemMovimento(it.integracao)}><i className="ti ti-circle-minus" /> Não tem movimento</button>}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => onJustificar(it)}><i className="ti ti-flag" /> Justificar</button>
                  <button className="btn" style={{ fontSize: 13 }} onClick={() => onCorrigir(it)}><i className="ti ti-pencil-bolt" /> Corrigir</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

// Editar um lançamento já gerado (arquivo do Domínio). Só permite data dentro da
// competência do fechamento em andamento.
function ModalEditarLancamento({ lanc, competencia, plano, usaCC, centros, onClose, onSalvar }) {
  const [form, setForm] = useState({
    data: lanc.data || '', valor: lanc.valor ?? '',
    conta_debito: lanc.conta_debito || '', conta_credito: lanc.conta_credito || '',
    historico: lanc.historico || '', rateio: lanc.rateio || null,
  })
  const [erroSalvar, setErroSalvar] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [salvo, setSalvo] = useState(false)
  // Ao mexer em qualquer campo depois de salvo, volta a permitir salvar de novo.
  const set = k => v => { setForm(f => ({ ...f, [k]: v })); setSalvo(false); setErroSalvar('') }
  const [mm, yyyy] = String(competencia || '').split('/')
  const dataOk = (() => { const m = /^(\d{4})-(\d{2})/.exec(String(form.data || '')); return !m || !mm || (m[1] === yyyy && m[2] === mm.padStart(2, '0')) })()
  // Conta de resultado (3/4/5) num cliente que usa CC → centro de custo obrigatório.
  const exigeCC = lancamentoExigeCC(plano, usaCC, form.conta_debito, form.conta_credito)
  const ccOk = !exigeCC || rateioValido(form.rateio, form.valor)
  const ok = form.conta_debito && form.conta_credito && Number(form.valor) > 0 && dataOk && ccOk
  async function salvar() {
    setErroSalvar(''); setSalvando(true)
    const e = await onSalvar(form)
    setSalvando(false)
    if (e) { setErroSalvar(e); return } // erro aparece aqui no modal
    setSalvo(true) // fica na tela mostrando "Salvo!" — você fecha quando quiser
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Editar lançamento</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>Ajuste a partida. Só é possível lançar com data dentro de <b style={{ color: theme.text }}>{competencia}</b>. <span style={{ color: theme.accent }}>F4</span> abre o plano de contas.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label>Data</label><input className="input" type="date" value={form.data} onChange={e => set('data')(e.target.value)} style={!dataOk ? { borderColor: theme.red } : undefined} /></div>
          <div><label>Valor</label><input className="input" type="number" step="0.01" value={form.valor} onChange={e => set('valor')(e.target.value)} /></div>
          <div><label>Conta débito</label><CampoConta value={form.conta_debito} onChange={set('conta_debito')} /></div>
          <div><label>Conta crédito</label><CampoConta value={form.conta_credito} onChange={set('conta_credito')} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><textarea className="input" rows={2} value={form.historico} onChange={e => set('historico')(e.target.value)} /></div>
          {exigeCC && <RateioCC valor={form.valor} value={form.rateio} onChange={set('rateio')} centros={centros} />}
        </div>
        {!dataOk && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 10, fontWeight: 600 }}><i className="ti ti-alert-triangle" /> A data precisa ser de {competencia}.</p>}
        {exigeCC && !ccOk && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 10, fontWeight: 600 }}><i className="ti ti-alert-triangle" /> Conta de resultado: informe o centro de custo (a soma do rateio precisa bater com o valor).</p>}
        {erroSalvar && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 10, fontWeight: 600 }}><i className="ti ti-alert-triangle" /> {erroSalvar}</p>}
        {salvo && <p style={{ color: theme.green, fontSize: 13, marginTop: 10, fontWeight: 700 }}><i className="ti ti-circle-check" /> Lançamento salvo! Você pode continuar editando ou fechar.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>{salvo ? 'Fechar' : 'Cancelar'}</button>
          <button className="btn" disabled={!ok || salvando || salvo} onClick={salvar}>{salvo ? 'Salvo ✓' : salvando ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </div>
    </div>
  )
}

// Corrigir banco × resultado: altera o lançamento (partida de acerto) → vai para o Contabilizar.
function ModalPartida({ item, onClose, onConfirmar }) {
  const p = item.partida || {}
  const ehDespesa = !!p.despesa
  const [form, setForm] = useState({
    data: p.data || '', valor: p.valor || 0,
    // Sugestão: estorna o resultado e joga numa conta a definir; o banco permanece no outro lado.
    conta_debito: ehDespesa ? '' : p.banco,
    conta_credito: ehDespesa ? p.banco : '',
    historico: `Reclassificação banco × resultado · ${p.historico || ''}`.trim(),
    dedutibilidade: '',
  })
  const set = k => v => setForm(f => ({ ...f, [k]: v }))
  const ok = form.conta_debito && form.conta_credito && Number(form.valor) > 0 && (!ehDespesa || form.dedutibilidade)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>Corrigir lançamento</h2>
        <div style={{ background: theme.input, borderRadius: 10, padding: '10px 12px', margin: '8px 0 14px', fontSize: 12.5 }}>
          <span style={{ color: theme.text, fontWeight: 600 }}>{item.item}</span>
          <div style={{ color: theme.sub, fontSize: 11.5, marginTop: 3 }}>{item.sub}</div>
          <div style={{ color: theme.sub, fontFamily: 'monospace', fontSize: 11, marginTop: 3 }}>{p.historico}</div>
        </div>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>Informe a <b style={{ color: theme.text }}>partida de acerto</b> — ela vai para o painel <b style={{ color: theme.text }}>Contabilizar</b> e entra no arquivo do Domínio. <span style={{ color: theme.accent }}>F4</span> abre o plano de contas.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label>Data</label><input className="input" type="date" value={form.data} onChange={e => set('data')(e.target.value)} /></div>
          <div><label>Valor</label><input className="input" type="number" step="0.01" value={form.valor} onChange={e => set('valor')(e.target.value)} /></div>
          <div><label>Conta débito</label><CampoConta value={form.conta_debito} onChange={set('conta_debito')} /></div>
          <div><label>Conta crédito</label><CampoConta value={form.conta_credito} onChange={set('conta_credito')} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><textarea className="input" rows={2} value={form.historico} onChange={e => set('historico')(e.target.value)} /></div>
        </div>
        {ehDespesa && (
          <div style={{ marginTop: 12 }}>
            <label>Classificação LALUR (despesa)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['Dedutível', 'Indedutível'].map(op => (
                <button key={op} type="button" className={form.dedutibilidade === op ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => set('dedutibilidade')(op)}>{op}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!ok} onClick={() => onConfirmar(form)}>Registrar</button>
        </div>
      </div>
    </div>
  )
}

function ModalRegistro({ tipo, alvo, lalur, contrato, initialTxt = '', initialDedut = '', initialPend = false, jaTratado = false, onClose, onConfirmar }) {
  const [txt, setTxt] = useState(initialTxt)
  const [dedut, setDedut] = useState(initialDedut)
  const [pend, setPend] = useState(initialPend)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{jaTratado ? `Editar ${tipo.toLowerCase()}` : tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          <b style={{ color: theme.text }}>{alvo}</b><br />
          {jaTratado ? 'Você está vendo o que já foi registrado — altere e salve para sobrepor.' : 'Fica registrada na auditoria com seu usuário e a data.'}
        </p>
        {lalur && (
          <div style={{ marginBottom: 14 }}>
            <label>Classificação LALUR (despesa)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['Dedutível', 'Indedutível'].map(op => (
                <button key={op} type="button" className={dedut === op ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setDedut(op)}>{op}</button>
              ))}
            </div>
          </div>
        )}
        <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus
          placeholder={tipo === 'Correção' ? 'O que foi corrigido…' : contrato ? 'Ex.: aguardando a apólice / cliente não enviou…' : 'Por que esta pendência pode ser liberada…'} />
        {(contrato || tipo === 'Justificativa') && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '12px 0 0', cursor: 'pointer', color: theme.text }}>
            <input type="checkbox" checked={pend} onChange={e => setPend(e.target.checked)} /> {contrato ? 'Cliente não enviou o documento' : 'É pendência do cliente (cobrar)'} — vai ao relatório de pendências
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          {/* Despesa (LALUR) SEMPRE exige dedutível/indedutível — mesmo sendo pendência do
              cliente — porque o indedutível sobe para o LALUR de qualquer forma. */}
          <button className="btn" disabled={!(txt.trim() && (!lalur || dedut))} onClick={() => onConfirmar(txt.trim(), dedut || null, pend)}>Registrar</button>
        </div>
      </div>
    </div>
  )
}

function Wrapper({ children, nome, comp }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 9 }}>
        <i className="ti ti-traffic-lights" style={{ color: theme.accent }} /> Status do fechamento
        <InfoTela titulo="Status do fechamento">O <b>gate</b> do fechamento: só libera quando as pendências zeram — banco × resultado, variações do Comparativo, LALUR e demais travas. Cada item mostra o que falta.</InfoTela>
      </h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        {nome
          ? <>Gates de pendência da competência. <b style={{ color: theme.text }}>{nome}</b> · {comp}.</>
          : 'Gates de pendência da competência. Vermelho com pendências, verde ao zerar.'}
      </p>
      {children}
    </div>
  )
}

function Aviso({ icon = 'ti-building', texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 580 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text, margin: 0 }}>{texto}</p>
    </div>
  )
}
