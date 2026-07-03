import { useEffect, useState } from 'react'
import { theme, money } from '../lib/theme'
import { competenciaIdDe, detectarObservacoes, carregarResolucoes, resolverObservacao, reabrirObservacao } from '../lib/observacoes'
import { gerarLancamento } from '../lib/outras'

function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
const num = v => Number(String(v).replace(/\./g, '').replace(',', '.')) || 0
const ACC = { seguro: '#4A7CFF', importacao: '#2FB6A8', emprestimo: '#9A7CF0', parcelamento: '#E8923B', equivalencia: '#E06C9F' }
const ICON = { seguro: 'ti-shield-half', importacao: 'ti-ship', emprestimo: 'ti-building-bank', parcelamento: 'ti-receipt', equivalencia: 'ti-scale' }
const ROTULO_STATUS = { confirmada: ['✓ confirmado', theme.green], justificada: ['✓ justificado', theme.sub], corrigida: ['✓ corrigido · vira lançamento', '#8FB0FF'], atraso: ['⏰ em atraso', theme.red] }

export default function ObservacoesConciliacao({ clienteId, competencia, user, irPara }) {
  const [compId, setCompId] = useState(null)
  const [cands, setCands] = useState([])
  const [res, setRes] = useState({})
  const [loading, setLoading] = useState(true)
  const [aberto, setAberto] = useState(true)
  const [modal, setModal] = useState(null)

  async function carregar() {
    setLoading(true)
    const id = await competenciaIdDe(clienteId, competencia)
    setCompId(id)
    const [c, r] = await Promise.all([detectarObservacoes(clienteId, id), carregarResolucoes(id)])
    setCands(c); setRes(r); setLoading(false)
  }
  useEffect(() => { if (clienteId) carregar() }, [clienteId, competencia]) // eslint-disable-line

  async function acao(o, status, texto) {
    try { await resolverObservacao({ competencia_id: compId, tipo: o.tipo, conta: o.conta, descricao: o.descricao, status, texto, usuario: user?.email }); await carregar() }
    catch (e) { alert(e.message) }
  }
  async function reabrir(o) { try { await reabrirObservacao(compId, o.tipo); await carregar() } catch (e) { alert(e.message) } }
  async function salvarCorrigir(o, f) {
    try {
      if (compId) await gerarLancamento({ competencia_id: compId, data: f.data || null, conta_debito: f.conta_debito, conta_credito: f.conta_credito, valor: num(f.valor), historico: f.historico, origem: 'correcao', usuario: user?.email })
      await acao(o, 'corrigida', 'reclassificado'); setModal(null)
    } catch (e) { alert(e.message) }
  }

  if (loading) return null
  if (!cands.length) return null
  const pend = cands.filter(o => !res[o.tipo]).length

  return (
    <div style={{ background: theme.card, border: `1px solid ${hexA('#F5A623', 0.4)}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }} onClick={() => setAberto(a => !a)}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-alert-triangle" style={{ color: theme.yellow }} /> Observações da conciliação</p>
          {aberto && <p style={{ color: theme.sub, fontSize: 12.5, margin: '2px 0 0' }}>Contas com movimento no balancete e sem cadastro no bloco. Confirme e suba, corrija (se foi lançamento errado) ou justifique.</p>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ background: hexA('#F5A623', 0.16), color: theme.yellow, fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 20 }}>{pend} pendente{pend === 1 ? '' : 's'}</span>
          <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 13 }} onClick={e => { e.stopPropagation(); setAberto(a => !a) }}><i className={`ti ti-chevron-${aberto ? 'down' : 'left'}`} /></button>
        </div>
      </div>
      {aberto && cands.map(o => {
        const r = res[o.tipo]
        const rot = r && ROTULO_STATUS[r.status]
        return (
          <div key={o.tipo} style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, alignItems: 'center', padding: '12px 2px', borderTop: `1px solid ${theme.border}`, opacity: r ? 0.72 : 1 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexA(ACC[o.tipo], 0.16), color: ACC[o.tipo] }}><i className={`ti ${ICON[o.tipo]}`} /></div>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 13.5 }}>{o.label} — {o.valor ? money(o.valor) : 'movimento'} sem cadastro</b>
              <div style={{ fontSize: 12, color: theme.sub, marginTop: 3 }}><i className="ti ti-search" style={{ color: theme.yellow }} /> {o.descricao}</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {!r ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn" style={{ fontSize: 12, padding: '6px 11px' }} onClick={() => { acao(o, 'confirmada'); irPara(o.tipo) }}>Confirmar e subir</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => setModal({ kind: 'corrigir', o })}>Corrigir</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => setModal({ kind: 'justificar', o })}>Justificar</button>
                </div>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: rot?.[1] || theme.sub }}>{rot?.[0] || r.status}{r.texto && r.status === 'justificada' ? ` · “${String(r.texto).slice(0, 28)}${r.texto.length > 28 ? '…' : ''}”` : ''}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => reabrir(o)}><i className="ti ti-rotate" /> reabrir</button>
                </span>
              )}
            </div>
          </div>
        )
      })}
      {modal && <ObsModal cfg={modal} competencia={competencia} onClose={() => setModal(null)} onJustificar={(txt) => { acao(modal.o, 'justificada', txt); setModal(null) }} onCorrigir={(f) => salvarCorrigir(modal.o, f)} />}
    </div>
  )
}

function ObsModal({ cfg, competencia, onClose, onJustificar, onCorrigir }) {
  const [m, a] = (competencia || '').split('/').map(Number)
  const dataDefault = m && a ? `${a}-${String(m).padStart(2, '0')}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` : ''
  const [txt, setTxt] = useState('')
  const [err, setErr] = useState(false)
  const [f, setF] = useState({ data: dataDefault, conta_debito: '', conta_credito: '', valor: '', historico: `Correção — ${cfg.o.label}` })
  const on = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const justificar = cfg.kind === 'justificar'
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,18,0.64)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, maxWidth: 560, width: '100%', padding: '22px 24px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>{justificar ? 'Justificar observação' : 'Corrigir lançamento'}</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>{cfg.o.label} — {cfg.o.descricao}</p>
        {justificar ? (
          <div><label>Justificativa (obrigatória)</label>
            <textarea className="input" rows={4} value={txt} onChange={e => { setTxt(e.target.value); setErr(false) }} placeholder="Escreva a justificativa…" style={err ? { borderColor: theme.red } : undefined} /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label>Data</label><input className="input" type="date" value={f.data} onChange={on('data')} /></div>
            <div><label>Valor</label><input className="input" value={f.valor} onChange={on('valor')} placeholder="0,00" /></div>
            <div><label>Conta débito</label><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></div>
            <div><label>Conta crédito</label><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><input className="input" value={f.historico} onChange={on('historico')} /></div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          {justificar
            ? <button className="btn" onClick={() => { if (!txt.trim()) { setErr(true); return } onJustificar(txt.trim()) }}>Salvar justificativa</button>
            : <button className="btn" onClick={() => onCorrigir(f)}>Salvar correção</button>}
        </div>
      </div>
    </div>
  )
}
