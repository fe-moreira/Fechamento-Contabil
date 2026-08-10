import { describe, it, expect } from 'vitest'
import { resolverEntidade, classificarGrupos, aplicarLink, ovDC } from './conciliacaoCore.js'

// Fábrica de lançamento com o modelo de dados descrito na tarefa.
function L({ id, abertura = false, acerto = false, debito = 0, credito = 0, entidade = '', ident = !!entidade, nf = '', ajustado = false }) {
  return { id, _abertura: abertura, acerto, debito, credito, leitura: { entidade, ident, nf, ajustado } }
}
// Aplica resolverEntidade e devolve NOVO lançamento com o nome resolvido gravado em leitura.entidade.
function resolver(l, estado) {
  const nome = resolverEntidade(l.leitura.entidade, { corrigido: !!l.leitura.ajustado, ...estado })
  return { ...l, leitura: { ...l.leitura, entidade: nome, ident: !!nome } }
}
const nomes = arr => arr.map(g => g.nome)
const grupoDe = (arr, nome) => arr.find(g => g.nome === nome)

describe('A) LARISSA — saldo inicial sozinho, confirmado, sem par → EM ABERTO (nunca conciliado)', () => {
  it('grupo nonzero fica em aberto mesmo com foiConfirmado/jaTratada = true', () => {
    const larissa = L({ id: 'A', abertura: true, credito: 23000, entidade: 'LARISSA' })
    // jaTratada = sempre true simula o "foiConfirmado" (a linha foi confirmada em lote).
    const { emAberto, conciliados } = classificarGrupos([larissa], { ov: ovDC, jaTratada: () => true })
    expect(nomes(conciliados)).toEqual([])                 // NADA em conciliados
    expect(nomes(emAberto)).toEqual(['LARISSA'])           // segue compondo o saldo
    expect(grupoDe(emAberto, 'LARISSA').total).toBeCloseTo(-23000, 3)
  })
})

describe('B) LINK CARLA + EMPIRE — nomes diferentes unidos → grupo zera → CONCILIADOS', () => {
  it('aplicarLink força o canônico e resolverEntidade junta os dois num grupo só', () => {
    const carla = L({ id: 'B1', debito: 4500, entidade: 'CARLA' })
    const empire = L({ id: 'B2', credito: 4500, entidade: 'EMPIRE' })
    const { aliasForcado } = aplicarLink([carla, empire], ['B1', 'B2'], {})
    // canônico = mais longo entre os identificados = "EMPIRE"
    expect(aliasForcado).toEqual({ carla: 'EMPIRE' })

    const estado = { aliasNormal: {}, aliasForcado }
    const lancs = [resolver(carla, estado), resolver(empire, estado)]
    expect(lancs.map(l => l.leitura.entidade)).toEqual(['EMPIRE', 'EMPIRE'])

    const { emAberto, conciliados } = classificarGrupos(lancs, { ov: ovDC, jaTratada: () => true })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['EMPIRE'])
    expect(grupoDe(conciliados, 'EMPIRE').total).toBeCloseTo(0, 3)
  })
})

describe('C) GF4 — corrigir e reagrupar → CONCILIADOS', () => {
  it('pagamento lido "ALLAN KENNEDY" corrigido p/ GF4 agrupa com o título GF4 e zera', () => {
    const titulo = L({ id: 'C1', abertura: true, credito: 93864, entidade: 'GF4' })
    // Pagamento: o sistema leu "ALLAN KENNEDY", o usuário corrigiu para "GF4" (ajustado=true).
    const pagamento = L({ id: 'C2', debito: 93864, entidade: 'GF4', ajustado: true })

    const estado = { aliasNormal: {}, aliasForcado: {} }
    const rt = resolver(titulo, estado)
    const rp = resolver(pagamento, estado)
    // A correção é soberana: o pagamento devolve "GF4" (não volta para "ALLAN KENNEDY").
    expect(rp.leitura.entidade).toBe('GF4')

    const jaTratada = l => l.id === 'C1'                   // título tratado; pagamento é acerto/corrigido → tratado abaixo
    const { emAberto, conciliados } = classificarGrupos([rt, { ...rp, acerto: true }], { ov: ovDC, jaTratada })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['GF4'])
    expect(grupoDe(conciliados, 'GF4').total).toBeCloseTo(0, 3)
  })
})

