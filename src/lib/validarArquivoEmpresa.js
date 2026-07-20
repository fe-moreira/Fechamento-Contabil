import { supabase } from './supabase'

// Trava de segurança na importação: o arquivo tem que "pertencer" à empresa selecionada.
// Como muitos arquivos do Domínio NÃO trazem o CNPJ, usamos o CÓDIGO da empresa (codigo_dominio;
// para filiais, também o codigo_matriz) — e conferimos tanto no NOME do arquivo quanto no
// CONTEÚDO (o código costuma aparecer no cabeçalho do relatório). Para uma MATRIZ, aceitamos
// também os códigos das FILIAIS (o consolidado da filial é importado na matriz).

const soDig = s => String(s ?? '').replace(/\D/g, '')

// Código aparece como NÚMERO ISOLADO no texto (aceita zeros à esquerda), para não casar
// por acaso dentro de um número maior.
function textoTemCodigo(texto, codigos) {
  const t = String(texto || '')
  return codigos.some(cod => {
    if (!cod) return false
    const semZero = cod.replace(/^0+/, '') || cod
    return new RegExp(`(^|\\D)0*${semZero}(\\D|$)`).test(t)
  })
}

// Códigos aceitos para a empresa: o próprio (codigo_dominio), o da matriz (se for filial) e,
// se ESTE cliente for uma matriz, os códigos das FILIAIS marcadas como CONSOLIDADO que apontam
// para o código dela — o fechamento consolidado da filial é importado na matriz. Filial
// INDIVIDUALIZADA fecha sozinha e NÃO libera o arquivo na matriz.
async function codigosAceitos(cliente) {
  const set = new Set([cliente.codigo_dominio, cliente.codigo_matriz].map(soDig).filter(Boolean))
  const cod = soDig(cliente.codigo_dominio) // compara por dígitos (ignora zeros à esquerda/formatação)
  if (cod) {
    try {
      const { data } = await supabase.from('clientes').select('codigo_dominio, codigo_matriz, tipo_fechamento').eq('tipo', 'Filial')
      for (const f of (data || [])) {
        if (soDig(f.codigo_matriz) !== cod) continue                     // filial desta matriz?
        if (!/consolidad/i.test(String(f.tipo_fechamento || ''))) continue // só consolidado importa na matriz
        const d = soDig(f.codigo_dominio); if (d) set.add(d)
      }
    } catch { /* sem rede: fica só com os códigos locais */ }
  }
  return [...set]
}

// Lê o CONTEÚDO do arquivo como texto para procurar o código (xlsx/xls → células do cabeçalho;
// pdf → texto; csv/txt → bruto). Só as primeiras linhas — o código vem no topo do relatório.
async function lerTextoArquivo(file) {
  const nome = String(file.name || '').toLowerCase()
  if (nome.endsWith('.pdf')) {
    const { extrairTextoPdf } = await import('./pdfText')
    return await extrairTextoPdf(file)
  }
  if (nome.endsWith('.csv') || nome.endsWith('.txt')) {
    return (await file.text()).slice(0, 200000)
  }
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const linhas = []
  for (const sn of wb.SheetNames) {
    const arr = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' })
    for (const row of arr.slice(0, 300)) linhas.push(row.join(' '))
    if (linhas.length >= 600) break
  }
  return linhas.join('\n')
}

export function erroCodigoEmpresa(cliente) {
  const cod = cliente?.codigo_dominio || '—'
  return `Este arquivo não parece ser da empresa selecionada (código ${cod}). ` +
    `O código da empresa precisa estar no NOME ou no CONTEÚDO do arquivo — para não importar em outra empresa. ` +
    `Confira se pegou o arquivo certo, ou renomeie incluindo o código (ex.: "${cod} razao.xlsx").`
}

// Valida NOME e (para relatórios do Domínio) o CONTEÚDO. Devolve '' se ok, ou a mensagem.
// opts.conteudo = false → só confere o NOME (ex.: extrato bancário/financeiro, que vem do
// banco e não traz o código do Domínio dentro). Uso:
//   const err = await checarArquivoEmpresa(file, cliente); if (err) { setErro(err); return }
export async function checarArquivoEmpresa(file, cliente, opts = {}) {
  const { conteudo = true } = opts
  if (!file || !cliente) return ''
  const codigos = await codigosAceitos(cliente)
  if (!codigos.length) return '' // empresa sem código cadastrado → não trava
  // 1) Nome do arquivo já resolve (rápido).
  if (textoTemCodigo(file.name, codigos)) return ''
  // 2) Financeiro: só o nome. Se não achou no nome, barra.
  if (!conteudo) return erroCodigoEmpresa(cliente)
  // 3) Demais (razão/fiscal/folha/patrimônio/base): procura também no conteúdo.
  try {
    const texto = await lerTextoArquivo(file)
    if (textoTemCodigo(texto, codigos)) return ''
  } catch { /* não conseguiu ler o conteúdo → cai no erro abaixo */ }
  return erroCodigoEmpresa(cliente)
}
