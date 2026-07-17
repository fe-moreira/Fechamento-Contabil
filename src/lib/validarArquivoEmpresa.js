// Trava de segurança na importação: o NOME do arquivo tem que conter o CÓDIGO da empresa
// (codigo_dominio, ou codigo_matriz para filiais). Muitos arquivos do Domínio não trazem o
// CNPJ, então o código no nome é o que evita subir o arquivo de uma empresa em outra.

const soDig = s => String(s ?? '').replace(/\D/g, '')

// O nome do arquivo contém o código da empresa? Procura o código como NÚMERO ISOLADO no
// nome (aceitando zeros à esquerda), para não casar por acaso dentro de um número maior.
export function nomeTemCodigoEmpresa(nome, cliente) {
  if (!cliente) return true // sem empresa selecionada, deixa outra validação tratar
  const alvos = [cliente.codigo_dominio, cliente.codigo_matriz].map(soDig).filter(Boolean)
  if (!alvos.length) return true // empresa sem código cadastrado → não trava
  const n = String(nome || '')
  return alvos.some(cod => {
    const semZero = cod.replace(/^0+/, '') || cod
    const re = new RegExp(`(^|\\D)0*${semZero}(\\D|$)`)
    return re.test(n)
  })
}

// Mensagem de erro padrão quando o código não está no nome do arquivo.
export function erroCodigoEmpresa(cliente) {
  const cod = cliente?.codigo_dominio || '—'
  return `O nome do arquivo precisa ter o código da empresa (${cod}) para evitar importar em outra empresa. ` +
    `Renomeie o arquivo incluindo o código — ex.: "${cod} razao.xlsx" — e importe de novo.`
}

// Conveniência: valida e devolve a mensagem de erro (ou '' se ok). Uso:
//   const err = checarCodigoArquivo(file.name, cliente); if (err) { setErro(err); return }
export function checarCodigoArquivo(nome, cliente) {
  return nomeTemCodigoEmpresa(nome, cliente) ? '' : erroCodigoEmpresa(cliente)
}
