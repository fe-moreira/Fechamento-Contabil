import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

const ST = {
  fechado: { txt: 'Fechado', cor: theme.green, bg: 'rgba(48,164,108,0.15)', icon: 'ti-circle-check', sub: () => 'Entregue' },
  andamento: { txt: 'Em andamento', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)', icon: 'ti-progress', sub: c => `Progresso ${c.pct || 0}%` },
  pendente: { txt: 'Atrasado', cor: theme.red, bg: 'rgba(229,72,77,0.15)', icon: 'ti-alert-triangle', sub: () => 'Em atraso' },
}

export default function Fechamentos() {
  const { empresaId, empresaNome, competencia, setCompetencia, abrirFechamento, isAdmin, recalcularPendencias } = useAppData()
  const nav = useNavigate()
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [fAno, setFAno] = useState('todos')
  const [fMes, setFMes] = useState('todos')
  const [novo, setNovo] = useState(null)

  const [selMes, selAno] = competencia.split('/').map(Number)

  async function carregar() {
    setLoading(true)
    const { data } = await supabase.from('competencias').select('id, ano, mes, status, pct, documentos')
      .eq('cliente_id', empresaId).order('ano', { ascending: false }).order('mes', { ascending: false })
    setLista(data || []); setLoading(false)
  }
  useEffect(() => { if (empresaId) carregar(); else { setLista([]); setLoading(false) } }, [empresaId])

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para ver os fechamentos." /></Wrapper>
  }

  const filtrada = lista.filter(c => (fAno === 'todos' || c.ano === +fAno) && (fMes === 'todos' || c.mes === +fMes))
  const cont = { fechado: 0, andamento: 0, pendente: 0 }
  filtrada.forEach(c => { cont[c.status] = (cont[c.status] || 0) + 1 })

  function abrir(c) {
    abrirFechamento(c.mes, c.ano) // marca o fechamento como ativo (libera as funções)
    nav('/status')
  }
  async function criar() {
    const { ano, mes } = novo
    const existe = lista.find(c => c.ano === +ano && c.mes === +mes)
    if (existe) { setNovo(null); abrir(existe); return }
    const { data, error } = await supabase.from('competencias')
      .insert({ cliente_id: empresaId, ano: +ano, mes: +mes, status: 'andamento' }).select('id, ano, mes, status, pct, documentos').single()
    setNovo(null)
    if (!error && data) { await carregar(); abrir(data) }
  }

  async function excluir(c, e) {
    e.stopPropagation()
    const [{ count: nRaz }, { count: nLanc }, { count: nAud }] = await Promise.all([
      supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', c.id),
      supabase.from('lancamentos').select('id', { count: 'exact', head: true }).eq('competencia_id', c.id),
      supabase.from('auditoria').select('id', { count: 'exact', head: true }).eq('competencia_id', c.id),
    ])
    const docsRecebidos = Array.isArray(c.documentos) ? c.documentos.filter(d => d?.rec).length : 0
    const temDados = (nRaz || 0) + (nLanc || 0) + (nAud || 0) + docsRecebidos > 0 || c.status === 'fechado'
    if (temDados && !isAdmin) {
      alert('Este fechamento já tem dados (razão, lançamentos, documentos ou está fechado). Apenas um administrador pode excluí-lo.')
      return
    }
    const aviso = temDados
      ? `Excluir ${MESES[c.mes - 1]}/${c.ano}? Este fechamento TEM DADOS — vai apagar razão, balancete, lançamentos e auditoria desta competência. Tem certeza?`
      : `Excluir o fechamento vazio de ${MESES[c.mes - 1]}/${c.ano}?`
    if (!confirm(aviso)) return
    for (const t of ['razao', 'balancete', 'lancamentos', 'auditoria']) {
      await supabase.from(t).delete().eq('competencia_id', c.id)
    }
    await supabase.from('competencias').delete().eq('id', c.id)
    await carregar(); recalcularPendencias?.()
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <p style={{ color: theme.sub, fontSize: 13.5 }}><b style={{ color: theme.text }}>{empresaNome}</b> — escolha uma competência ou abra um novo fechamento.</p>
        <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setNovo({ ano: 2026, mes: 6 })}>
          <i className="ti ti-plus" /> Novo fechamento
        </button>
      </div>

      {/* Filtro */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ color: theme.sub, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="ti ti-calendar-event" style={{ color: theme.accent }} /> Filtrar período</span>
        <select className="input" style={selS} value={fAno} onChange={e => setFAno(e.target.value)}>
          <option value="todos">Todos os anos</option><option value="2026">2026</option><option value="2025">2025</option>
        </select>
        <select className="input" style={selS} value={fMes} onChange={e => setFMes(e.target.value)}>
          <option value="todos">Todos os meses</option>
          {MESES_CURTO.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
      </div>

      {/* Cards de resumo */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginBottom: 16 }}>
        <ResumoCard label="Fechados" valor={cont.fechado} icon="ti-circle-check" cor={theme.green} />
        <ResumoCard label="Em andamento" valor={cont.andamento} icon="ti-progress" cor={theme.yellow} />
        <ResumoCard label="Atrasados" valor={cont.pendente} icon="ti-alert-triangle" cor={theme.red} />
      </div>

      {/* Lista de fechamentos (linhas) */}
      {loading ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : filtrada.length === 0 ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '26px 22px', color: theme.sub, fontSize: 13.5 }}>
          Nenhum fechamento para este filtro. Clique em <b style={{ color: theme.text }}>Novo fechamento</b> para abrir uma competência.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtrada.map(c => {
            const s = ST[c.status] || ST.andamento
            const aberto = c.mes === selMes && c.ano === selAno
            return (
              <div key={c.id} onClick={() => abrir(c)} style={{
                background: theme.card, borderRadius: 12, padding: '16px 18px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 16,
                border: aberto ? `1px solid ${theme.accent}` : `0.5px solid ${theme.cb}`,
              }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg }}>
                  <i className={`ti ${s.icon}`} style={{ fontSize: 24, color: s.cor }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
                    {MESES[c.mes - 1]} {c.ano}
                    {aberto && <span style={{ color: theme.accent, fontSize: 13, fontWeight: 500 }}> · aberto</span>}
                  </p>
                  <p style={{ color: theme.sub, fontSize: 13, margin: '2px 0 0' }}>{s.sub(c)}</p>
                </div>
                <span style={{ background: s.bg, color: s.cor, fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                  <i className={`ti ${s.icon}`} /> {s.txt}
                </span>
                <i className="ti ti-trash" title="Excluir fechamento" onClick={e => excluir(c, e)}
                  style={{ color: theme.sub, fontSize: 17, flexShrink: 0, cursor: 'pointer' }} />
                <i className="ti ti-chevron-right" style={{ color: theme.sub, fontSize: 20, flexShrink: 0 }} />
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
                  {MESES_CURTO.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
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

function ResumoCard({ label, valor, icon, cor }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <i className={`ti ${icon}`} style={{ color: cor, fontSize: 16 }} />
        </span>
      </div>
      <p style={{ fontSize: 30, fontWeight: 700, margin: '8px 0 2px' }}>{valor}</p>
      <p style={{ color: theme.sub, fontSize: 12, margin: 0 }}>no período</p>
    </div>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Fechamento Contábil</h1>
      {children}
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
