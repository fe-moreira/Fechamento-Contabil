import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { apurarDistribuicao } from '../lib/distribuicao'
import { theme, money } from '../lib/theme'

export default function Status() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()

  const [compId, setCompId] = useState(null)
  const [status, setStatus] = useState(null) // 'andamento' | 'fechado' | 'pendente'
  const [dados, setDados] = useState(null)    // { temRazao, docsPendentes:[], contasAbertas:[] }
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null)        // gate aberto (painel de itens)
  const [modal, setModal] = useState(null)    // { item, tipo } modal de texto
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)

  async function carregar() {
    setSel(null); setMsg('')
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)

    const { data: cli } = await supabase.from('clientes')
      .select('carga_saldos, carga_inicial_feita').eq('id', empresaId).maybeSingle()
    const cargaInicialPendente = !!(cli?.carga_saldos && !cli?.carga_inicial_feita)

    const [mes, ano] = competencia.split('/').map(Number)
    const { data: comp } = await supabase.from('competencias')
      .select('id, status, documentos')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()

    let temRazao = false, docsPendentes = [], contasAbertas = []
    if (comp) {
      setCompId(comp.id); setStatus(comp.status || 'andamento')
      const { count: razaoCount } = await supabase.from('razao')
        .select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
      const { data: balancete } = await supabase.from('balancete')
        .select('conta, saldo_final').eq('competencia_id', comp.id)
      const docs = Array.isArray(comp.documentos) ? comp.documentos : []
      temRazao = (razaoCount || 0) > 0
      docsPendentes = docs.filter(d => d && d.rec === false)
      contasAbertas = (balancete || []).filter(b => Number(b.saldo_final) !== 0)
    } else {
      setCompId(null); setStatus(null)
    }

    const dist = await apurarDistribuicao(empresaId, comp?.id)

    setDados({ temRazao, docsPendentes, contasAbertas, cargaInicialPendente, dist })
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
    { key: 'variacoes', nome: 'Variações', icon: 'ti-chart-line', descricao: 'Análise de variações entre competências (Comp. Movimento).', itens: [], emBreve: true },
    { key: 'banco', nome: 'Banco × resultado', icon: 'ti-building-bank', descricao: 'Conferência do banco contra o resultado apurado.', itens: [], emBreve: true },
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
  ]

  const totalPendencias = gates.reduce((s, g) => s + g.itens.length, 0)
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

  async function registrar(item, tipo, detalhe) {
    const id = await getCompetenciaId()
    await supabase.from('auditoria').insert({
      competencia_id: id, modulo: 'Status', item, tipo, detalhe, usuario: user?.email,
    })
    setMsg(`${tipo} registrada na auditoria.`)
    setModal(null)
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

      {/* Gates */}
      <div style={{ display: 'grid', gap: 12 }}>
        {gates.map(g => {
          const n = g.itens.length
          const pend = n > 0
          const cor = pend ? theme.red : theme.green
          const clicavel = pend && !g.emBreve
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
                background: g.emBreve ? 'rgba(255,255,255,0.04)' : (pend ? 'rgba(229,72,77,0.12)' : 'rgba(48,164,108,0.12)'),
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
                  background: pend ? theme.red : theme.green,
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
          onClose={() => setSel(null)}
          onJustificar={(it) => setModal({ item: it, tipo: 'Justificativa' })}
          onCorrigir={(it) => setModal({ item: it, tipo: 'Correção' })}
        />
      )}

      {/* Modal de texto */}
      {modal && (
        <ModalRegistro
          tipo={modal.tipo}
          alvo={modal.item.item}
          onClose={() => setModal(null)}
          onConfirmar={(txt) => registrar(modal.item.item, modal.tipo, txt)}
        />
      )}
    </Wrapper>
  )
}

function PainelGate({ gate, onClose, onJustificar, onCorrigir }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px,96vw)', maxHeight: '86vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 17, margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
            <i className={`ti ${gate.icon}`} style={{ color: theme.red }} /> {gate.nome}
          </h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20, lineHeight: 1 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>
          {gate.itens.length} pendência{gate.itens.length > 1 ? 's' : ''}. Justifique ou corrija cada item — fica registrado na auditoria.
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {gate.itens.map((it, i) => (
            <div key={i} style={{ background: theme.input, borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{it.item}</p>
                <p style={{ fontSize: 12, color: theme.sub, margin: '3px 0 0' }}>{it.detalhe}</p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => onJustificar(it)}><i className="ti ti-flag" /> Justificar</button>
                <button className="btn" style={{ fontSize: 13 }} onClick={() => onCorrigir(it)}><i className="ti ti-pencil-bolt" /> Corrigir</button>
              </div>
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

function ModalRegistro({ tipo, alvo, onClose, onConfirmar }) {
  const [txt, setTxt] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          <b style={{ color: theme.text }}>{alvo}</b><br />
          Fica registrada na auditoria com seu usuário e a data.
        </p>
        <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus
          placeholder={tipo === 'Correção' ? 'O que foi corrigido…' : 'Por que esta pendência pode ser liberada…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && onConfirmar(txt.trim())}>Registrar</button>
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
