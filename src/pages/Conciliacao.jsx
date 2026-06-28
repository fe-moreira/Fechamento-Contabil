import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'

// Classifica o farol da conta a partir do saldo final.
function farolDe(saldo) {
  const v = Number(saldo) || 0
  if (v === 0) return { cor: theme.green, label: 'Conciliado' }
  if (Math.abs(v) < 1000) return { cor: theme.yellow, label: 'Atenção' }
  return { cor: theme.red, label: 'Precisa conciliar' }
}

export default function Conciliacao() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [linhas, setLinhas] = useState([])
  const [carregando, setCarregando] = useState(false)
  const [semComp, setSemComp] = useState(false)
  const [erro, setErro] = useState('')
  const [hover, setHover] = useState(null)

  useEffect(() => {
    setLinhas([]); setSemComp(false); setErro('')
    if (!empresaId) return
    let vivo = true
    setCarregando(true)
    ;(async () => {
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setSemComp(true); setCarregando(false); return }
        const { data, error } = await supabase.from('balancete')
          .select('conta, nome, saldo_final')
          .eq('competencia_id', comp.id)
          .order('conta', { ascending: true })
        if (!vivo) return
        if (error) throw error
        setLinhas(data || [])
      } catch (err) {
        if (vivo) setErro('Erro ao carregar o balancete: ' + err.message)
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." />
      </Wrapper>
    )
  }

  const total = linhas.length
  const conciliadas = linhas.filter(l => (Number(l.saldo_final) || 0) === 0).length
  const pendencias = linhas.filter(l => Math.abs(Number(l.saldo_final) || 0) >= 1000).length
  const somaSaldos = linhas.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)

  const vazio = !carregando && (semComp || linhas.length === 0)

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>{erro}</p>}

      {carregando && (
        <p style={{ color: theme.sub, fontSize: 13 }}><i className="ti ti-loader" /> Carregando…</p>
      )}

      {vazio && (
        <Aviso icon="ti-file-off" texto="Nenhum dado para esta competência. Importe o razão primeiro." />
      )}

      {!carregando && !vazio && (
        <>
          {/* Cards de resumo */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 14, marginBottom: 18 }}>
            <Card titulo="Total de contas" valor={total} />
            <Card titulo="Conciliadas" valor={conciliadas} cor={theme.green} />
            <Card titulo="Com pendência" valor={pendencias} cor={theme.red} />
            <Card titulo="Soma dos saldos finais" valor={money(somaSaldos)} />
          </div>

          {/* Legenda do farol */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', marginBottom: 14, fontSize: 12.5, color: theme.sub }}>
            <span><Dot cor={theme.green} /> Conciliado (saldo final = 0)</span>
            <span><Dot cor={theme.yellow} /> Atenção (|saldo| &lt; {money(1000)})</span>
            <span><Dot cor={theme.red} /> Precisa conciliar (|saldo| ≥ {money(1000)})</span>
          </div>

          {/* Tabela */}
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Conta</th>
                  <th style={th}>Nome</th>
                  <th style={{ ...th, textAlign: 'right' }}>Saldo final</th>
                  <th style={{ ...th, textAlign: 'center' }}>Farol</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => {
                  const f = farolDe(l.saldo_final)
                  return (
                    <tr key={i}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(null)}
                      style={{ borderTop: `1px solid ${theme.border}`, background: hover === i ? theme.input : 'transparent' }}>
                      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{l.conta}</td>
                      <td style={td}>{l.nome || '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(l.saldo_final)}</td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: f.cor }}>
                          <Dot cor={f.cor} /> {f.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const td = { padding: '10px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Conciliação</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Conciliação das contas do balancete por competência, com farol verde/amarelo/vermelho.</p>
      {children}
    </div>
  )
}

function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}

function Card({ titulo, valor, cor }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '16px 18px' }}>
      <p style={{ color: theme.sub, fontSize: 12, marginBottom: 6 }}>{titulo}</p>
      <p style={{ fontSize: 22, fontWeight: 700, color: cor || theme.text }}>{valor}</p>
    </div>
  )
}

function Dot({ cor }) {
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: cor, verticalAlign: 'middle' }} />
}
