import { useEffect, useState } from 'react'
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { useAppData } from '../lib/appData'
import SeletorEmpresa from './SeletorEmpresa'
import { theme, applyThemeMode, getThemeMode } from '../lib/theme'

// Rotas (funções do fechamento) que só liberam com um fechamento aberto.
const ROTAS_FECHAMENTO = new Set(['/razao', '/documentos', '/integracao', '/conciliacao', '/comparativo', '/sugestoes', '/outras', '/contabilizar', '/relatorios', '/painel-cliente', '/status', '/base'])

const PRINCIPAL = [
  { to: '/', end: true, icon: 'ti-layout-dashboard', label: 'Dashboard' },
]

const FECHAMENTO = [
  { to: '/fechamentos', icon: 'ti-folders', label: 'Fechamentos' },
  { to: '/documentos', icon: 'ti-file-check', label: 'Documentos Recebidos' },
  { to: '/razao', icon: 'ti-file-import', label: 'Importar Razão' },
  { to: '/sugestoes', icon: 'ti-bulb', label: 'Sugestões de Contab.' },
  { to: '/outras', icon: 'ti-layout-grid-add', label: 'Outras Contabilizações' },
  { to: '/integracao', icon: 'ti-plug-connected', label: 'Integração' },
  { to: '/conciliacao', icon: 'ti-checklist', label: 'Conciliação' },
  { to: '/comparativo', icon: 'ti-arrows-diff', label: 'Comp. Movimento' },
  { to: '/status', icon: 'ti-traffic-lights', label: 'Status' },
  { to: '/relatorios', icon: 'ti-report', label: 'Relatórios' },
  { to: '/painel-cliente', icon: 'ti-presentation-analytics', label: 'Dashboard do Cliente' },
]

const SISTEMA = [
  { to: '/config', icon: 'ti-settings', label: 'Configurações' },
  { to: '/timesheet', icon: 'ti-clock', label: 'Tempo (Timesheet)' },
  { to: '/ajuda', icon: 'ti-help-circle', label: 'Ajuda' },
]

function Item({ to, end, icon, label, sub, badge, colapsado }) {
  return (
    <NavLink to={to} end={end} className={`nav-link${sub ? ' sub' : ''}`} title={colapsado ? label : undefined}
      style={colapsado ? { justifyContent: 'center', padding: '10px 0', position: 'relative' } : undefined}>
      <i className={`ti ${icon}`} />
      {!colapsado && <span style={{ flex: 1 }}>{label}</span>}
      {!colapsado && badge != null && (
        <span style={{ minWidth: 20, height: 18, padding: '0 6px', borderRadius: 20, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: badge > 0 ? theme.red : theme.green }}>{badge}</span>
      )}
      {colapsado && badge != null && badge > 0 && (
        <span style={{ position: 'absolute', top: 6, right: 14, width: 8, height: 8, borderRadius: '50%', background: theme.red }} />
      )}
    </NavLink>
  )
}

