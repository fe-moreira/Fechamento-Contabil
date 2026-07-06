import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { apurarDistribuicao } from '../lib/distribuicao'
import { apurarBancoResultado } from '../lib/bancoResultado'
import { apurarVariacoes } from '../lib/variacoes'
import { theme, money } from '../lib/theme'
import { abrePdfTimbrado } from '../lib/pdf'
import { gerarExcelTimbrado } from '../lib/excel'
import { gerarDominioCSV } from '../lib/dominio'
import CampoConta from '../components/CampoConta'

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
  const { empresaId, empresaNome, competencia, getCompetenciaId, plano } = useAppData()
  const { user } = useAuth()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))
  const contaInfo = c => { const p = planoMap[String(c)]; return { cod: String(c), classif: p?.classif || '', nome: p?.nome || '' } }

  const [compId, setCompId] = useState(null)
  const [status, setStatus] = useState(null) // 'andamento' | 'fechado' | 'pendente'
  const [dados, setDados] = useState(null)    // { temRazao, docsPendentes:[], contasAbertas:[] }
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null)        // gate aberto (painel de itens)
  const [modal, setModal] = useState(null)    // { item, tipo } modal de texto
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [verDominio, setVerDominio] = useState(false) // modal com os lançamentos p/ o Domínio

  async function carregar() {
    setSel(null); setMsg('')
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)

    const { data: cli } = await supabase.from('clientes')
      .select('carga_saldos, carga_inicial_feita').eq('id', empresaId).maybeSingle()
    const cargaInicialPendente = !!(cli?.carga_saldos && !cli?.carga_inicial_feita)

    const [mes, ano] = competencia.split('/').map(Number)
    const { data: comp } = await supabase.from('competencias')
      .select('id, status, documentos, integracoes')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()

    let temRazao = false, docsPendentes = [], contasAbertas = [], integracoes = {}, observacoes = [], lancamentos = []
    if (comp) {
      setCompId(comp.id); setStatus(comp.status || 'andamento')
      const { count: razaoCount } = await supabase.from('razao')
        .select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
      const { data: balancete } = await supabase.from('balancete')
        .select('conta, saldo_final').eq('competencia_id', comp.id)
      const { data: obs } = await supabase.from('auditoria')
        .select('modulo, item, detalhe, created_at').eq('competencia_id', comp.id)
        .eq('tipo', 'Justificativa').order('created_at', { ascending: false })
      const { data: lancs } = await supabase.from('lancamentos')
        .select('id, data, conta_debito, conta_credito, valor, historico, origem').eq('competencia_id', comp.id).order('data')
      const docs = Array.isArray(comp.documentos) ? comp.documentos : []
      temRazao = (razaoCount || 0) > 0
      docsPendentes = docs.filter(d => d && d.rec === false)
      contasAbertas = (balancete || []).filter(b => Math.abs(Number(b.saldo_final)) > 0.005)
      integracoes = comp.integracoes || {}
      observacoes = obs || []
      lancamentos = lancs || []
    } else {
      setCompId(null); setStatus(null)
    }

    const dist = await apurarDistribuicao(empresaId, comp?.id)
    const br = await apurarBancoResultado(empresaId, comp?.id)
    const variacoes = await apurarVariacoes(empresaId)

    setDados({ temRazao, docsPendentes, contasAbertas, cargaInicialPendente, dist, br, variacoes, integracoes, observacoes, lancamentos })
    setCarregando(false)
  }

  useEffect(() => {
    setCompId(null); setStatus(null); setDados(null); setSel(null)
    carregar()
  }, [empresaId, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!empresaId) {
    return <Wrapper><Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." /></Wrapper>
  }
  if (carregando) {
    return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  }
  if (!dados) {
    return <Wrapper nome={empresaNome} comp={competencia}><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
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
      descricao: 'Contas do balancete com saldo final em aberto (≠ 0).',
      itens: dados.contasAbertas.map(c => ({
        item: `Conta ${c.conta} · saldo ${money(c.saldo_final)}`,
        detalhe: `Saldo final ${money(c.saldo_final)} em aberto.`,
      })),
    },
    {
      key: 'variacoes',
      nome: 'Variações sem justificativa',
      icon: 'ti-arrows-diff',
      descricao: 'Contas com variação acima de 10% da média ainda não justificadas (Comp. Movimento).',
      itens: (dados.variacoes?.itens || []).map(v => ({
        item: `${v.conta}${v.nome ? ' · ' + v.nome : ''} · ${MESES[v.mes - 1]} · ${money(v.valor)}`,
        detalhe: 'Variação acima de 10% da média do ano. Justifique ou corrija no Comp. Movimento.',
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
        return {
          item: `${l.banco} → ${l.resultado} · ${money(l.valor)}`,
          sub: `Banco: ${[b.classif, b.nome].filter(Boolean).join(' · ') || '—'}  →  Resultado: ${[r.classif, r.nome].filter(Boolean).join(' · ') || '—'}`,
          detalhe: `${l.historico}${l.despesa ? ' — despesa: classificar dedutível/indedutível (LALUR)' : ''}`,
          lalur: l.despesa,
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
      itens: INTEGRACOES.filter(ig => !dados.integracoes?.[ig.key]?.estado).map(ig => ({
        item: `Integração ${ig.nome} não validada`,
        detalhe: 'Nenhum documento importado. Importe em Integração ou marque “Não tem movimento”.',
        integracao: ig.key,
      })),
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

  // Gates informativos (observações) não bloqueiam o encerramento.
  const totalPendencias = gates.filter(g => !g.informativo).reduce((s, g) => s + g.itens.length, 0)
  const pronto = totalPendencias === 0
  const fechado = status === 'fechado'

  async function encerrar() {
    setSalvando(true)
    const { error } = await supabase.from('competencias').update({ status: 'fechado' }).eq('id', compId)
    setSalvando(false)
    if (!error) { setStatus('fechado'); setMsg('Fechamento encerrado.') }
  }
  async function reabrir() {
    setSalvando(true)
    const { error } = await supabase.from('competencias').update({ status: 'andamento' }).eq('id', compId)
    setSalvando(false)
    if (!error) { setStatus('andamento'); setMsg('Fechamento reaberto.') }
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

  async function registrar(item, tipo, detalhe, dedutibilidade) {
    const id = await getCompetenciaId()
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item, tipo, detalhe, dedutibilidade: dedutibilidade || null, usuario: user?.email,
    })
    setMsg(`${tipo} registrada na auditoria.`)
    setModal(null)
  }

  // Corrigir banco × resultado: grava a partida de acerto (vai para o Contabilizar) + auditoria.
  async function registrarPartida(itemTxt, L) {
    const id = await getCompetenciaId()
    await supabase.from('lancamentos').insert({
      competencia_id: id, data: L.data || null,
      conta_debito: L.conta_debito || null, conta_credito: L.conta_credito || null,
      valor: Number(L.valor) || 0, historico: L.historico || null,
      origem: 'correcao', usuario: user?.email,
    })
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item: itemTxt, tipo: 'Correção',
      detalhe: `Reclassificação banco × resultado: D ${L.conta_debito} / C ${L.conta_credito} · ${money(L.valor)}`,
      dedutibilidade: L.dedutibilidade || null, usuario: user?.email,
    })
    setMsg('Correção registrada — lançamento enviado para o painel Contabilizar.')
    setModal(null); carregar()
  }

  // Exporta os itens de um gate em Excel ou PDF (papel timbrado).
  async function exportarGate(gate, fmt) {
    const linhas = gate.itens.map(it => [it.item, it.sub || '', it.detalhe || ''])
    const tituloRel = `${gate.nome} — ${empresaNome} · ${competencia}`
    if (fmt === 'excel') {
      await gerarExcelTimbrado({
        titulo: tituloRel, sub: `${gate.itens.length} pendência(s)`,
        colunas: [{ nome: 'Item', largura: 30 }, { nome: 'Contas', largura: 50 }, { nome: 'Detalhe', largura: 60, wrap: true }],
        linhas, totais: null, arquivo: `${gate.key}_${competencia.replace('/', '-')}.xlsx`, aba: 'Pendências',
      })
    } else {
      abrePdfTimbrado({
        titulo: tituloRel, sub: `${gate.itens.length} pendência(s)`,
        colunas: [{ nome: 'Item' }, { nome: 'Contas' }, { nome: 'Detalhe' }],
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
            <button className="btn" disabled={salvando || !pronto} onClick={encerrar}
              style={{ opacity: pronto ? 1 : 0.5, cursor: pronto ? 'pointer' : 'not-allowed' }}>
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" disabled={!dados.lancamentos.length} style={{ fontSize: 13 }} onClick={() => { setVerDominio(true); setMsg('') }}><i className="ti ti-list-details" /> Ver lançamentos</button>
          <button className="btn" disabled={!dados.lancamentos.length || !pronto}
            style={{ fontSize: 13, opacity: (dados.lancamentos.length && pronto) ? 1 : 0.5, cursor: (dados.lancamentos.length && pronto) ? 'pointer' : 'not-allowed' }}
            title={!pronto ? 'Resolva todas as pendências para gerar o arquivo' : 'Gerar o CSV de importação do Domínio'}
            onClick={() => { if (pronto && dados.lancamentos.length) gerarDominioCSV(dados.lancamentos, `dominio_${competencia.replace('/', '-')}.csv`) }}>
            <i className="ti ti-download" /> Gerar arquivo
          </button>
        </div>
      </div>

      {/* Gates */}
      <div style={{ display: 'grid', gap: 12 }}>
        {gates.map(g => {
          const n = g.itens.length
          const info = g.informativo
          const pend = !info && n > 0
          const cor = info ? (n > 0 ? theme.accent : theme.sub) : (pend ? theme.red : theme.green)
          const clicavel = n > 0 && !g.emBreve
          return (
            <div key={g.key}
              onClick={clicavel ? () => { setSel(g); setMsg('') } : undefined}
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
      {sel && (
        <PainelGate
          gate={sel}
          onExportar={(fmt) => exportarGate(sel, fmt)}
          onClose={() => setSel(null)}
          onJustificar={(it) => setModal({ item: it, tipo: 'Justificativa' })}
          onCorrigir={(it) => setModal({ item: it, tipo: it.partida ? 'Partida' : 'Correção' })}
          onSemMovimento={(key) => marcarSemMovimento(key)}
        />
      )}

      {/* Modal de texto (justificar / corrigir simples) */}
      {modal && modal.tipo !== 'Partida' && (
        <ModalRegistro
          tipo={modal.tipo}
          alvo={modal.item.item}
          lalur={modal.item.lalur}
          onClose={() => setModal(null)}
          onConfirmar={(txt, dedut) => registrar(modal.item.item, modal.tipo, txt, dedut)}
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
          pronto={pronto}
          totalPendencias={totalPendencias}
          onGerar={() => gerarDominioCSV(dados.lancamentos, `dominio_${competencia.replace('/', '-')}.csv`)}
          onClose={() => setVerDominio(false)}
        />
      )}
    </Wrapper>
  )
}

// Lista os lançamentos que a plataforma já gerou (estornos/correções) — para o
// usuário acompanhar — e permite gerar o arquivo do Domínio só quando pronto.
function ModalLancamentosDominio({ lancamentos, planoMap, pronto, totalPendencias, onGerar, onClose }) {
  const nomeConta = c => { const p = planoMap[String(c)]; return `${c || '—'}${p?.nome ? ' · ' + p.nome : ''}` }
  const origemLabel = { correcao: 'Correção/Estorno', sugestao: 'Sugestão', documento: 'Documento', manual: 'Manual' }
  const total = lancamentos.reduce((s, l) => s + (Number(l.valor) || 0), 0)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(760px,96vw)', maxHeight: '88vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 17, margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><i className="ti ti-file-download" style={{ color: theme.accent }} /> Lançamentos para o Domínio</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20, lineHeight: 1 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 14px' }}>
          {lancamentos.length} lançamento(s) gerado(s) pela plataforma nesta competência (débito, crédito e histórico). Ao importar no Domínio, entram na contabilidade.
        </p>

        <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr style={{ background: theme.input }}>
                <th style={th}>Data</th><th style={th}>Débito</th><th style={th}>Crédito</th>
                <th style={{ ...th, textAlign: 'right' }}>Valor</th><th style={th}>Histórico</th><th style={th}>Origem</th>
              </tr>
            </thead>
            <tbody>
              {lancamentos.map(l => (
                <tr key={l.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...td, color: theme.sub, fontSize: 11.5, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
                  <td style={{ ...td, fontSize: 12 }}>{nomeConta(l.conta_debito)}</td>
                  <td style={{ ...td, fontSize: 12 }}>{nomeConta(l.conta_credito)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{money(l.valor)}</td>
                  <td style={{ ...td, color: theme.sub, fontSize: 11.5, maxWidth: 240 }}>{l.historico}</td>
                  <td style={{ ...td, fontSize: 11.5 }}><span style={{ color: theme.accent }}>{origemLabel[l.origem] || l.origem || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ textAlign: 'right', fontSize: 12.5, color: theme.sub, margin: '8px 2px 0' }}>Total: <b style={{ color: theme.text }}>{money(total)}</b></p>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
          <p style={{ fontSize: 12, color: pronto ? theme.green : theme.yellow, margin: 0 }}>
            {pronto
              ? <><i className="ti ti-circle-check" /> Sem pendências — geração liberada.</>
              : <><i className="ti ti-lock" /> {totalPendencias} pendência(s) em aberto — resolva para liberar a geração.</>}
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
  )
}

function PainelGate({ gate, onClose, onJustificar, onCorrigir, onSemMovimento, onExportar }) {
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
            {gate.itens.length} {gate.informativo ? 'observação(ões)' : 'pendência(s)'}. {legenda}
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
            <div key={i} style={{ background: theme.input, borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{it.item}</p>
                {it.sub && <p style={{ fontSize: 11.5, color: theme.accent, margin: '3px 0 0' }}>{it.sub}</p>}
                <p style={{ fontSize: 12, color: theme.sub, margin: '3px 0 0' }}>{it.detalhe}</p>
              </div>
              {gate.informativo ? null : it.integracao ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" style={{ fontSize: 13 }} onClick={() => onSemMovimento(it.integracao)}><i className="ti ti-circle-minus" /> Não tem movimento</button>
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

function ModalRegistro({ tipo, alvo, lalur, onClose, onConfirmar }) {
  const [txt, setTxt] = useState('')
  const [dedut, setDedut] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          <b style={{ color: theme.text }}>{alvo}</b><br />
          Fica registrada na auditoria com seu usuário e a data.
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
          placeholder={tipo === 'Correção' ? 'O que foi corrigido…' : 'Por que esta pendência pode ser liberada…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && (!lalur || dedut) && onConfirmar(txt.trim(), dedut || null)}>Registrar</button>
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
