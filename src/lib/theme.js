// Tokens do design system (mesma paleta do protótipo).
export const theme = {
  sidebar: '#1A2236',
  accent: '#4A7CFF',
  contentBg: '#161B29',
  card: '#1F2634',
  cb: 'rgba(255,255,255,0.06)',
  text: '#E8EAF0',
  sub: '#9BA3BC',
  input: '#1B212E',
  border: 'rgba(255,255,255,0.08)',
  green: '#30A46C',
  yellow: '#F5A623',
  red: '#E5484D',
}

export const money = (v) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// Saldo em convenção contábil: positivo = Devedor (D), negativo = Credor (C).
export const moneyDC = (v) => {
  const n = Number(v) || 0
  if (Math.abs(n) < 0.005) return money(0)
  return `${money(Math.abs(n))} ${n > 0 ? 'D' : 'C'}`
}
