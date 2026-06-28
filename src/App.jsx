import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './components/AuthProvider'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Clientes from './pages/Clientes'
import Fechamentos from './pages/Fechamentos'
import ImportarRazao from './pages/ImportarRazao'
import EmBreve from './pages/EmBreve'
import { AppDataProvider } from './lib/appData'
import { theme } from './lib/theme'

function Protegido({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: theme.sub }}>Carregando…</div>
  if (!session) return <Navigate to="/login" replace />
  return children
}

// Módulos ainda não construídos — descrições vindas da especificação (fonte de verdade).
const EM_BREVE = [
  { path: 'documentos', titulo: 'Documentos Recebidos', icon: 'ti-file-check', onda: 3,
    sub: 'Documentos do cliente por competência',
    descricao: 'Recebimento e conferência dos documentos enviados pelo cliente em cada competência, alimentando o gate de Status do fechamento.' },
  { path: 'integracao', titulo: 'Integração', icon: 'ti-plug-connected', onda: 5,
    sub: 'Financeira, fiscal, folha e patrimônio',
    descricao: 'Pipeline pré-razão para clientes com integração financeira via Excel: importa extrato, separa contabilizado × não identificado e gera o arquivo no layout do Domínio. Abas Fiscal/Folha/Patrimônio.' },
  { path: 'conciliacao', titulo: 'Conciliação', icon: 'ti-checklist', onda: 4,
    sub: 'Farol verde / amarelo / vermelho por conta',
    descricao: 'Conciliação por tipo de conta: saldo simples, composição (clientes, estoques, fornecedores) e impostos (ICMS, PIS, COFINS) com baixa do mês anterior e memória de cálculo.' },
  { path: 'comparativo', titulo: 'Comp. Movimento', icon: 'ti-arrows-diff', onda: 5,
    sub: 'Comparativo mês a mês do ano',
    descricao: 'Colunas Jan → mês atual acumulando, com sinal vermelho para desvio acima de 10% da média. Números clicáveis abrem o razão da conta e a plataforma aponta o lançamento provável culpado.' },
  { path: 'contabilizar', titulo: 'Contabilizar', icon: 'ti-pencil-plus', onda: 5,
    sub: 'Fila central de lançamentos',
    descricao: 'Fila de lançamentos (débito, crédito, valor, histórico, origem, documento, usuário) com sugestões da plataforma e geração do arquivo no layout exato do Domínio.' },
  { path: 'relatorios', titulo: 'Relatórios', icon: 'ti-report', onda: 6,
    sub: 'DRE, Balanço, Composições e auditoria',
    descricao: 'Book de Composições, Pendências, DRE, Comparativo, Balanço, DFC, Balancete e o relatório de Justificativas e correções do fechamento (cada uma com usuário e data). Export Excel.' },
  { path: 'status', titulo: 'Status', icon: 'ti-traffic-lights', onda: 6,
    sub: 'Gates de pendência do fechamento',
    descricao: 'Lista de gates com contagem (Carga inicial, Documentos, Conciliação, Integração, Variações, Ajustes, Banco × resultado e Distribuição de lucros · IRRF 2026). Badge vermelho com pendências, verde ao zerar.' },
  { path: 'base', titulo: 'Base de Informações', icon: 'ti-info-circle', onda: 2,
    sub: 'Cargas com vigência (nível cliente)',
    descricao: 'Particularidades, contatos e os parâmetros do fechamento versionados por vigência: plano de contas, de/para de integrações, apelidos, amarração banco × resultado e distribuição de lucros.' },
  { path: 'config', titulo: 'Configurações', icon: 'ti-settings',
    sub: 'Configurações do sistema',
    descricao: 'Preferências do escritório, usuários e ajustes gerais da plataforma.' },
  { path: 'ajuda', titulo: 'Ajuda', icon: 'ti-help-circle',
    sub: 'Central de ajuda',
    descricao: 'Documentação de uso, fluxo do fechamento e referência do protótipo navegável.' },
]

function Rotas() {
  const { session } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<Protegido><AppDataProvider><Layout /></AppDataProvider></Protegido>}>
        <Route index element={<Dashboard />} />
        <Route path="clientes" element={<Clientes />} />
        <Route path="fechamentos" element={<Fechamentos />} />
        <Route path="razao" element={<ImportarRazao />} />
        {EM_BREVE.map(m => (
          <Route key={m.path} path={m.path} element={
            <EmBreve titulo={m.titulo} sub={m.sub} descricao={m.descricao} icon={m.icon} onda={m.onda} />
          } />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Rotas />
    </AuthProvider>
  )
}
