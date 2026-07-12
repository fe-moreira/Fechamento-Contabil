import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme, money } from '../lib/theme'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { gerarLancamento } from '../lib/outras'
import { decodePartida } from '../lib/sugestoesRazao'

function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
// Aceita "1.234,56" (BR) e "1234.56" (ponto decimal, vindo do input number/partida).
const num = v => { const s = String(v ?? '').trim(); return (s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s)) || 0 }

export default function SugestoesContabilizacao() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [tratadas, setTratadas] = useState(() => new Set())
  const [modal, setModal] = useState(null)
  const [msg, setMsg] = useState('')

  async function carregar() {
    setLoading(true)
    const [mes, ano] = (competencia || '').split('/').map(Number)
    const { data: comp } = await supabase.from('competencias').select('id')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setRows([]); setLoading(false); return }
    // Só sugestões PENDENTES geradas pela plataforma (análise do razão: fiscal,
    // contábil, folha). Correções que o usuário já executou na Conciliação/Status
    // já viraram lançamento e constam no Status → Domínio — não entram aqui (senão
    // confirmar duplicaria o lançamento).
    const { data } = await supabase.from('auditoria').select('id, modulo, item, tipo, detalhe, competencia_id')
      .eq('competencia_id', comp.id).eq('tipo', 'Sugestão').order('id', { ascending: false })
    setRows(data || []); setLoading(false)
  }
  useEffect(() => { if (!empresaId) { setRows([]); setLoading(false); return } setTratadas(new Set()); carregar() }, [empresaId, competencia]) // eslint-disable-line

  async function confirmar(f) {
    try {
      await gerarLancamento({ competencia_id: modal.competencia_id, data: f.data || null, conta_debito: f.conta_debito, conta_credito: f.conta_credito, valor: num(f.valor), historico: f.historico, origem: 'sugestao', usuario: user?.email })
      // Marca a sugestão como confirmada (persistente): não reaparece ao recarregar nem é
      // regenerada no próximo import do razão (evita lançamento em dobro).
      await supabase.from('auditoria').update({ tipo: 'Sugestão Confirmada' }).eq('id', modal.id)
      setTratadas(s => new Set(s).add(modal.id)); setModal(null); setMsg('Lançamento gerado a partir da sugestão. Relatórios, balancete, DRE, conciliação e cockpit já refletem esta contabilização.'); setTimeout(() => setMsg(''), 5000)
    } catch (e) { setMsg('Erro: ' + e.message) }
  }

  // Ignorar a sugestão PERMANENTEMENTE: a sugestão não muda nada até ser confirmada, e
  // descartar não gera lançamento — só marca para não voltar nem ser regerada.
  async function descartar(id) {
    setTratadas(x => new Set(x).add(id))
    try { await supabase.from('auditoria').update({ tipo: 'Sugestão Descartada' }).eq('id', id) } catch (e) { console.error('descartar:', e) }
  }

  if (!empresaId) return <Aviso texto="Selecione uma empresa no menu lateral." />
  const ativos = rows.filter(r => !tratadas.has(r.id))

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Sugestões de Contabilização</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18, maxWidth: 820 }}>
Ao importar o razão, a plataforma já sugere: <b style={{ color: theme.text }}>apropriações do mês</b> (seguro e despesas) e <b style={{ color: theme.text }}>correções recorrentes</b> (quando uma conta que você já corrigiu antes reaparece com a mesma entidade), além da análise fiscal/contábil/folha. O que você confirmar vira lançamento e alimenta o Status → Domínio.
        {empresaNome && <> · <b style={{ color: theme.text }}>{empresaNome}</b> · {competencia}</>}
      </p>

      {msg && <div style={{ background: theme.card, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}><i className="ti ti-info-circle" style={{ color: theme.accent }} /> {msg}</div>}

      {loading ? (
        <p style={{ color: theme.sub }}>Carregando…</p>
      ) : ativos.length === 0 ? (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 640 }}>
          <i className="ti ti-bulb" style={{ fontSize: 24, color: theme.yellow }} />
          <p style={{ fontSize: 13.5, color: theme.text, margin: 0 }}>Nenhuma sugestão nesta competência. Aqui aparecem apenas contabilizações que a plataforma sugere a partir da análise do razão (fiscal, contábil e folha). Correções que você já fez na Conciliação ou no Status já estão lançadas e não são repetidas aqui.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {ativos.map(s => {
            const dec = decodePartida(s.detalhe)
            return (
            <div key={s.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${theme.accent}`, borderRadius: 12, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b style={{ fontSize: 14 }}>{s.item || s.modulo}</b>
                <span style={{ marginLeft: 8, background: hexA('#4A7CFF', 0.14), color: '#8FB0FF', fontSize: 11, padding: '3px 9px', borderRadius: 20 }}>{s.modulo}</span>
                <p style={{ color: theme.sub, fontSize: 12.5, margin: '6px 0 0' }}>{dec.humano || '(sem detalhe)'}</p>
                {dec.partida && <p style={{ color: theme.sub, fontSize: 11.5, margin: '4px 0 0' }}>D <b style={{ color: theme.text }}>{dec.partida.conta_debito}</b> · C <b style={{ color: theme.text }}>{dec.partida.conta_credito}</b> · <b style={{ color: theme.text }}>{money(dec.partida.valor)}</b></p>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn" style={{ fontSize: 13 }} onClick={() => setModal({ id: s.id, competencia_id: s.competencia_id, historico: dec.humano || `${s.modulo} · ${s.item || ''}`, partida: dec.partida })}><i className="ti ti-check" /> Confirmar</button>
                <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => descartar(s.id)}><i className="ti ti-x" /> Descartar</button>
              </div>
            </div>
          )})}
        </div>
      )}

      {modal && <PartidaModal cfg={modal} onClose={() => setModal(null)} onConfirm={confirmar} competencia={competencia} />}
    </div>
  )
}

function PartidaModal({ cfg, onClose, onConfirm, competencia }) {
  const [m, a] = (competencia || '').split('/').map(Number)
  const dataDefault = m && a ? `${a}-${String(m).padStart(2, '0')}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` : ''
  const p = cfg.partida
  const [f, setF] = useState({ data: p?.data || dataDefault, conta_debito: p?.conta_debito || '', conta_credito: p?.conta_credito || '', valor: p?.valor ? String(p.valor) : '', historico: cfg.historico || '' })
  const on = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,18,0.64)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, maxWidth: 560, width: '100%', padding: '22px 24px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Confirmar lançamento</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>Escreva a partida da sugestão e confirme.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label>Data</label><input className="input" type="date" value={f.data} onChange={on('data')} /></div>
          <div><label>Valor</label><input className="input" type="number" step="0.01" value={f.valor} onChange={on('valor')} /></div>
          <div><label>Conta débito</label><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></div>
          <div><label>Conta crédito</label><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><input className="input" value={f.historico} onChange={on('historico')} /></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => onConfirm(f)}>Confirmar e gerar</button>
        </div>
      </div>
    </div>
  )
}

function Aviso({ texto }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>Sugestões de Contabilização</h1>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
        <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} /><p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
      </div>
    </div>
  )
}