// Alternância de tema (claro/escuro). Troca o atributo data-theme — as cores vêm das
// CSS variables, então a mudança é instantânea e persiste no localStorage.
function ThemeToggle({ colapsado }) {
  const [mode, setMode] = useState(getThemeMode())
  const claro = mode === 'light'
  const flip = () => setMode(applyThemeMode(claro ? 'dark' : 'light'))

  if (colapsado) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '0 12px 8px' }}>
        <i className={`ti ${claro ? 'ti-sun' : 'ti-moon'}`} onClick={flip} title={claro ? 'Tema claro' : 'Tema escuro'}
          style={{ color: '#C5CFE3', cursor: 'pointer', fontSize: 19, background: '#141A2A', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
      </div>
    )
  }
  return (
    <div style={{ padding: '0 14px 8px' }}>
      <div onClick={flip} title="Alternar tema claro/escuro"
        style={{ background: '#141A2A', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
        <span style={{ color: '#C5CFE3', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className={`ti ${claro ? 'ti-sun' : 'ti-moon'}`} /> {claro ? 'Claro' : 'Escuro'}
        </span>
        <span style={{ width: 38, height: 22, borderRadius: 20, background: claro ? theme.accent : '#3A4356', position: 'relative', transition: 'background .15s', flexShrink: 0, display: 'inline-block' }}>
          <span style={{ position: 'absolute', top: 2, left: claro ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
        </span>
      </div>
    </div>
  )
}

// Indicador de tempo da sessão atual (zera ao trocar de empresa).
function TimerSessao() {
  const [s, setS] = useState(0)
  useEffect(() => { const iv = setInterval(() => setS(x => x + 1), 1000); return () => clearInterval(iv) }, [])
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0')
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.green }}>
      <i className="ti ti-clock" /> {mm}:{ss}
    </span>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const { competencia, empresaId, empresaNome, pendencias, fechamentoAtivo } = useAppData()
  const location = useLocation()
  const navigate = useNavigate()
  // Ao trocar de cliente, vai para a tela de Fechamentos para escolher/abrir um.
  useEffect(() => { if (empresaId) navigate('/fechamentos') }, [empresaId]) // eslint-disable-line react-hooks/exhaustive-deps
  const precisaFechamento = ROTAS_FECHAMENTO.has(location.pathname) && !fechamentoAtivo
  const [grupoAberto, setGrupoAberto] = useState(true)
  const [colapsado, setColapsado] = useState(false)

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* SIDEBAR */}
      <aside style={{ width: colapsado ? 72 : 248, background: theme.sidebar, display: 'flex', flexDirection: 'column', flexShrink: 0, transition: 'width .2s ease' }}>
        {/* Marca + recolher */}
        <div style={{ padding: colapsado ? '20px 12px 16px' : '20px 16px 16px', display: 'flex', alignItems: 'center', gap: 9, justifyContent: colapsado ? 'center' : 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <img src="/attentive-logo.png" alt="Attentive" style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0 }} />
            {!colapsado && (
              <div style={{ lineHeight: 1.15, minWidth: 0 }}>
                <p style={{ margin: 0, color: '#fff', fontSize: 16, fontWeight: 600 }}>Contabilidade</p>
                <p style={{ margin: '1px 0 0', color: '#8FB0FF', fontSize: 11, fontWeight: 500 }}>by Attentive</p>
              </div>
            )}
          </div>
          {!colapsado && (
            <i className="ti ti-chevron-left" title="Recolher" onClick={() => setColapsado(true)}
              style={{ color: '#8A9BBE', cursor: 'pointer', fontSize: 18, flexShrink: 0 }} />
          )}
        </div>
        {colapsado && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '0 0 8px' }}>
            <i className="ti ti-chevron-right" title="Expandir" onClick={() => setColapsado(false)} style={{ color: '#8A9BBE', cursor: 'pointer', fontSize: 18 }} />
          </div>
        )}

        {/* Seletor de empresa */}
        <div style={{ padding: colapsado ? '0 12px 6px' : '0 14px 6px' }}>
          <div className="side-divider" style={{ margin: '0 0 14px' }} />
          {colapsado ? (
            <div onClick={() => setColapsado(false)} title={empresaNome || 'Empresa'}
              style={{ background: '#222B3D', borderRadius: 10, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <i className="ti ti-building" style={{ color: '#8A9BBE', fontSize: 20 }} />
            </div>
          ) : <SeletorEmpresa />}
        </div>

        {/* Navegação */}
        <nav style={{ padding: colapsado ? '4px 12px' : '4px 8px', flex: 1, overflowY: 'auto' }}>
          {!colapsado && <p className="sec-title">Principal</p>}
          {PRINCIPAL.map(i => <Item key={i.to} {...i} colapsado={colapsado} />)}

          <div className="side-divider" />
          {!colapsado && <p className="sec-title">Fechamento Contábil</p>}
          <a className="nav-link" onClick={() => colapsado ? setColapsado(false) : setGrupoAberto(o => !o)} title="Fechamento"
            style={colapsado ? { justifyContent: 'center', padding: '10px 0', userSelect: 'none' } : { userSelect: 'none' }}>
            <i className="ti ti-calendar-check" />
            {!colapsado && <span style={{ flex: 1 }}>Fechamento</span>}
            {!colapsado && <i className={`ti ti-chevron-${grupoAberto ? 'down' : 'right'}`} style={{ fontSize: 15 }} />}
          </a>
          {(grupoAberto || colapsado) && FECHAMENTO.map(i => <Item key={i.to} {...i} sub={!colapsado} colapsado={colapsado} badge={i.to === '/status' ? pendencias : undefined} />)}

          <div className="side-divider" />
          {!colapsado && <p className="sec-title">Nível cliente</p>}
          <Item to="/base" icon="ti-info-circle" label="Base de Informações" colapsado={colapsado} />
          <Item to="/importacoes" icon="ti-file-upload" label="Importação em massa" colapsado={colapsado} />
          <Item to="/relatorios-massa" icon="ti-report-analytics" label="Relatórios em massa" colapsado={colapsado} />

          <div className="side-divider" />
          {!colapsado && <p className="sec-title">Sistema</p>}
          {SISTEMA.map(i => <Item key={i.to} {...i} colapsado={colapsado} />)}
        </nav>

        {/* Tema claro/escuro */}
        <ThemeToggle colapsado={colapsado} />

        {/* Usuário */}
        <div style={{ padding: 14, borderTop: '1px solid #263044' }}>
          {colapsado ? (
            <button className="btn btn-ghost" title="Sair" onClick={signOut} style={{ width: '100%', fontSize: 14, padding: '8px 0' }}><i className="ti ti-logout" /></button>
          ) : (
            <>
              <p style={{ color: '#8A9BBE', fontSize: 11.5, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</p>
              <button className="btn btn-ghost" style={{ width: '100%', fontSize: 13 }} onClick={signOut}>Sair</button>
            </>
          )}
        </div>
      </aside>

      {/* CONTEÚDO */}
      <main style={{ flex: 1, background: theme.contentBg, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Barra superior: empresa + tempo + competência */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 32px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 13, color: theme.sub, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-building" style={{ color: theme.sub }} />
              {empresaNome || 'Nenhuma empresa selecionada'}
            </span>
            {empresaNome && (
              <Link to="/timesheet" title="Relatório de tempo" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <TimerSessao key={empresaId} />
              </Link>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-calendar-event" style={{ color: fechamentoAtivo ? theme.green : theme.sub }} />
            {fechamentoAtivo ? (
              <>
                <span style={{ fontSize: 12.5, color: theme.sub }}>Fechamento</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{competencia}</span>
                <Link to="/fechamentos" className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}><i className="ti ti-switch-horizontal" /> Trocar</Link>
              </>
            ) : (
              <Link to="/fechamentos" className="btn" style={{ fontSize: 12.5, padding: '6px 12px' }}><i className="ti ti-calendar-plus" /> Abrir fechamento</Link>
            )}
          </div>
        </div>

        <div style={{ padding: '28px 32px', flex: 1 }}>
          {precisaFechamento ? <GateFechamento empresaId={empresaId} /> : <Outlet />}
        </div>
      </main>
    </div>
  )
}

// Bloqueio: função do fechamento sem um fechamento aberto.
function GateFechamento({ empresaId }) {
  return (
    <div style={{ background: theme.card, border: `1px solid ${theme.yellow}`, borderRadius: 14, padding: '30px 28px', maxWidth: 620, display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <i className="ti ti-calendar-exclamation" style={{ fontSize: 28, color: theme.yellow, marginTop: 2 }} />
      <div>
        <p style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>Abra um fechamento para continuar</p>
        <p style={{ color: theme.sub, fontSize: 13.5, margin: '0 0 16px', lineHeight: 1.55 }}>
          {empresaId
            ? 'As funções (importar razão, documentos, conciliação, relatórios…) só funcionam com um fechamento aberto. Escolha um fechamento existente ou crie um novo.'
            : 'Selecione uma empresa no menu lateral e abra um fechamento.'}
        </p>
        <Link to="/fechamentos" className="btn"><i className="ti ti-calendar-plus" /> Ir para Fechamentos</Link>
      </div>
    </div>
  )
}
