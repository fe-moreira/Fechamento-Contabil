import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const CATS = ['Bancário', 'Fiscal', 'Folha', 'Contábil', 'Societário', 'Outros']
const PADRAO = [
  { cat: 'Bancário', name: 'Extratos bancários' },
  { cat: 'Fiscal', name: 'Notas fiscais de entrada' },
  { cat: 'Fiscal', name: 'Notas fiscais de saída' },
  { cat: 'Folha', name: 'Folha de pagamento' },
  { cat: 'Fiscal', name: 'Guias de impostos (DARF/GPS/DAS)' },
  { cat: 'Contábil', name: 'Razão do Domínio' },
]
const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)

export default function DocumentosRecebidos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const [docs, setDocs] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState('')
  const [cat, setCat] = useState('Fiscal')

  useEffect(() => {
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)
    const [mes, ano] = competencia.split('/').map(Number)
    supabase.from('competencias').select('documentos').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      .then(({ data }) => {
        const d = data?.documentos
        setDocs(Array.isArray(d) && d.length ? d : PADRAO.map(x => ({ ...x, rec: false, date: '' })))
        setCarregando(false)
      })
  }, [empresaId, competencia])

  async function persistir(novo) {
    setDocs(novo)
    const id = await getCompetenciaId()
    if (id) await supabase.from('competencias').update({ documentos: novo }).eq('id', id)
  }

  const toggle = (i) => persistir(docs.map((d, j) => j === i ? { ...d, rec: !d.rec, date: !d.rec ? hojeCurto() : '' } : d))
  const remover = (i) => { if (confirm(`Excluir “${docs[i].name}” da lista?`)) persistir(docs.filter((_, j) => j !== i)) }
  const incluir = () => { if (!nome.trim()) return; persistir([...docs, { cat, name: nome.trim(), rec: false, date: '' }]); setNome('') }

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso texto="Selecione uma empresa no menu lateral para conferir os documentos." />
      </Wrapper>
    )
  }

  const total = docs.length, rec = docs.filter(d => d.rec).length
  const pct = total ? Math.round(rec / total * 100) : 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Progresso */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: theme.text, fontSize: 15, fontWeight: 600 }}>{rec} de {total} recebidos</span>
          <span style={{ color: pct === 100 ? theme.green : theme.yellow, fontWeight: 600 }}>{pct}%</span>
        </div>
        <div style={{ height: 8, background: theme.input, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? theme.green : theme.accent }} />
        </div>
      </div>

      {/* Incluir documento */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={e => setCat(e.target.value)}>
          {CATS.map(c => <option key={c}>{c}</option>)}
        </select>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Nome do documento" value={nome}
          onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === 'Enter' && incluir()} />
        <button className="btn" onClick={incluir}><i className="ti ti-plus" /> Incluir</button>
      </div>

      {/* Lista */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        {carregando ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Carregando…</p>
        ) : docs.length === 0 ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Nenhum documento na lista. Inclua acima.</p>
        ) : docs.map((d, i) => (
          <div key={i} onClick={() => toggle(i)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', cursor: 'pointer', fontSize: 13.5 }}>
            <i className={`ti ${d.rec ? 'ti-square-check' : 'ti-square'}`} style={{ color: d.rec ? theme.green : theme.sub, fontSize: 20 }} />
            <span style={{ flex: 1, color: d.rec ? theme.text : theme.sub }}>{d.name} <span style={{ color: theme.sub, fontSize: 11 }}>· {d.cat}</span></span>
            {d.rec
              ? <span style={{ color: theme.sub, fontSize: 12 }}>recebido {d.date}</span>
              : <span style={{ color: theme.yellow, fontSize: 12, fontWeight: 500 }}>pendente</span>}
            <i className="ti ti-trash" title="Excluir" onClick={e => { e.stopPropagation(); remover(i) }} style={{ color: theme.sub, fontSize: 16, marginLeft: 4 }} />
          </div>
        ))}
      </div>
    </Wrapper>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Documentos Recebidos</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Personalize a lista por cliente — inclua ou exclua documentos. O que faltar vira pendência.</p>
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
