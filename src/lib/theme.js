// Tokens do design system (mesma paleta do protótipo). Cada token aponta para uma
// CSS variable, definida em index.css para os temas claro/escuro. Assim qualquer
// `theme.x` (inline ou constante de módulo) resolve a cor ao vivo quando o atributo
// data-theme muda — sem precisar re-renderizar a árvore React.
export const theme = {
  sidebar: 'var(--c-sidebar)',
  accent: 'var(--c-accent)',
  contentBg: 'var(--c-contentBg)',
  card: 'var(--c-card)',
  cb: 'var(--c-cb)',
  text: 'var(--c-text)',
  sub: 'var(--c-sub)',
  input: 'var(--c-input)',
  border: 'var(--c-border)',
  green: 'var(--c-green)',
  yellow: 'var(--c-yellow)',
  red: 'var(--c-red)',
}

// ---- Tema claro/escuro ----
export const THEME_KEY = 'attentive-tema'

export function getThemeMode() {
  try { const m = localStorage.getItem(THEME_KEY); if (m === 'light' || m === 'dark') return m } catch { /* ignore */ }
  return 'dark'
}

// Aplica o tema no documento (atributo data-theme) e persiste. As cores trocam via CSS.
export function applyThemeMode(mode) {
  const m = mode === 'light' ? 'light' : 'dark'
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', m)
  try { localStorage.setItem(THEME_KEY, m) } catch { /* ignore */ }
  return m
}

// Aplica o tema salvo o quanto antes (evita "piscar" no carregamento).
if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', getThemeMode())

export const money = (v) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// Saldo em convenção contábil: positivo = Devedor (D), negativo = Credor (C).
export const moneyDC = (v) => {
  const n = Number(v) || 0
  if (Math.abs(n) < 0.005) return money(0)
  return `${money(Math.abs(n))} ${n > 0 ? 'D' : 'C'}`
}
