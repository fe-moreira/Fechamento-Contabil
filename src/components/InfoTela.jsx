import { useState } from 'react'
import { theme } from '../lib/theme'

// Botão de informação (ⓘ): clica e abre um balão com a explicação da tela/seção.
// Padrão para substituir os parágrafos de ajuda que poluíam as telas.
//   <InfoTela titulo="Comparativo de resultado">Texto de ajuda…</InfoTela>
export default function InfoTela({ children, titulo, style, size = 19 }) {
  const [aberto, setAberto] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <button type="button" onClick={() => setAberto(a => !a)} title="O que é isso?"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex', color: theme.accent }}>
        <i className="ti ti-info-circle-filled" style={{ fontSize: size }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{
            position: 'absolute', top: '140%', left: 0, zIndex: 61, width: 'min(440px, 82vw)',
            background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 12, padding: '13px 15px',
            boxShadow: '0 12px 32px rgba(0,0,0,.32)', fontSize: 12.5, lineHeight: 1.55, color: theme.sub,
            textAlign: 'left', whiteSpace: 'normal', fontWeight: 400,
          }}>
            {titulo && <p style={{ margin: '0 0 6px', fontWeight: 600, color: theme.text, fontSize: 13 }}>{titulo}</p>}
            <div>{children}</div>
          </div>
        </>
      )}
    </span>
  )
}
