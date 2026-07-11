import { Link } from 'react-router-dom'
import { theme } from '../lib/theme'

// Espelha a tela de Configurações do protótipo: título + grade de cards.
export default function Configuracoes() {
  return (
    <div>
      <p style={{ fontSize: 22, fontWeight: 500, color: theme.text, margin: '0 0 4px' }}>Configurações</p>
      <p style={{ fontSize: 13, color: theme.sub, margin: '0 0 22px' }}>Parâmetros do sistema.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
        <Cfg to="/clientes" icon="ti-users" titulo="Cadastro de Clientes" sub="Importação em lote, filiais, CNPJ" />
        <Cfg to="/usuarios" icon="ti-user-shield" titulo="Usuários" sub="Convidar e gerenciar acessos (ADM)" />
        <Cfg to="/grupo-empresarial" icon="ti-building-community" titulo="Grupo Empresarial" sub="Agrupar empresas do mesmo grupo" />
        <Cfg to="/relatorio-gerencial-modelo" icon="ti-report-analytics" titulo="Mod. Relatório Gerencial" sub="Modelos de relatório gerencial" />
      </div>
    </div>
  )
}

function Cfg({ to, icon, titulo, sub }) {
  const card = (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}>
      <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 20 }} />
      </span>
      <div>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>{titulo}</p>
        <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{sub}</p>
      </div>
    </div>
  )
  return to ? <Link to={to}>{card}</Link> : card
}
