import { useState } from 'react'
import { theme } from '../lib/theme'

// Área de upload: arraste o arquivo ou clique para escolher. Chama onArquivo(file).
export default function DropZone({ onArquivo, disabled, accept = '.xlsx,.xls,.csv', hint }) {
  const [over, setOver] = useState(false)
  const pega = (file) => { if (file && !disabled) onArquivo(file) }
  return (
    <label
      onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); pega(e.dataTransfer.files?.[0]) }}
      style={{
        display: 'block', textAlign: 'center', borderRadius: 10, padding: '20px 14px',
        border: `1.5px dashed ${over ? theme.accent : 'rgba(255,255,255,0.18)'}`,
        background: over ? 'rgba(74,124,255,0.08)' : theme.input,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .55 : 1, transition: 'all .15s',
      }}
    >
      <input type="file" accept={accept} disabled={disabled} style={{ display: 'none' }}
        onChange={e => { pega(e.target.files?.[0]); e.target.value = '' }} />
      <i className="ti ti-cloud-upload" style={{ fontSize: 26, color: theme.accent }} />
      <p style={{ fontSize: 13, color: theme.text, margin: '8px 0 2px' }}>
        Arraste o arquivo aqui ou <b style={{ color: theme.accent }}>clique para escolher</b>
      </p>
      <p style={{ fontSize: 11.5, color: theme.sub, margin: 0 }}>{hint || '.xlsx, .xls ou .csv'}</p>
    </label>
  )
}
