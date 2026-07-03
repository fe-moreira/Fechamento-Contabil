import { useRef, useState } from 'react'
import { theme } from '../lib/theme'
import { lerDocumento } from '../lib/outras'

// Botão "Ler documento (IA)": recebe um PDF/imagem, extrai os campos pelo
// tipo do bloco e devolve o objeto para pré-preencher o formulário (onExtraido).
export default function LeitorIA({ tipo, onExtraido, acento = theme.accent }) {
  const ref = useRef(null)
  const [lendo, setLendo] = useState(false)
  const [msg, setMsg] = useState(null) // { erro?:bool, txt:string }

  async function escolher(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // permite reenviar o mesmo arquivo
    if (!file) return
    setLendo(true); setMsg(null)
    try {
      const dados = await lerDocumento(tipo, file)
      const n = Object.values(dados).filter(v => v !== '' && v !== 0 && v != null).length
      onExtraido?.(dados)
      setMsg({ txt: n ? `Documento lido — ${n} campo(s) preenchido(s). Confira antes de salvar.` : 'Documento lido, mas nenhum campo foi identificado.' })
    } catch (er) {
      setMsg({ erro: true, txt: er.message })
    } finally { setLendo(false) }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <input ref={ref} type="file" accept="application/pdf,image/*" onChange={escolher} style={{ display: 'none' }} />
      <button type="button" className="btn btn-ghost" disabled={lendo} onClick={() => ref.current?.click()}
        style={{ fontSize: 12.5, padding: '6px 12px', borderColor: acento, color: acento }}>
        <i className={`ti ${lendo ? 'ti-loader-2' : 'ti-sparkles'}`} /> {lendo ? 'Lendo documento…' : 'Ler documento (IA)'}
      </button>
      {msg && (
        <span style={{ fontSize: 12, color: msg.erro ? theme.red : theme.sub, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <i className={`ti ${msg.erro ? 'ti-alert-circle' : 'ti-check'}`} /> {msg.txt}
        </span>
      )}
    </div>
  )
}
