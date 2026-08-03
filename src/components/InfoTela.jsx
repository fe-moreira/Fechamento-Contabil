import { useState, useRef } from 'react'
import { theme } from '../lib/theme'

// Botão de informação (ⓘ): clica e abre um balão com a explicação da tela/seção.
// O balão se POSICIONA sozinho: abre pra baixo, mas VIRA PRA CIMA quando está perto do
// rodapé (não corta / não obriga a rolar); e alinha à direita quando está perto da borda.
//   <InfoTela titulo="Comparativo de resultado">Texto de ajuda…</InfoTela>
export default function InfoTela({ children, titulo, style, size = 19 }) {
  const [aberto, setAberto] = useState(false)
  const [pos, setPos] = useState({ v: 'down', h: 'left' })
  const btnRef = useRef(null)

  function toggle() {
    setAberto(a => {
      const abrir = !a
      if (abrir && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect()
        const espacoAbaixo = window.innerHeight - r.bottom
        // Vira pra cima se não cabe embaixo E cabe em cima.
        const v = (espacoAbaixo < 280 && r.top > 280) ? 'up' : 'down'
        const h = r.left > window.innerWidth * 0.55 ? 'right' : 'left'
        setPos({ v, h })
      }
      return abrir
    })
  }

  const balao = {
    position: 'absolute', zIndex: 61, width: 'min(440px, 82vw)',
    maxHeight: 'min(60vh, 420px)', overflow: 'auto',
    ...(pos.v === 'up' ? { bottom: '140%' } : { top: '140%' }),
    ...(pos.h === 'right' ? { right: 0 } : { left: 0 }),
    background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 12, padding: '13px 15px',
    boxShadow: '0 12px 32px rgba(0,0,0,.32)', fontSize: 12.5, lineHeight: 1.55, color: theme.sub,
    textAlign: 'left', whiteSpace: 'normal', fontWeight: 400,
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <button ref={btnRef} type="button" onClick={toggle} title="O que é isso?"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex', color: theme.accent }}>
        <i className="ti ti-info-circle-filled" style={{ fontSize: size }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={balao}>
            {titulo && <p style={{ margin: '0 0 6px', fontWeight: 600, color: theme.text, fontSize: 13 }}>{titulo}</p>}
            <div>{children}</div>
          </div>
        </>
      )}
    </span>
  )
}
