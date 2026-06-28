import { theme } from '../lib/theme'

// Placeholder honesto para os módulos ainda não construídos.
// Princípio da especificação: o que não está pronto aparece como "em breve",
// nunca como dado fictício. A referência visual de cada tela está no protótipo.
export default function EmBreve({ titulo, sub, descricao, icon = 'ti-tool', onda }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>{titulo}</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 24 }}>{sub}</p>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '36px 28px', maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(74,124,255,0.14)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
          </div>
          <div>
            <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, color: theme.yellow, background: 'rgba(245,166,35,0.14)', padding: '3px 9px', borderRadius: 20, letterSpacing: 0.3 }}>EM BREVE</span>
            {onda && <span style={{ marginLeft: 8, fontSize: 12, color: theme.sub }}>Onda {onda}</span>}
          </div>
        </div>

        <p style={{ color: theme.text, fontSize: 14, lineHeight: 1.65 }}>{descricao}</p>

        <a href="/prototipo.html" target="_blank" rel="noreferrer" className="btn btn-ghost"
           style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 13 }}>
          <i className="ti ti-eye" /> Ver no protótipo
        </a>
      </div>
    </div>
  )
}
