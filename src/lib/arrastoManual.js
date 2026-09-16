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
// TRAVA "baixa que não zera não baixa": o conjunto reconhecido como baixa manual só é RETIRADO do
// arrasto se ele SOMAR ZERO (título e pagamento se compensam). Se sobrar diferença — porque a
// reimportação do razão quebrou o vínculo e só uma perna do par foi reconhecida, ou o
// reconhecimento por texto pegou linhas a mais/a menos — NÃO retira nada: as linhas seguem EM
// ABERTO (equilibradas), o usuário re-baixa no razão atual. Assim o saldo arrastado é SEMPRE igual
// ao saldo real da conta (saldo final de junho = saldo inicial de julho) e nunca cria diferença.
//
// O reconhecimento em si é por CONTAGEM (consumindo), para gêmeas sem NF (mesma data/valor) não
// marcarem umas às outras — mas a trava de zero é a garantia final.
export function descartarBaixadasManuais(lanc, baixados, audit, contaCod) {
  const dataAbArr = l => (l.data && l.data !== 'abertura') ? String(l.data) : ''
  const centsOf = l => Math.round(((Number(l.debito) || 0) - (Number(l.credito) || 0)) * 100)
  const itemArr = l => `${contaCod} · ${l.data || ''} · NF ${l.leitura?.nf || '—'}`
  const baixadaRz = new Set()          // razao_id (perna de razão / acerto) — único
  const baixadaAbCnt = new Map()       // "data·cents" -> nº de baixas (perna de abertura)
  const baixadaItemCnt = new Map()     // "conta · data · NF" -> nº de baixas (perna de razão; sobrevive à reimportação)
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1)
  for (const a of (audit || [])) {
    if (!ehBaixaManualDet(a.detalhe)) continue
    if (a.razao_id) baixadaRz.add(a.razao_id)
    const it = String(a.item || '')
    const p = it.split('·')
    if (p[0] === 'AB' && p.length === 6) inc(baixadaAbCnt, `${(p[2] || '').trim()}·${(p[5] || '').trim()}`) // data·cents
    else if (it.includes(' · NF ')) inc(baixadaItemCnt, it.trim()) // "conta · data · NF X"
  }
  // 1) Reconhece as linhas baixadas manualmente (consumindo a contagem).
  const reconhecidas = new Set()
  for (const l of lanc) {
    if (baixados && baixados.has(l)) continue
    if (Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0)) < 0.005) continue
    let baixadaManual = false
    if (l.abertura || l._abertura) {
      const k = `${dataAbArr(l)}·${centsOf(l)}`
      if ((baixadaAbCnt.get(k) || 0) > 0) { baixadaAbCnt.set(k, baixadaAbCnt.get(k) - 1); baixadaManual = true }
    } else {
      const rid = l.acerto ? String(l.id).replace(/^ac_/, '') : l.id
      if (baixadaRz.has(rid)) baixadaManual = true
      else if (!l.acerto) { const k = itemArr(l); if ((baixadaItemCnt.get(k) || 0) > 0) { baixadaItemCnt.set(k, baixadaItemCnt.get(k) - 1); baixadaManual = true } }
    }
    if (baixadaManual) reconhecidas.add(l)
  }
  // 2) TRAVA DE ZERO: só descarta o conjunto reconhecido se ele fecha em zero.
  const net = [...reconhecidas].reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
  const aplica = reconhecidas.size > 0 && Math.abs(net) < 0.005
  // 3) Monta o em aberto.
  const abertos = []
  for (const l of lanc) {
    if (baixados && baixados.has(l)) continue // conciliado no automático (NF+valor+bloco) — nunca arrasta
    if (Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0)) < 0.005) continue
    if (aplica && reconhecidas.has(l)) continue // baixa manual que ZEROU — sai do arrasto
    abertos.push(l)
  }
  return abertos
}
