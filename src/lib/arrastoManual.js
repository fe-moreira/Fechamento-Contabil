// Reconhecimento de BAIXA para o arrasto de saldo — funções PURAS (sem Supabase, testáveis).

// Detecta baixa MANUAL pelo texto do detalhe da auditoria (conexão/vínculo manual, vínculo
// aprovado, "Confirmado em lote"). A conciliação AUTOMÁTICA não passa por aqui.
export const ehBaixaManualDet = det => {
  const s = String(det || '')
  return s.startsWith('Confirmado em lote') || /conex[aã]o manual|v[ií]nculo (?:manual|aprovado)/i.test(s)
}

// Remove do arrasto as linhas já baixadas — no AUTOMÁTICO (Set `baixados`, casado por NF+valor+bloco
// no core, respeitado sempre) e no MANUAL (registros da `auditoria`).
//
// TRAVA "baixa que não zera não baixa", POR GRUPO: cada baixa manual tem um grupo (`grp:` no
// detalhe — as linhas que o usuário baixou juntas). Um grupo só é RETIRADO do arrasto se ELE SOMAR
// ZERO (título e pagamento se compensam). Se um grupo não zera — porque a reimportação do razão
// quebrou o vínculo e só uma perna foi reconhecida — só AQUELE grupo segue em aberto; os demais
// grupos já concluídos continuam baixados. (Antes a trava era GLOBAL por conta: uma única baixa
// quebrada impedia TODO o resto de sair, e todos os fornecedores já concluídos voltavam a aparecer
// no mês seguinte.) Como cada grupo descartado soma zero, o SALDO arrastado é idêntico — muda só a
// composição (o que já fechou não reaparece). Baixas antigas sem `grp:` caem num balde único
// (comportamento anterior preservado entre si).
//
// O reconhecimento das pernas é por CONTAGEM (consumindo), para gêmeas sem NF (mesma data/valor)
// não marcarem umas às outras; a trava de zero por grupo é a garantia final.
export function descartarBaixadasManuais(lanc, baixados, audit, contaCod) {
  const dataAbArr = l => (l.data && l.data !== 'abertura') ? String(l.data) : ''
  const centsOf = l => Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100)
  const itemArr = l => `${contaCod} · ${l.data || ''} · NF ${l.leitura?.nf || '—'}`
  const grpOf = det => { const m = /\bgrp:([\w-]+)/.exec(String(det || '')); return m ? m[1] : '__nogrp__' }
  const baixadaRzGrp = new Map()       // razao_id -> grp
  const baixadaAbGrpQ = new Map()      // "data·cents" -> fila de grp (perna de abertura, por contagem)
  const baixadaItemGrpQ = new Map()    // "conta · data · NF" -> fila de grp (perna de razão sem razao_id atual)
  const pushQ = (m, k, g) => { const a = m.get(k) || []; a.push(g); m.set(k, a) }
  for (const a of (audit || [])) {
    if (!ehBaixaManualDet(a.detalhe)) continue
    const g = grpOf(a.detalhe)
    if (a.razao_id) baixadaRzGrp.set(a.razao_id, g)
    const it = String(a.item || '')
    const p = it.split('·')
    if (p[0] === 'AB' && p.length === 6) pushQ(baixadaAbGrpQ, `${(p[2] || '').trim()}·${(p[5] || '').trim()}`, g) // data·cents
    else if (it.includes(' · NF ')) pushQ(baixadaItemGrpQ, it.trim(), g) // "conta · data · NF X"
  }
  // 1) Reconhece as linhas baixadas manualmente (consumindo a contagem), anotando o GRUPO de cada.
  // Baixas antigas sem `grp:` são agrupadas por FORNECEDOR (núcleo do nome) — era assim que o
  // "Confirmar em lote" as baixava (por entidade). Assim, mesmo no legado, um fornecedor quebrado
  // não derruba os outros.
  const nomeKey = l => (String(l.leitura?.entidade || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length >= 3).sort().join(' ')) || '?'
  const lineGrp = new Map() // l -> grp
  for (const l of lanc) {
    if (baixados && baixados.has(l)) continue
    if (Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0)) < 0.005) continue
    let g = null
    if (l.abertura || l._abertura) {
      const k = `${dataAbArr(l)}·${centsOf(l)}`
      const q = baixadaAbGrpQ.get(k); if (q && q.length) g = q.shift()
    } else {
      const rid = l.acerto ? String(l.id).replace(/^ac_/, '') : l.id
      if (baixadaRzGrp.has(rid)) g = baixadaRzGrp.get(rid)
      else if (!l.acerto) { const k = itemArr(l); const q = baixadaItemGrpQ.get(k); if (q && q.length) g = q.shift() }
    }
    if (g != null) lineGrp.set(l, g === '__nogrp__' ? '__nogrp__:' + nomeKey(l) : g)
  }
  // 2) TRAVA DE ZERO POR GRUPO: descarta só os grupos que fecham em zero.
  const porGrupo = new Map()
  for (const [l, g] of lineGrp) { const a = porGrupo.get(g) || []; a.push(l); porGrupo.set(g, a) }
  const descartar = new Set()
  for (const linhas of porGrupo.values()) {
    const net = linhas.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
    if (Math.abs(net) < 0.005) for (const l of linhas) descartar.add(l)
  }
  // 3) Monta o em aberto.
  const abertos = []
  for (const l of lanc) {
    if (baixados && baixados.has(l)) continue // conciliado no automático (NF+valor+bloco) — nunca arrasta
    if (Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0)) < 0.005) continue
    if (descartar.has(l)) continue // baixa manual (grupo) que ZEROU — sai do arrasto
    abertos.push(l)
  }
  return abertos
}
