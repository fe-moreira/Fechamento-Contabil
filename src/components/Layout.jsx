import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { useAppData } from '../lib/appData'
import SeletorEmpresa from './SeletorEmpresa'
import { theme } from '../lib/theme'

const PRINCIPAL = [
  { to: '/', end: true, icon: 'ti-layout-dashboard', label: 'Dashboard' },
]

const FECHAMENTO = [
  { to: '/fechamentos', icon: 'ti-folders', label: 'Fechamentos' },
  { to: '/documentos', icon: 'ti-file-check', label: 'Documentos Recebidos' },
  { to: '/razao', icon: 'ti-file-import', label: 'Importar Razão' },
  { to: '/integracao', icon: 'ti-plug-connected', label: 'Integração' },
  { to: '/conciliacao', icon: 'ti-checklist', label: 'Conciliação' },
  { to: '/comparativo', icon: 'ti-arrows-diff', label: 'Comp. Movimento' },
  { to: '/contabilizar', icon: 'ti-pencil-plus', label: 'Contabilizar' },
  { to: '/relatorios', icon: 'ti-report', label: 'Relatórios' },
  { to: '/status', icon: 'ti-traffic-lights', label: 'Status' },
]

const SISTEMA = [
  { to: '/config', icon: 'ti-settings', label: 'Configurações' },
  { to: '/ajuda', icon: 'ti-help-circle', label: 'Ajuda' },
]

function Item({ to, end, icon, label, sub }) {
  return (
    <NavLink to={to} end={end} className={`nav-link${sub ? ' sub' : ''}`}>
      <i className={`ti ${icon}`} />
      <span style={{ flex: 1 }}>{label}</span>
    </NavLink>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const { competencia, setCompetencia, competencias, empresaNome } = useAppData()
  const [grupoAberto, setGrupoAberto] = useState(true)

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* SIDEBAR */}
      <aside style={{ width: 248, background: theme.sidebar, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {/* Marca */}
        <div style={{ padding: '20px 16px 16px' }}>
          <p style={{ margin: 0, color: '#fff', fontSize: 16, fontWeight: 600 }}>Contabilidade</p>
          <p style={{ margin: '1px 0 0', color: '#8FB0FF', fontSize: 11, fontWeight: 500 }}>by Attentive</p>
        </div>

        {/* Seletor de empresa (com busca por nome ou código) */}
        <div style={{ padding: '0 14px 6px' }}>
          <div className="side-divider" style={{ margin: '0 0 14px' }} />
          <SeletorEmpresa />
        </div>

        {/* Navegação */}
        <nav style={{ padding: '4px 8px', flex: 1, overflowY: 'auto' }}>
          <p className="sec-title">Principal</p>
          {PRINCIPAL.map(i => <Item key={i.to} {...i} />)}

          <div className="side-divider" />
          <p className="sec-title">Fechamento Contábil</p>
          <a className="nav-link" onClick={() => setGrupoAberto(o => !o)} style={{ userSelect: 'none' }}>
            <i className="ti ti-calendar-check" />
            <span style={{ flex: 1 }}>Fechamento</span>
            <i className={`ti ti-chevron-${grupoAberto ? 'down' : 'right'}`} style={{ fontSize: 15 }} />
          </a>
          {grupoAberto && FECHAMENTO.map(i => <Item key={i.to} {...i} sub />)}

          <div className="side-divider" />
          <p className="sec-title">Nível cliente</p>
          <Item to="/base" icon="ti-info-circle" label="Base de Informações" />

          <div className="side-divider" />
          <p className="sec-title">Sistema</p>
          {SISTEMA.map(i => <Item key={i.to} {...i} />)}
        </nav>

        {/* Usuário */}
        <div style={{ padding: 14, borderTop: '1px solid #263044' }}>
          <p style={{ color: '#8A9BBE', fontSize: 11.5, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</p>
          <button className="btn btn-ghost" style={{ width: '100%', fontSize: 13 }} onClick={signOut}>Sair</button>
        </div>
      </aside>

      {/* CONTEÚDO */}
      <main style={{ flex: 1, background: theme.contentBg, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Barra superior: empresa + competência */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 32px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 13, color: theme.sub, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-building" style={{ color: theme.sub }} />
            {empresaNome || 'Nenhuma empresa selecionada'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-calendar-event" style={{ color: theme.sub }} />
            <span style={{ fontSize: 12.5, color: theme.sub }}>Competência</span>
            <select className="input" style={{ width: 'auto', padding: '7px 10px' }} value={competencia} onChange={e => setCompetencia(e.target.value)}>
              {competencias.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ padding: '28px 32px', flex: 1 }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
