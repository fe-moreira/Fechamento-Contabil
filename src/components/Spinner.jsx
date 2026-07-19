import { theme } from '../lib/theme'

// Indicador de carregamento: um ícone girando (+ texto opcional). Use sempre que
// houver espera (buscar, salvar, importar, gerar) para deixar claro que o sistema
// está trabalhando — sem isso a tela parece travada.
//   <Spinner label="Carregando…" />                 → bloco com texto
//   <Spinner />                                       → só o ícone (dentro de botão)
export default function Spinner({ label, size = 15, cor, style }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: cor || theme.sub, fontSize: 13, ...style }}>
      <i className="ti ti-loader-2 girando" style={{ fontSize: size, color: cor || theme.accent }} />
      {label}
    </span>
  )
}