describe('D) VICTOR / L&M — correção manual soberana sobre o vínculo forçado', () => {
  it('linha corrigida p/ VICTOR NÃO é puxada para L&M pelo aliasForcado', () => {
    const aliasForcado = { victor: 'L&M' }               // a união mandaria VICTOR → L&M
    // Corrigida à mão (corrigido=true): o vínculo forçado não aplica.
    expect(resolverEntidade('VICTOR', { corrigido: true, aliasNormal: {}, aliasForcado })).toBe('VICTOR')
    // Contraprova: sem a correção, o vínculo forçado a levaria para L&M.
    expect(resolverEntidade('VICTOR', { corrigido: false, aliasNormal: {}, aliasForcado })).toBe('L&M')
  })
})

describe('E) REGRESSÃO — união legítima por aliasForcado continua conciliando', () => {
  it('dois lançamentos opostos (nomes diferentes) unidos e tratados → CONCILIADOS', () => {
    const l1 = L({ id: 'E1', debito: 4500, entidade: 'ACME NORTE' })
    const l2 = L({ id: 'E2', credito: 4500, entidade: 'ACME SUL' })
    const aliasForcado = { 'acme sul': 'ACME NORTE' }    // vínculo manual (sem trava do mesmo cliente)
    const estado = { aliasNormal: {}, aliasForcado }
    const lancs = [resolver(l1, estado), resolver(l2, estado)]
    expect(lancs.map(l => l.leitura.entidade)).toEqual(['ACME NORTE', 'ACME NORTE'])

    const { emAberto, conciliados } = classificarGrupos(lancs, { ov: ovDC, jaTratada: () => true })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['ACME NORTE'])
    expect(grupoDe(conciliados, 'ACME NORTE').total).toBeCloseTo(0, 3)
  })
})

describe('F) REGRESSÃO — agrupamento por nome (zera × não zera)', () => {
  it('mesmo nome soma 0 e tratados → CONCILIADOS', () => {
    const a = L({ id: 'F1', debito: 4500, entidade: 'BETA' })
    const b = L({ id: 'F2', credito: 4500, entidade: 'BETA' })
    const { emAberto, conciliados } = classificarGrupos([a, b], { ov: ovDC, jaTratada: () => true })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['BETA'])
  })
  it('mesmo nome soma != 0 → EM ABERTO', () => {
    const a = L({ id: 'F3', debito: 4500, entidade: 'GAMA' })
    const b = L({ id: 'F4', credito: 3000, entidade: 'GAMA' })   // resta 1500
    const { emAberto, conciliados } = classificarGrupos([a, b], { ov: ovDC, jaTratada: () => true })
    expect(nomes(conciliados)).toEqual([])
    expect(nomes(emAberto)).toEqual(['GAMA'])
    expect(grupoDe(emAberto, 'GAMA').total).toBeCloseTo(1500, 3)
  })
})

