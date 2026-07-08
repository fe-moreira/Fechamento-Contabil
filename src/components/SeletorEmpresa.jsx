import { useEffect, useRef, useState } from 'react'
import { useAppData } from '../lib/appData'

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Seletor de empresa com busca: clica → abre a lista + campo para filtrar por
// nome (razão social) ou código no Domínio.
export default function SeletorEmpresa() {
  const { empresas, empresaId, setEmpresaId, empresaNome } = useAppData()
  const [aberto, setAberto] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setAberto(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    if (aberto) { setQ(''); const t = setTimeout(() => inputRef.current?.focus(), 10); return () => clearTimeout(t) }
  }, [aberto])

  const filtradas = empresas.filter(e => {
    if (!q.trim()) return true
    const t = norm(q)
    const qd = q.replace(/\D/g, '')
    return norm(e.razao_social).includes(t) || norm(e.codigo_dominio).includes(t)
      || (qd.length >= 2 && String(e.cnpj || '').replace(/\D/g, '').includes(qd))
  })

  function escolher(id) { setEmpresaId(id); setAberto(false) }

  const empSel = empresas.find(e => e.id === empresaId)

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      {/* Card clicável */}
      <div onClick={() => setAberto(a => !a)}
        style={{ background: '#222B3D', borderRadius: 10, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
        <i className="ti ti-building" style={{ color: '#8A9BBE', fontSize: 20, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: '#8A9BBE', fontSize: 11, margin: 0, lineHeight: 1.2 }}>
            Empresa{empSel && <>{' · '}{empSel.codigo_dominio || '—'}{empSel.tipo === 'Filial' ? ' · Filial' : ''}</>}
          </p>
          <p style={{ color: '#fff', fontSize: 14, fontWeight: 500, margin: '1px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {empresaNome || (empresas.length ? 'Selecione…' : 'Nenhum cliente ainda')}
          </p>
        </div>
        <i className={`ti ti-chevron-${aberto ? 'up' : 'down'}`} style={{ color: '#8A9BBE', fontSize: 16, flexShrink: 0 }} />
      </div>

      {/* Painel com busca + lista */}
      {aberto && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: '#222B3D', border: '1px solid #2A3758', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.45)', zIndex: 60, overflow: 'hidden' }}>
          <div style={{ padding: 8, borderBottom: '1px solid #2A3758' }}>
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Buscar por nome ou código…"
              onKeyDown={e => { if (e.key === 'Enter' && filtradas[0]) escolher(filtradas[0].id); if (e.key === 'Escape') setAberto(false) }}
              style={{ width: '100%', background: '#161B29', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, padding: '8px 10px', color: '#E8EAF0', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {empresas.length === 0 ? (
              <p style={{ color: '#8A9BBE', fontSize: 12.5, padding: '12px' }}>Nenhum cliente cadastrado ainda.</p>
            ) : filtradas.length === 0 ? (
              <p style={{ color: '#8A9BBE', fontSize: 12.5, padding: '12px' }}>Nada encontrado para “{q}”.</p>
            ) : filtradas.map(e => {
              const sel = e.id === empresaId
              return (
                <div key={e.id} onClick={() => escolher(e.id)}
                  style={{ padding: '9px 12px', cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'flex-start', background: sel ? 'rgba(74,124,255,0.16)' : 'transparent' }}
                  onMouseEnter={ev => { ev.currentTarget.style.background = '#2A3758' }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = sel ? 'rgba(74,124,255,0.16)' : 'transparent' }}>
                  <span style={{ color: '#8A9BBE', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: 40, flexShrink: 0, marginTop: 1 }}>{e.codigo_dominio || '—'}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ color: '#E8EAF0', fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.razao_social}</span>
                    {(e.cnpj || e.tipo === 'Filial') && (
                      <span style={{ color: '#8A9BBE', fontSize: 11, display: 'block', marginTop: 1 }}>
                        {e.tipo === 'Filial' ? 'Filial' : 'Matriz'}{e.cnpj ? ` · ${e.cnpj}` : ''}
                      </span>
                    )}
                  </div>
                  {sel && <i className="ti ti-check" style={{ color: '#4A7CFF', fontSize: 15, marginLeft: 'auto', flexShrink: 0 }} />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
