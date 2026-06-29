import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

// Chave estável de uma célula (conta × mês) para o set de justificadas.
const chaveCelula = (conta, mes) => `${conta}|${mes}`

// Tokens significativos do histórico (para detectar recorrência nos meses anteriores).
const STOP = new Set(['VENDA', 'VENDAS', 'COMPRA', 'COMPRAS', 'PAGTO', 'PAGAMENTO', 'RECEB', 'RECEBIMENTO', 'NOTA', 'FISCAL', 'VALOR', 'REFERENTE', 'REF', 'DUPLICATA', 'PARCELA', 'CONTA'])
function tokens(h) {
  return String(h || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
}

// Aponta o(s) lançamento(s) provável(is) culpado(s) da variação, com motivo.
function analisarCulpados(linhas, historicosAnteriores) {
  const vals = linhas.map(l => (Number(l.debito) || 0) + (Number(l.credito) || 0))
  const positivos = vals.filter(v => v > 0)
  const maxV = positivos.length ? Math.max(...positivos) : 0
  const ord = [...positivos].sort((a, b) => a - b)
  const mediana = ord.length ? ord[Math.floor(ord.length / 2)] : 0
  const tokensAnt = new Set()
  for (const h of historicosAnteriores) for (const t of tokens(h)) tokensAnt.add(t)

  return linhas.map((l, i) => {
    const v = vals[i]
    const h = (l.historico || '').toUpperCase()
    const motivos = []
    if (v > 0 && v === maxV && mediana > 0 && v >= mediana * 3) motivos.push('valor fora do padrão mensal desta conta')
    const palavras = h.replace(/[^A-ZÀ-Ú ]/g, ' ').split(/\s+/).filter(Boolean)
    if (h.includes('?') || /\b(DIVERSOS?|DIVERSA|AVULS[OA]|OUTR[OA]S?|GERAL|V[AÁ]RIOS)\b/.test(h) || palavras.length <= 1) motivos.push('histórico genérico')
    const ht = tokens(l.historico)
    if (ht.length && tokensAnt.size && !ht.some(t => tokensAnt.has(t))) motivos.push('não recorre nos meses anteriores')
    return { ...l, suspeito: motivos.length > 0, motivo: motivos.join(' · ') }
  })
}

export default function CompMovimento() {
  const { empresaId, empresaNome, getCompetenciaId } = useAppData()
  const { user } = useAuth()

  const [carregando, setCarregando] = useState(false)
  const [comps, setComps] = useState([])        // [{ id, mes }] dos meses com balancete
  const [contas, setContas] = useState([])      // [{ conta, nome }] união de contas
  const [matriz, setMatriz] = useState({})      // { conta: { mes: saldo_final } }
  const [detalhe, setDetalhe] = useState(null)  // { conta, nome, mes, compId }
  const [justificadas, setJustificadas] = useState(() => new Set()) // 'conta|mes' já justificadas/corrigidas localmente

  useEffect(() => {
    setComps([]); setContas([]); setMatriz({}); setDetalhe(null); setJustificadas(new Set())
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const { data: competencias } = await supabase
          .from('competencias').select('id, mes')
          .eq('cliente_id', empresaId).eq('ano', ANO)
          .order('mes', { ascending: true })

        if (!vivo) return
        if (!competencias || !competencias.length) { setCarregando(false); return }

        const compsComDados = []
        const nomesPorConta = {}
        const m = {}

        for (const c of competencias) {
          const { data: bal } = await supabase
            .from('balancete').select('conta, nome, saldo_final')
            .eq('competencia_id', c.id)
          if (!vivo) return
          if (!bal || !bal.length) continue

          compsComDados.push({ id: c.id, mes: c.mes })
          for (const b of bal) {
            if (!b.conta) continue
            // Comparativo de movimento trata só Receita (3), Custos (4) e Despesas (5).
            const d = String(b.conta).trim()[0]
            if (d !== '3' && d !== '4' && d !== '5') continue
            if (!m[b.conta]) m[b.conta] = {}
            m[b.conta][c.mes] = Number(b.saldo_final) || 0
            if (b.nome && !nomesPorConta[b.conta]) nomesPorConta[b.conta] = b.nome
          }
        }

        if (!vivo) return
        const listaContas = Object.keys(m)
          .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
          .map(conta => ({ conta, nome: nomesPorConta[conta] || '' }))

        setComps(compsComDados)
        setContas(listaContas)
        setMatriz(m)

        // Pré-carrega justificativas/correções já registradas na auditoria deste módulo,
        // para o contador refletir o que já foi tratado em sessões anteriores.
        const compIds = compsComDados.map(c => c.id)
        if (compIds.length) {
          const { data: audits } = await supabase
            .from('auditoria').select('item, competencia_id')
            .in('competencia_id', compIds).eq('modulo', 'Comparativo')
          if (!vivo) return
          if (audits && audits.length) {
            const mesPorComp = {}
            for (const c of compsComDados) mesPorComp[c.id] = c.mes
            const set = new Set()
            for (const a of audits) {
              // item no formato `${conta} · ${MES}/${ano}` — extrai a conta e usa o mês da competência.
              const conta = String(a.item || '').split(' · ')[0].trim()
              const mes = mesPorComp[a.competencia_id]
              if (conta && mes) set.add(chaveCelula(conta, mes))
            }
            setJustificadas(set)
          }
        }
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId])

  // Uma célula desvia se difere mais de 10% da média da conta nos meses carregados.
  function desviante(conta, valor) {
    const linha = matriz[conta] || {}
    const valores = comps.map(c => linha[c.mes]).filter(v => v != null)
    if (valores.length < 2) return false
    const media = valores.reduce((s, v) => s + v, 0) / valores.length
    if (media === 0) return valor !== 0
    return Math.abs(valor - media) / Math.abs(media) > 0.1
  }

  // Conta as células desviantes (vermelhas) ainda não justificadas/corrigidas.
  let pendentes = 0
  for (const { conta } of contas) {
    const linha = matriz[conta] || {}
    for (const c of comps) {
      const v = linha[c.mes]
      if (v == null) continue
      if (desviante(conta, v) && !justificadas.has(chaveCelula(conta, c.mes))) pendentes++
    }
  }

  // Marca uma célula como justificada/corrigida localmente (atualiza o contador na hora).
  function marcarJustificada(conta, mes) {
    setJustificadas(prev => {
      const next = new Set(prev)
      next.add(chaveCelula(conta, mes))
      return next
    })
  }

  if (!empresaId) {
    return (
      <Wrapper>
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
          <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Selecione uma empresa no menu lateral.</p>
        </div>
      </Wrapper>
    )
  }

  const semDados = !carregando && comps.length === 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · ano <b style={{ color: theme.text }}>{ANO}</b>
      </p>

      {carregando && (
        <p style={{ color: theme.sub, fontSize: 13 }}><i className="ti ti-loader" /> Carregando balancetes…</p>
      )}

      {semDados && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 620 }}>
          <i className="ti ti-table-off" style={{ fontSize: 24, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Nenhum balancete importado ainda. Importe o razão em ao menos uma competência.</p>
        </div>
      )}

      {!carregando && comps.length > 0 && (
        <>
          <div style={{ marginBottom: 14 }}>
            {pendentes > 0 ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                background: 'rgba(229,72,77,0.12)', color: theme.red,
                border: `0.5px solid ${theme.red}`, borderRadius: 999,
                padding: '6px 13px', fontSize: 12.5, fontWeight: 600,
              }}>
                <i className="ti ti-alert-triangle" />
                {pendentes} variação(ões) a justificar
              </span>
            ) : (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                background: 'rgba(48,164,108,0.12)', color: theme.green,
                border: `0.5px solid ${theme.green}`, borderRadius: 999,
                padding: '6px 13px', fontSize: 12.5, fontWeight: 600,
              }}>
                <i className="ti ti-circle-check" />
                Tudo dentro da faixa ou justificado
              </span>
            )}
          </div>
          <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
            Contas de resultado (Receita, Custos e Despesas). Valores em <b style={{ color: theme.red }}>vermelho</b> desviam mais de 10% da média da conta nos meses carregados. Clique em um valor para ver o razão da conta no mês.
          </p>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={{ ...th, position: 'sticky', left: 0, background: theme.input, minWidth: 220 }}>Conta</th>
                  {comps.map(c => (
                    <th key={c.mes} style={{ ...th, textAlign: 'right' }}>{MESES[c.mes - 1]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contas.map(({ conta, nome }) => {
                  const linha = matriz[conta] || {}
                  return (
                    <tr key={conta} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, position: 'sticky', left: 0, background: theme.card, maxWidth: 260 }}>
                        <span style={{ color: theme.text }}>{conta}</span>
                        {nome && <span style={{ color: theme.sub }}> · {nome}</span>}
                      </td>
                      {comps.map(c => {
                        const v = linha[c.mes]
                        if (v == null) return <td key={c.mes} style={{ ...td, textAlign: 'right' }} />
                        const red = desviante(conta, v)
                        const ok = red && justificadas.has(chaveCelula(conta, c.mes))
                        return (
                          <td key={c.mes} style={{ ...td, textAlign: 'right' }}>
                            <button
                              onClick={() => setDetalhe({ conta, nome, mes: c.mes, compId: c.id })}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontSize: 12.5, fontFamily: 'inherit',
                                color: red ? theme.red : theme.text,
                                fontWeight: red ? 700 : 400,
                              }}
                              title={ok ? 'Variação justificada — ver razão da conta neste mês' : 'Ver razão da conta neste mês'}
                            >
                              {ok && <i className="ti ti-circle-check" style={{ color: theme.green, fontSize: 13 }} />}
                              {money(v)}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {detalhe && (
        <ModalRazao
          detalhe={detalhe}
          compsAnteriores={comps.filter(c => c.mes < detalhe.mes).map(c => c.id)}
          usuario={user?.email}
          getCompetenciaId={getCompetenciaId}
          jaJustificada={justificadas.has(chaveCelula(detalhe.conta, detalhe.mes))}
          onJustificada={() => marcarJustificada(detalhe.conta, detalhe.mes)}
          onClose={() => setDetalhe(null)}
        />
      )}
    </Wrapper>
  )
}

function ModalRazao({ detalhe, compsAnteriores, usuario, getCompetenciaId, jaJustificada, onJustificada, onClose }) {
  const { conta, nome, mes, compId } = detalhe
  const [carregando, setCarregando] = useState(true)
  const [linhas, setLinhas] = useState([])
  const [registro, setRegistro] = useState(null) // 'Justificativa' | 'Correção'
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState('')

  async function registrar(tipo, detalheTxt) {
    setSalvando(true)
    try {
      const competencia_id = await getCompetenciaId()
      const { error } = await supabase.from('auditoria').insert({
        competencia_id,
        modulo: 'Comparativo',
        item: `${conta} · ${MESES[mes - 1]}/${ANO}`,
        tipo,
        detalhe: detalheTxt,
        usuario,
      })
      if (error) throw error
      setMsg(`${tipo} registrada na auditoria.`)
      setRegistro(null)
      onJustificada()
    } catch (e) {
      setMsg('Erro ao registrar: ' + (e.message || e))
    } finally {
      setSalvando(false)
    }
  }

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCarregando(true)
      const { data } = await supabase
        .from('razao').select('data, conta, historico, debito, credito')
        .eq('competencia_id', compId).eq('conta', conta)
        .order('data', { ascending: true })
      let anteriores = []
      if (compsAnteriores && compsAnteriores.length) {
        const { data: ant } = await supabase.from('razao').select('historico')
          .in('competencia_id', compsAnteriores).eq('conta', conta)
        anteriores = (ant || []).map(r => r.historico)
      }
      if (!vivo) return
      setLinhas(analisarCulpados(data || [], anteriores))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [compId, conta]) // eslint-disable-line react-hooks/exhaustive-deps

  let saldo = 0
  const totDeb = linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)
  const suspeitos = linhas.filter(l => l.suspeito)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>Razão — conta {conta}</h3>
            <p style={{ color: theme.sub, fontSize: 12.5 }}>
              {nome ? `${nome} · ` : ''}{MESES[mes - 1]}/{ANO}
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-x" /> Fechar
          </button>
        </div>

        {!carregando && suspeitos.length > 0 && (
          <div style={{ margin: '14px 22px 0', background: 'rgba(245,166,35,0.10)', border: '1px solid rgba(245,166,35,0.4)', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ color: theme.yellow, fontSize: 13, fontWeight: 600, margin: 0 }}>
              <i className="ti ti-alert-triangle" /> {suspeitos.length} lançamento(s) provável(is) culpado(s) desta variação
            </p>
            <p style={{ color: theme.sub, fontSize: 12, margin: '4px 0 0' }}>Destacados abaixo. Use “Corrigir” para reclassificar, ou “Justificar” se a variação é esperada.</p>
          </div>
        )}

        <div style={{ overflow: 'auto', padding: '0 0 4px' }}>
          {carregando ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}><i className="ti ti-loader" /> Carregando…</p>
          ) : linhas.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}>Nenhum lançamento de razão para esta conta neste mês.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Data</th>
                  <th style={th}>Histórico</th>
                  <th style={{ ...th, textAlign: 'right' }}>Débito</th>
                  <th style={{ ...th, textAlign: 'right' }}>Crédito</th>
                  <th style={{ ...th, textAlign: 'right' }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => {
                  saldo += (Number(l.debito) || 0) - (Number(l.credito) || 0)
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: l.suspeito ? 'rgba(245,166,35,0.07)' : undefined }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                      <td style={{ ...td, maxWidth: 380, whiteSpace: 'normal' }}>
                        {l.suspeito && <i className="ti ti-alert-triangle" style={{ color: theme.yellow, marginRight: 6 }} title="Provável culpado" />}
                        {l.historico || ''}
                        {l.suspeito && <div style={{ color: theme.yellow, fontSize: 11, marginTop: 2 }}>provável culpado — {l.motivo}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{Number(l.debito) ? money(l.debito) : ''}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{Number(l.credito) ? money(l.credito) : ''}</td>
                      <td style={{ ...td, textAlign: 'right', color: saldo < 0 ? theme.red : theme.text }}>{money(saldo)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totDeb)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totCred)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totDeb - totCred)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div style={{ borderTop: `0.5px solid ${theme.cb}`, padding: '14px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, minHeight: 16, color: msg ? (msg.startsWith('Erro') ? theme.red : theme.green) : theme.sub }}>
            {msg
              ? <><i className={`ti ${msg.startsWith('Erro') ? 'ti-alert-triangle' : 'ti-circle-check'}`} /> {msg}</>
              : jaJustificada
                ? <><i className="ti ti-circle-check" style={{ color: theme.green }} /> Variação já tratada na auditoria.</>
                : 'Justifique ou corrija esta variação — fica registrada na auditoria.'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setMsg(''); setRegistro('Justificativa') }}>
              <i className="ti ti-flag" /> Justificar
            </button>
            <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setMsg(''); setRegistro('Correção') }}>
              <i className="ti ti-pencil-bolt" /> Corrigir
            </button>
          </div>
        </div>
      </div>

      {registro && (
        <ModalRegistro
          tipo={registro}
          salvando={salvando}
          conta={conta}
          mes={mes}
          onClose={() => setRegistro(null)}
          onConfirmar={txt => registrar(registro, txt)}
        />
      )}
    </div>
  )
}

function ModalRegistro({ tipo, salvando, conta, mes, onClose, onConfirmar }) {
  const [txt, setTxt] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          Conta <b style={{ color: theme.text }}>{conta}</b> · {MESES[mes - 1]}/{ANO}. Fica registrada na auditoria com seu usuário e a data.
        </p>
        <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus
          placeholder={tipo === 'Correção' ? 'O que foi corrigido (ex.: reclassificação, lançamento ajustado)…' : 'Por que esta variação é esperada…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && onConfirmar(txt.trim())} disabled={salvando || !txt.trim()}>
            {salvando ? 'Registrando…' : 'Registrar'}
          </button>
        </div>
      </div>
    </div>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Comp. Movimento</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Comparativo mês a mês do ano: saldos de cada conta ao longo das competências, destacando variações relevantes.
      </p>
      {children}
    </div>
  )
}