describe('G) correção-DEPOIS-link (o caso que quebrou antes)', () => {
  it('o link limpa a correção anterior e passa a agrupar/zerar a linha', () => {
    // Linha corrigida à mão para "X" (curto). Outra linha do mesmo par com nome longo.
    const corrigida = L({ id: 'g1', debito: 4500, entidade: 'X', ajustado: true })
    const outra = L({ id: 'g2', credito: 4500, entidade: 'MEGA CORP CANONICAL' })

    // ANTES do link, a correção é soberana: mesmo com um vínculo qualquer, "X" fica "X".
    expect(resolverEntidade('X', { corrigido: true, aliasForcado: { x: 'MEGA CORP CANONICAL' } })).toBe('X')

    // O usuário LINKA as duas. O link é a ação mais recente → manda LIMPAR a correção de g1.
    const { aliasForcado, correcoesLimpas, canonical } = aplicarLink([corrigida, outra], ['g1', 'g2'], {})
    expect(canonical).toBe('MEGA CORP CANONICAL')          // mais longo
    expect(aliasForcado).toEqual({ x: 'MEGA CORP CANONICAL' })
    expect(correcoesLimpas).toEqual(['g1'])                // <- limpar a correção de g1

    // Com a correção LIMPA (ajustado=false), o vínculo forçado do link finalmente aplica.
    const limpa = { ...corrigida, leitura: { ...corrigida.leitura, ajustado: false } }
    const estado = { aliasNormal: {}, aliasForcado }
    const lancs = [resolver(limpa, estado), resolver(outra, estado)]
    expect(lancs.map(l => l.leitura.entidade)).toEqual(['MEGA CORP CANONICAL', 'MEGA CORP CANONICAL'])

    const { emAberto, conciliados } = classificarGrupos(lancs, { ov: ovDC, jaTratada: () => true })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['MEGA CORP CANONICAL'])
    expect(grupoDe(conciliados, 'MEGA CORP CANONICAL').total).toBeCloseTo(0, 3)
  })
})

describe('H) correção é SOBERANA sobre TUDO (apelido normal, vínculo forçado — e, na tela, o nome do fiscal)', () => {
  it('linha corrigida NÃO é trocada por apelido normal do mesmo cliente', () => {
    const aliasNormal = { 'gf4 assessoria': 'GF4 ASSESSORIA EMPRESARIAL LTDA' }
    // Com correção: o nome que o usuário pôs manda.
    expect(resolverEntidade('GF4 ASSESSORIA', { corrigido: true, aliasNormal })).toBe('GF4 ASSESSORIA')
    // Contraprova: SEM correção, o apelido do mesmo cliente aplica normalmente.
    expect(resolverEntidade('GF4 ASSESSORIA', { corrigido: false, aliasNormal })).toBe('GF4 ASSESSORIA EMPRESARIAL LTDA')
  })
  it('linha corrigida NÃO é trocada por vínculo forçado nem por apelido', () => {
    expect(resolverEntidade('GF4', { corrigido: true, aliasNormal: { gf4: 'X' }, aliasForcado: { gf4: 'ALLAN KENNEDY' } })).toBe('GF4')
  })
})

describe('I) em aberto = só composição — grupo que ZERA vai pra conciliados mesmo sem confirmar linha a linha', () => {
  it('título + pagamento mesmo nome, mesmo valor, opostos → CONCILIADOS mesmo com jaTratada=false', () => {
    // Ex.: ATTENTIVE/GMMG — o pagamento foi só "corrigido" (nome), nenhuma linha "confirmada".
    const titulo = L({ id: 'I1', abertura: true, credito: 27200, entidade: 'GMMG SOLUCOES ADM LTDA' })
    const pag = L({ id: 'I2', debito: 27200, entidade: 'GMMG SOLUCOES ADM LTDA', ajustado: true })
    const { emAberto, conciliados } = classificarGrupos([titulo, pag], { ov: ovDC, jaTratada: () => false })
    expect(nomes(emAberto)).toEqual([])
    expect(nomes(conciliados)).toEqual(['GMMG SOLUCOES ADM LTDA'])
    expect(grupoDe(conciliados, 'GMMG SOLUCOES ADM LTDA').total).toBeCloseTo(0, 3)
  })
  it('o que NÃO zera continua em aberto (composição)', () => {
    const soTitulo = L({ id: 'I3', abertura: true, credito: 5000, entidade: 'DELTA' })
    const { emAberto, conciliados } = classificarGrupos([soTitulo], { ov: ovDC, jaTratada: () => false })
    expect(nomes(conciliados)).toEqual([])
    expect(nomes(emAberto)).toEqual(['DELTA'])
  })
})
