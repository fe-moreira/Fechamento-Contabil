import { useState, useRef } from 'react'
import { theme } from '../lib/theme'

// Botão de informação (ⓘ): clica e abre um balão com a explicação da tela/seção.
// O balão usa posição FIXA (calculada a partir do ícone) para NÃO ser cortado por nenhum
// container com overflow:hidden (ex.: os cards de índices) e se ajusta à borda da tela:
// vira pra cima quando falta espaço embaixo e nunca sai pelos lados.
//   <InfoTela titulo="Comparativo de resultado">Texto de ajuda…</InfoTela>
export default function InfoTela({ children, titulo, style, size = 19 }) {
  const [aberto, setAberto] = useState(false)
  const [coord, setCoord] = useState(null)
  const btnRef = useRef(null)

  function toggle() {
    setAberto(a => {
      const abrir = !a
      if (abrir && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect()
        const W = Math.min(440, window.innerWidth - 16)
        const abaixo = window.innerHeight - r.bottom
        const acima = r.top
        const paraCima = abaixo < 300 && acima > abaixo
        let left = r.left
        if (left + W > window.innerWidth - 8) left = window.innerWidth - 8 - W
        if (left < 8) left = 8
        const c = { left, width: W }
        if (paraCima) { c.bottom = window.innerHeight - r.top + 6; c.maxHeight = acima - 16 }
        else { c.top = r.bottom + 6; c.maxHeight = abaixo - 16 }
        setCoord(c)
      }
      return abrir
    })
  }

  return (
    <span style={{ display: 'inline-flex', ...style }}>
      <button ref={btnRef} type="button" onClick={toggle} title="O que é isso?"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex', color: theme.accent }}>
        <i className="ti ti-info-circle-filled" style={{ fontSize: size }} />
      </button>
      {aberto && coord && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{
            position: 'fixed', zIndex: 61, ...coord, overflow: 'auto',
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
