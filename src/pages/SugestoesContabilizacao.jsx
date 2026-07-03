import { useState } from 'react'
import { theme, money } from '../lib/theme'
import { useAppData } from '../lib/appData'

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// Sugestões que a plataforma extrai do razão (evidência → partida → confirmar/excluir).
const SUGESTOES = [
  { id: 's1', icon: 'ti-arrows-exchange', cor: '#4A7CFF', t: 'Baixar adiantamento de fornecedor — Metalúrgica Sul', w: 'NF 4471 de R$ 12.000 lançada este mês bate com o adiantamento de R$ 12.000 pago em jun/26.', p: 'D 2.1.1.05 Fornecedor Metalúrgica Sul · C 1.1.5.02 Adiant. a fornecedores', v: 12000, conf: 97 },
  { id: 's2', icon: 'ti-arrows-exchange', cor: '#4A7CFF', t: 'Baixar adiantamento de cliente — Rodobens', w: 'NF de saída 8890 de R$ 8.500 bate com o adiantamento recebido do cliente em jun/26.', p: 'D 2.1.4.01 Adiant. de clientes · C 1.1.2.01 Clientes a receber', v: 8500, conf: 95 },
  { id: 's3', icon: 'ti-coin', cor: '#30A46C', t: 'Rendimento de aplicação financeira — Itaú', w: 'Extrato mostra rendimento de R$ 1.240 no mês, sem lançamento no razão.', p: 'D 1.1.1.20 Aplicações financeiras · C 3.2.1.01 Receita financeira', v: 1240, conf: 99 },
  { id: 's4', icon: 'ti-file-invoice', cor: '#F5A623', t: 'Baixa de ICMS recolhido (mês anterior)', w: 'ICMS de jun/26 (R$ 5.300) foi debitado do banco em 10/jul — a conta a recolher continua aberta.', p: 'D 2.1.3.01 ICMS a recolher · C 1.1.1.02 Banco Itaú', v: 5300, conf: 98 },
  { id: 's5', icon: 'ti-building-warehouse', cor: '#9A7CF0', t: 'Depreciação mensal do imobilizado', w: 'Imobilizado com base de cálculo ativa e sem depreciação lançada em julho.', p: 'D 4.1.3.01 Depreciação · C 1.2.3.09 Depreciação acumulada', v: 3180, conf: 92 },
]

export default function SugestoesContabilizacao() {
  const { empresaNome, competencia } = useAppData()
  const [estado, setEstado] = useState({}) // id -> 'ok' | 'no'
  const set = (id, v) => setEstado(e => ({ ...e, [id]: v }))
  const confirmarTodas = () => setEstado(e => { const n = { ...e }; SUGESTOES.forEach(s => { if (!n[s.id]) n[s.id] = 'ok' }); return n })
  const pend = SUGESTOES.filter(s => !estado[s.id]).length

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Sugestões de Contabilização</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18, maxWidth: 820 }}>
        A plataforma varre o <b style={{ color: theme.text }}>razão</b> da competência e aponta o que precisa ser lançado ou corrigido — cada sugestão traz a evidência que a gerou. O que você confirmar <b style={{ color: theme.text }}>atualiza a Conciliação</b> e alimenta o Status → Domínio. O que excluir sai da lista.
        {empresaNome && <> · <b style={{ color: theme.text }}>{empresaNome}</b> · {competencia}</>}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: theme.sub }}><b style={{ color: theme.text }}>{pend} sugest{pend === 1 ? 'ão' : 'ões'}</b> a tratar</span>
        <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={confirmarTodas}><i className="ti ti-checks" /> Confirmar todas</button>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {SUGESTOES.map(s => {
          const st = estado[s.id]
          return (
            <div key={s.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderLeft: `3px solid ${s.cor}`, borderRadius: 12, padding: '14px 16px', display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 14, alignItems: 'center', opacity: st ? 0.72 : 1 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, background: hexA(s.cor, 0.16), color: s.cor }}><i className={`ti ${s.icon}`} /></div>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: 14 }}>{s.t}</b>
                <div style={{ fontSize: 12.5, color: theme.sub, margin: '4px 0 6px' }}><i className="ti ti-bulb" style={{ color: theme.yellow }} /> {s.w}</div>
                <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, color: theme.sub, background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>{s.p}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
                <b style={{ fontVariantNumeric: 'tabular-nums', fontSize: 15 }}>{money(s.v)}</b>
                <span style={{ fontSize: 10.5, fontWeight: 600, color: s.conf >= 95 ? theme.green : theme.yellow }}>confiança {s.conf}%</span>
                {!st ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn" style={{ fontSize: 12, padding: '6px 11px' }} onClick={() => set(s.id, 'ok')}><i className="ti ti-check" /> Confirmar</button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 9px' }} title="Editar"><i className="ti ti-pencil" /></button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 9px' }} title="Descartar" onClick={() => set(s.id, 'no')}><i className="ti ti-x" /></button>
                  </div>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: st === 'ok' ? theme.green : theme.red }}>{st === 'ok' ? '✓ confirmado' : '✕ descartado'}</span>
                    <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => set(s.id, null)}><i className="ti ti-rotate" /> reabrir</button>
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
