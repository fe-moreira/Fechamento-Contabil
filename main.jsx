import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { theme } from '../lib/theme'

const itens = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/clientes', label: 'Clientes' },
  { to: '/fechamentos', label: 'Fechamentos' },
]

export default function Layout() {
  const { user, signOut } = useAuth()
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 230, background: theme.sidebar, padding: '22px 14px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 700, fontSize: 16, padding: '0 8px 20px' }}>
          Contabilidade<br /><span style={{ color: theme.accent }}>by Attentive</span>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {itens.map(i => (
            <NavLink key={i.to} to={i.to} end={i.end} style={({ isActive }) => ({
              padding: '10px 12px', borderRadius: 8, fontSize: 14,
              color: isActive ? '#fff' : theme.sub,
              background: isActive ? 'rgba(74,124,255,0.16)' : 'transparent',
            })}>{i.label}</NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '0 8px' }}>
          <p style={{ color: theme.sub, fontSize: 11.5, marginBottom: 8 }}>{user?.email}</p>
          <button className="btn btn-ghost" style={{ width: '100%', fontSize: 13 }} onClick={signOut}>Sair</button>
        </div>
      </aside>
      <main style={{ flex: 1, background: theme.contentBg, padding: '28px 32px', overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  )
}
