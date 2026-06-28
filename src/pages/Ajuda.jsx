import { theme } from '../lib/theme'

const PASSOS = [
  ['ti-users', 'Cadastre os clientes', 'Em "Cadastro de Clientes", inclua as empresas do escritório (código no Domínio, razão social, regime).'],
  ['ti-building', 'Selecione empresa e competência', 'No topo, escolha a empresa e o mês/ano. Tudo do fechamento opera sobre essa seleção.'],
  ['ti-file-import', 'Importe o razão', 'Em "Importar Razão", suba o Excel do Domínio. O balancete da competência é gerado automaticamente.'],
  ['ti-checklist', 'Concilie as contas', 'Em "Conciliação", acompanhe o farol por conta (verde/amarelo/vermelho).'],
  ['ti-arrows-diff', 'Compare os meses', 'Em "Comp. Movimento", veja a evolução do ano e clique nos números para abrir o razão da conta.'],
  ['ti-pencil-plus', 'Contabilize ajustes', 'Em "Contabilizar", registre lançamentos e gere o arquivo no layout do Domínio.'],
  ['ti-traffic-lights', 'Acompanhe o Status', 'Em "Status", veja os gates de pendência. Verde quando o fechamento está pronto.'],
]

export default function Ajuda() {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Ajuda</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Fluxo do fechamento contábil, passo a passo.</p>

      <div style={{ maxWidth: 720 }}>
        {PASSOS.map(([icon, titulo, desc], i) => (
          <div key={titulo} style={{ display: 'flex', gap: 14, padding: '16px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(74,124,255,0.14)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 20 }} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>{i + 1}. {titulo}</p>
              <p style={{ fontSize: 13, color: theme.sub, lineHeight: 1.55 }}>{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <a href="/prototipo.html" target="_blank" rel="noreferrer" className="btn btn-ghost"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 22, fontSize: 13 }}>
        <i className="ti ti-eye" /> Abrir o protótipo de referência
      </a>
    </div>
  )
}
