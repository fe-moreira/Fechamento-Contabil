import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

export default function Dashboard() {
  const nav = useNavigate()
  const [s, setS] = useState({ clientes: null, fechado: 0, andamento: 0, pendente: 0 })
  const [recentes, setRecentes] = useState([])

  useEffect(() => {
    (async () => {
      const { count } = await supabase.from('clientes').select('id', { count: 'exact', head: true })
      const { data: comps } = await supabase.from('competencias').select('status')
      const c = { fechado: 0, andamento: 0, pendente: 0 }
      for (const x of (comps || [])) c[x.status] = (c[x.status] || 0) + 1
      setS({ clientes: count ?? 0, ...c })

      const { data: rec } = await supabase.from('competencias')
        .select('id, ano, mes, status, clientes(razao_social)')
        .order('created_at', { ascending: false }).limit(6)
      setRecentes(rec || [])
    })()
  }, [])

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Dashboard</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>Visão geral de todos os clientes.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14, marginBottom: 18 }}>
        <Metric label="Clientes" valor={s.clientes} icon="ti-building" />
        <Metric label="Fechados" valor={s.fechado} icon="ti-circle-check" cor={theme.green} />
        <Metric label="Em andamento" valor={s.andamento} icon="ti-progress" cor={theme.yellow} />
        <Metric label="Pendentes" valor={s.pendente} icon="ti-alert-triangle" cor={theme.red} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)', gap: 16 }}>
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20 }}>
          <p style={{ fontSize: 16, fontWeight: 500, margin: '0 0 12px' }}>Fechamentos recentes</p>
          {recentes.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13 }}>Nenhum fechamento aberto ainda.</p>
          ) : recentes.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: `1px solid ${theme.border}`, fontSize: 13 }}>
              <span style={{ color: theme.text }}>{r.clientes?.razao_social || '—'} <span style={{ color: theme.sub }}>· {MESES[r.mes - 1]}/{r.ano}</span></span>
              <span style={{ color: r.status === 'fechado' ? theme.green : r.status === 'pendente' ? theme.red : theme.yellow, fontSize: 12 }}>{r.status}</span>
            </div>
          ))}
        </div>

        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20 }}>
          <p style={{ fontSize: 16, fontWeight: 500, margin: '0 0 12px' }}>Ações rápidas</p>
          {[
            ['ti-calendar-check', 'Ver fechamentos', '/fechamentos'],
            ['ti-file-import', 'Importar razão', '/razao'],
            ['ti-file-check', 'Documentos recebidos', '/documentos'],
            ['ti-info-circle', 'Base de Informações', '/base'],
          ].map(([icon, txt, to]) => (
            <div key={to} onClick={() => nav(to)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', cursor: 'pointer', fontSize: 13.5, color: theme.text }}>
              <i className={`ti ${icon}`} style={{ color: theme.accent }} /> {txt}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Metric({ label, valor, icon, cor }) {
  return (
    <div style={{ background: theme.input, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 16 }} />
        </span>
      </div>
      <p style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 0', color: cor || theme.text }}>{valor === null ? '…' : valor}</p>
    </div>
  )
}
