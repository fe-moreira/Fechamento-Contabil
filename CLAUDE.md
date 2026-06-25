import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'

export default function Dashboard() {
  const [stats, setStats] = useState({ clientes: null })

  useEffect(() => {
    supabase.from('clientes').select('id', { count: 'exact', head: true })
      .then(({ count }) => setStats(s => ({ ...s, clientes: count ?? 0 })))
  }, [])

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Dashboard</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 24 }}>Visão geral do escritório</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 14 }}>
        <Card titulo="Clientes" valor={stats.clientes} />
        <Card titulo="Fechamentos em andamento" valor="—" />
        <Card titulo="Pendências" valor="—" />
      </div>

      <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 28, lineHeight: 1.6 }}>
        Esta é a fundação funcional (núcleo). O próximo passo é ligar a importação do razão,
        o balancete e a conciliação, reaproveitando a referência visual em <code>/prototipo</code>.
      </p>
    </div>
  )
}

function Card({ titulo, valor }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '18px 18px' }}>
      <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 8 }}>{titulo}</p>
      <p style={{ fontSize: 28, fontWeight: 700 }}>{valor === null ? '…' : valor}</p>
    </div>
  )
}
