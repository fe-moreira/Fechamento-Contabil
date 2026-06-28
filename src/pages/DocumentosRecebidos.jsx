import { useState } from 'react'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const PADRAO = [
  'Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída',
  'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Conciliações bancárias',
  'Razão do Domínio', 'Informações de distribuição de lucros',
]

export default function DocumentosRecebidos() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [check, setCheck] = useState({})

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral para conferir os documentos." />
      </Wrapper>
    )
  }

  const recebidos = PADRAO.filter(d => check[d]).length

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, maxWidth: 640 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 14 }}>Checklist de documentos</h3>
          <span style={{ fontSize: 13, color: recebidos === PADRAO.length ? theme.green : theme.sub }}>{recebidos}/{PADRAO.length} recebidos</span>
        </div>
        {PADRAO.map(d => (
          <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 4px', borderTop: `1px solid ${theme.border}`, cursor: 'pointer', fontSize: 13.5, color: theme.text }}>
            <input type="checkbox" checked={!!check[d]} onChange={e => setCheck(c => ({ ...c, [d]: e.target.checked }))} />
            <i className={`ti ${check[d] ? 'ti-circle-check' : 'ti-square'}`} style={{ color: check[d] ? theme.green : theme.sub, fontSize: 18 }} />
            {d}
          </label>
        ))}
        <p style={{ color: theme.sub, fontSize: 12, marginTop: 14 }}>
          Registro de conferência da competência. A persistência por competência e o vínculo com o gate de Status entram na próxima onda.
        </p>
      </div>
    </Wrapper>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Documentos Recebidos</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Conferência dos documentos do cliente por competência.</p>
      {children}
    </div>
  )
}

function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
