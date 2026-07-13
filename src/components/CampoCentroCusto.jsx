import { useEffect, useRef, useState } from 'react'
import { theme } from '../lib/theme'

const baixa = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Campo de centro de custo com seletor da lista cadastrada do cliente. Aperte F4 (ou clique
// na lupa) para buscar/escolher. value = código; onChange(cod). `centros` = [{cod, nome, resp}].
export default function CampoCentroCusto({ value, onChange, centros = [], disabled, placeholder = 'C.Custo (F4)', style, inputRef }) {
  const [aberto, setAberto] = useState(false)
  // Nome do centro correspondente ao código digitado — mostra "código · nome" para conferir.
  const val = String(value ?? '').trim()
  const achado = val ? (centros || []).find(c => String(c.cod) === val) : null
  const nome = achado?.nome || ''
  const invalido = !!val && !achado
  return (
    <div style={{ position: 'relative', ...style }}>
      <div style={{ position: 'relative' }}>
        <input
          className="input" value={value || ''} ref={inputRef} disabled={disabled}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'F4') { e.preventDefault(); if (!disabled) setAberto(true) } }}
          placeholder={placeholder}
          style={{ paddingRight: 26, fontSize: 11.5, padding: '4px 24px 4px 7px', width: 96, borderColor: invalido ? theme.red : undefined }}
        />
        <i className="ti ti-sitemap" title="Buscar centro de custo (F4)" onClick={() => !disabled && setAberto(true)}
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: theme.sub, cursor: disabled ? 'default' : 'pointer', fontSize: 14 }} />
      </div>
      {nome && <div title={nome} style={{ fontSize: 10.5, color: theme.green, marginTop: 2, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {nome}</div>}
      {invalido && <div style={{ fontSize: 10.5, color: theme.red, marginTop: 2 }}>código não encontrado</div>}
      {aberto && (
        <CentroCustoPicker centros={centros} onClose={() => setAberto(false)}
          onSelecionar={c => { onChange(c.cod); setAberto(false) }} />
      )}
    </div>
  )
}

function CentroCustoPicker({ centros, onSelecionar, onClose }) {
  const [q, setQ] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const termo = baixa(q)
  const lista = (centros || []).filter(c =>
    !termo || baixa(c.cod).includes(termo) || baixa(c.nome).includes(termo) || baixa(c.resp).includes(termo)
  ).slice(0, 300)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 90 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, margin: 0 }}><i className="ti ti-sitemap" style={{ color: theme.accent, marginRight: 6 }} />Centros de custo</h3>
            <i className="ti ti-x" onClick={onClose} style={{ cursor: 'pointer', color: theme.sub }} />
          </div>
          <input ref={ref} className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por código, nome ou responsável…"
            onKeyDown={e => { if (e.key === 'Enter' && lista[0]) onSelecionar(lista[0]); if (e.key === 'Escape') onClose() }} />
        </div>
        <div style={{ overflowY: 'auto' }}>
          {(centros || []).length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 16px' }}>Nenhum centro de custo cadastrado. Importe em Base de Informações → Centro de custo.</p>
          ) : lista.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 16px' }}>Nada encontrado.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {lista.map((c, i) => (
                  <tr key={i} onClick={() => onSelecionar(c)} style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer' }}>
                    <td style={{ padding: '9px 14px', fontSize: 12, color: theme.sub, whiteSpace: 'nowrap', width: 70 }}>{c.cod}</td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: theme.text }}>{c.nome}</td>
                    <td style={{ padding: '9px 14px', fontSize: 11.5, color: theme.sub, whiteSpace: 'nowrap' }}>{c.resp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '8px 16px', borderTop: `0.5px solid ${theme.cb}`, color: theme.sub, fontSize: 11.5 }}>
          Enter seleciona o primeiro · Esc fecha · {lista.length} centro(s)
        </div>
      </div>
    </div>
  )
}
