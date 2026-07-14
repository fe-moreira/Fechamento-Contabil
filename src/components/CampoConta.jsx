import { useEffect, useRef, useState } from 'react'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Campo de conta com seletor do plano de contas. Aperte F4 (ou clique na lupa) para
// abrir o plano e escolher a conta. value = código; onChange(cod); onPick(conta) opcional.
export default function CampoConta({ value, onChange, onPick, placeholder = 'Código (F4 = plano)', autoFocus, style, onEnter, onBlur, inputRef, plano: planoProp, mostrarNome = true }) {
  const { plano: planoCtx } = useAppData()
  const plano = planoProp || planoCtx
  const [aberto, setAberto] = useState(false)
  // Nome da conta correspondente ao código digitado — mostra "· nome" para conferir na hora.
  const val = String(value ?? '').trim()
  const achado = val ? (plano || []).find(p => String(p.cod) === val) : null
  return (
    <div style={{ position: 'relative', ...style }}>
      <div style={{ position: 'relative' }}>
        <input
          className="input" value={value || ''} autoFocus={autoFocus} ref={inputRef}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'F4') { e.preventDefault(); setAberto(true) } else if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter() } }}
          onBlur={() => onBlur && onBlur()}
          placeholder={placeholder}
          style={{ paddingRight: 30, width: '100%' }}
        />
        <i className="ti ti-table" title="Abrir plano de contas (F4)" onClick={() => setAberto(true)}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: theme.sub, cursor: 'pointer', fontSize: 16 }} />
      </div>
      {mostrarNome && achado && <div title={achado.nome} style={{ fontSize: 10.5, color: theme.green, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {achado.nome}</div>}
      {aberto && (
        <PlanoPicker plano={plano} onClose={() => setAberto(false)}
          onSelecionar={p => { onChange(p.cod); onPick && onPick(p); setAberto(false) }} />
      )}
    </div>
  )
}

function PlanoPicker({ plano, onSelecionar, onClose }) {
  const [q, setQ] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const termo = baixa(q)
  const lista = (plano || []).filter(p =>
    !termo || baixa(p.cod).includes(termo) || baixa(p.nome).includes(termo) || baixa(p.classif).includes(termo)
  ).slice(0, 300)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 80 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px,96vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, margin: 0 }}><i className="ti ti-table" style={{ color: theme.accent, marginRight: 6 }} />Plano de contas</h3>
            <i className="ti ti-x" onClick={onClose} style={{ cursor: 'pointer', color: theme.sub }} />
          </div>
          <input ref={ref} className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por código, classificação ou nome…"
            onKeyDown={e => { if (e.key === 'Enter' && lista[0]) onSelecionar(lista[0]); if (e.key === 'Escape') onClose() }} />
        </div>
        <div style={{ overflowY: 'auto' }}>
          {(plano || []).length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 16px' }}>Plano de contas não importado para este cliente.</p>
          ) : lista.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 16px' }}>Nada encontrado.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {lista.map((p, i) => (
                  <tr key={i} onClick={() => onSelecionar(p)}
                    style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', fontWeight: p.sintetica ? 700 : 400 }}>
                    <td style={{ padding: '9px 14px', fontSize: 11.5, color: theme.sub, whiteSpace: 'nowrap', width: 70 }}>{p.cod}</td>
                    <td style={{ padding: '9px 8px', fontSize: 11.5, color: theme.sub, whiteSpace: 'nowrap' }}>{p.classif}</td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: theme.text }}>{p.nome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '8px 16px', borderTop: `0.5px solid ${theme.cb}`, color: theme.sub, fontSize: 11.5 }}>
          Enter seleciona o primeiro · Esc fecha · {lista.length} conta(s)
        </div>
      </div>
    </div>
  )
}
