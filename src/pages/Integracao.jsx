import { useState } from 'react'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'

// Pipeline pré-razão (integração financeira via Excel): importa o extrato e separa
// em "contabilizado automaticamente" × "não identificado". A classificação automática
// (de/para, regras) e o "gerar arquivo financeiro" entram nas próximas ondas.
export default function Integracao() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [linhas, setLinhas] = useState([])
  const [arquivo, setArquivo] = useState('')
  const [erro, setErro] = useState('')

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral para usar a integração." />
      </Wrapper>
    )
  }

  async function aoEscolher(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setErro(''); setArquivo(file.name)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(ev.target.result, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
        const dados = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 200)
        setLinhas(dados)
      } catch (err) { setErro('Não consegui ler o arquivo: ' + err.message) }
    }
    reader.readAsArrayBuffer(file)
  }

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <label style={{ fontSize: 13, color: theme.text, marginBottom: 10 }}>Extrato financeiro (.xlsx, .xls, .csv)</label>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} style={{ display: 'block', marginTop: 8, fontSize: 13, color: theme.sub }} />
        {arquivo && <p style={{ fontSize: 12.5, color: theme.sub, marginTop: 10 }}><i className="ti ti-file-spreadsheet" /> {arquivo} — {linhas.length} linha(s)</p>}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>{erro}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Balde titulo="Contabilizado automaticamente" cor={theme.green} icon="ti-circle-check"
          vazio="A classificação automática (de/para) entra na próxima onda." linhas={[]} />
        <Balde titulo="Não identificado" cor={theme.yellow} icon="ti-alert-triangle"
          vazio="Importe um extrato para listar os lançamentos a classificar." linhas={linhas} />
      </div>

      <button className="btn btn-ghost" disabled style={{ marginTop: 18, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-file-export" /> Gerar arquivo financeiro (em breve)
      </button>
    </Wrapper>
  )
}

function Balde({ titulo, cor, icon, vazio, linhas }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${theme.border}` }}>
        <i className={`ti ${icon}`} style={{ color: cor }} />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{titulo}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.sub }}>{linhas.length}</span>
      </div>
      {linhas.length === 0 ? (
        <p style={{ padding: 18, color: theme.sub, fontSize: 12.5 }}>{vazio}</p>
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {linhas.map((l, i) => (
            <div key={i} style={{ padding: '9px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12.5, color: theme.text, display: 'flex', gap: 12 }}>
              {l.slice(0, 4).map((c, j) => (
                <span key={j} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: typeof c === 'number' ? 'right' : 'left', color: typeof c === 'number' ? theme.text : theme.sub }}>
                  {typeof c === 'number' ? money(c) : String(c ?? '')}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Integração</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Pipeline financeiro pré-razão: importa o extrato e separa o que está contabilizado do que falta identificar.</p>
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
