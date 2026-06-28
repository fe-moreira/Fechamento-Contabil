import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const ST = {
  fechado: { txt: 'Fechado', cor: theme.green, bg: 'rgba(48,164,108,0.15)', icon: 'ti-circle-check' },
  andamento: { txt: 'Em andamento', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)', icon: 'ti-progress' },
  pendente: { txt: 'Pendente', cor: theme.red, bg: 'rgba(229,72,77,0.15)', icon: 'ti-alert-triangle' },
}

export default function Fechamentos() {
  const { empresaId, empresaNome, setCompetencia } = useAppData()
  const nav = useNavigate()
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [fAno, setFAno] = useState('todos')
  const [fMes, setFMes] = useState('todos')
  const [novo, setNovo] = useState(null) // { ano, mes }

  async function carregar() {
    setLoading(true)
    const { data } = await supabase.from('competencias').select('id, ano, mes, status, pct')
      .eq('cliente_id', empresaId).order('ano', { ascending: false }).order('mes', { ascending: false })
    setLista(data || []); setLoading(false)
  }
  useEffect(() => { if (empresaId) carregar(); else { setLista([]); setLoading(false) } }, [empresaId])

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso texto="Selecione uma empresa no menu lateral para ver os fechamentos." />
      </Wrapper>
    )
  }

  const filtrada = lista.filter(c => (fAno === 'todos' || c.ano === +fAno) && (fMes === 'todos' || c.mes === +fMes))
  const cont = { fechado: 0, andamento: 0, pendente: 0 }
  filtrada.forEach(c => { cont[c.status] = (cont[c.status] || 0) + 1 })

  function abrir(c) {
    setCompetencia(`${String(c.mes).padStart(2, '0')}/${c.ano}`)
    nav('/status')
  }

  async function criar() {
    const { ano, mes } = novo
    const existe = lista.find(c => c.ano === +ano && c.mes === +mes)
    if (existe) { setNovo(null); abrir(existe); return }
    const { data, error } = await supabase.from('competencias')
      .insert({ cliente_id: empresaId, ano: +ano, mes: +mes, status: 'andamento' }).select('id, ano, mes, status, pct').single()
    setNovo(null)
    if (!error && data) { await carregar(); abrir(data) }
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
        <p style={{ color: theme.sub, fontSize: 13 }}><b style={{ color: theme.text }}>{empresaNome}</b> — escolha uma competência ou abra um novo fechamento.</p>
        <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setNovo({ ano: 2026, mes: 6 })}>
          <i className="ti ti-plus" /> Novo fechamento
        </button>
      </div>

      {/* Filtro */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ color: theme.sub, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="ti ti-calendar-event" style={{ color: theme.accent }} /> Filtrar período</span>
        <select className="input" style={selS} value={fAno} onChange={e => setFAno(e.target.value)}>
          <option value="todos">Todos os anos</option><option value="2026">2026</option><option value="2025">2025</option>
        </select>
        <select className="input" style={selS} value={fMes} onChange={e => setFMes(e.target.value)}>
          <option value="todos">Todos os meses</option>
          {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: theme.sub, display: 'flex', gap: 14 }}>
          <span style={{ color: theme.green }}>{cont.fechado} fechado(s)</span>
          <span style={{ color: theme.yellow }}>{cont.andamento} em andamento</span>
          <span style={{ color: theme.red }}>{cont.pendente} pendente(s)</span>
        </span>
      </div>

      {/* Lista de fechamentos */}
      {loading ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : filtrada.length === 0 ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '26px 22px', color: theme.sub, fontSize: 13.5 }}>
          Nenhum fechamento para este filtro. Clique em <b style={{ color: theme.text }}>Novo fechamento</b> para abrir uma competência.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {filtrada.map(c => {
            const s = ST[c.status] || ST.andamento
            return (
              <div key={c.id} onClick={() => abrir(c)} style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 16, fontWeight: 600 }}>{MESES[c.mes - 1]}/{c.ano}</span>
                  <span style={{ background: s.bg, color: s.cor, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20 }}><i className={`ti ${s.icon}`} /> {s.txt}</span>
                </div>
                <div style={{ height: 6, background: theme.input, borderRadius: 20, overflow: 'hidden' }}>
                  <div style={{ width: `${c.pct || 0}%`, height: '100%', background: s.cor }} />
                </div>
                <p style={{ color: theme.sub, fontSize: 12, marginTop: 8 }}>{c.pct || 0}% concluído · abrir fechamento <i className="ti ti-chevron-right" /></p>
              </div>
            )
          })}
        </div>
      )}

      {/* Modal novo fechamento */}
      {novo && (
        <div onClick={() => setNovo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px, 96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 16 }}>Novo fechamento</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label>Mês</label>
                <select className="input" value={novo.mes} onChange={e => setNovo(n => ({ ...n, mes: +e.target.value }))}>
                  {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div><label>Ano</label>
                <select className="input" value={novo.ano} onChange={e => setNovo(n => ({ ...n, ano: +e.target.value }))}>
                  <option value={2026}>2026</option><option value={2025}>2025</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => setNovo(null)}>Cancelar</button>
              <button className="btn" onClick={criar}>Abrir fechamento</button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  )
}

const selS = { width: 'auto', padding: '8px 12px' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Fechamento Contábil</h1>
      <div style={{ marginBottom: 18 }}>{children}</div>
    </div>
  )
}
function Aviso({ texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
