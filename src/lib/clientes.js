// Regras de cadastro de clientes compartilhadas entre telas.

// Um cliente "fecha sozinho" (abre o próprio fechamento) quando é matriz, ou
// quando é filial com tipo de fechamento "Individualizado". Filial "Consolidado"
// é centralizada na matriz — não abre fechamento próprio nem entra no dashboard.
export function fechaSozinho(c) {
  if (!c) return false
  if (c.tipo !== 'Filial') return true
  return String(c.tipo_fechamento || '') === 'Individualizado'
}
