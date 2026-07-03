import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './components/AuthProvider'
import Layout from './components/Layout'
import { AppDataProvider } from './lib/appData'
import { theme } from './lib/theme'

import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Clientes from './pages/Clientes'
import Fechamentos from './pages/Fechamentos'
import ImportarRazao from './pages/ImportarRazao'
import DocumentosRecebidos from './pages/DocumentosRecebidos'
import Integracao from './pages/Integracao'
import Conciliacao from './pages/Conciliacao'
import CompMovimento from './pages/CompMovimento'
import Contabilizar from './pages/Contabilizar'
import OutrasContabilizacoes from './pages/OutrasContabilizacoes'
import SugestoesContabilizacao from './pages/SugestoesContabilizacao'
import Relatorios from './pages/Relatorios'
import Status from './pages/Status'
import BaseInformacoes from './pages/BaseInformacoes'
import Configuracoes from './pages/Configuracoes'
import Ajuda from './pages/Ajuda'
import Timesheet from './pages/Timesheet'

function Protegido({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: theme.sub }}>Carregando…</div>
  if (!session) return <Navigate to="/login" replace />
  return children
}

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
        <Route path="documentos" element={<DocumentosRecebidos />} />
        <Route path="integracao" element={<Integracao />} />
        <Route path="conciliacao" element={<Conciliacao />} />
        <Route path="comparativo" element={<CompMovimento />} />
        <Route path="sugestoes" element={<SugestoesContabilizacao />} />
        <Route path="outras" element={<OutrasContabilizacoes />} />
        <Route path="contabilizar" element={<Contabilizar />} />
        <Route path="relatorios" element={<Relatorios />} />
        <Route path="status" element={<Status />} />
        <Route path="base" element={<BaseInformacoes />} />
        <Route path="config" element={<Configuracoes />} />
        <Route path="timesheet" element={<Timesheet />} />
        <Route path="ajuda" element={<Ajuda />} />
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
