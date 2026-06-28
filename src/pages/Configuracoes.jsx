import { useAuth } from '../components/AuthProvider'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

export default function Configuracoes() {
  const { user } = useAuth()
  const { empresas, empresaNome, competencia } = useAppData()

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Configurações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Informações do ambiente e da sessão.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16, maxWidth: 720 }}>
        <Bloco titulo="Sessão" icon="ti-user-shield" linhas={[
          ['Usuário', user?.email || '—'],
          ['Empresa selecionada', empresaNome || 'nenhuma'],
          ['Competência', competencia],
        ]} />
        <Bloco titulo="Escritório" icon="ti-building" linhas={[
          ['Clientes cadastrados', String(empresas.length)],
          ['Plataforma', 'Contabilidade by Attentive'],
        ]} />
        <Bloco titulo="Segurança" icon="ti-lock" linhas={[
          ['Banco de dados', 'Supabase (RLS habilitado)'],
          ['Acesso', 'Somente usuários autenticados'],
        ]} />
      </div>

      <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 24, lineHeight: 1.6, maxWidth: 720 }}>
        Gestão de usuários, papéis e preferências do escritório entram nas próximas ondas. As chaves de
        ambiente ficam na Vercel e no Supabase — nunca no código.
      </p>
    </div>
  )
}

function Bloco({ titulo, icon, linhas }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 18 }} />
        <h3 style={{ fontSize: 14 }}>{titulo}</h3>
      </div>
      {linhas.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: `1px solid ${theme.border}` }}>
          <span style={{ fontSize: 12.5, color: theme.sub }}>{k}</span>
          <span style={{ fontSize: 12.5, color: theme.text, textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}
