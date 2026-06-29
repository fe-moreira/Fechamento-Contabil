import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import DropZone from '../components/DropZone'
import { theme } from '../lib/theme'
import { money } from '../lib/theme'

const ALVOS = [
  { key: 'data', label: 'Data', dicas: ['data'] },
  { key: 'conta', label: 'Conta', dicas: ['conta', 'cód conta', 'codigo conta', 'reduzido'] },
  { key: 'contrapartida', label: 'Contrapartida', dicas: ['contrapartida', 'contra partida', 'c.partida', 'cont. partida'] },
  { key: 'historico', label: 'Histórico', dicas: ['histor', 'complemento', 'descri'] },
  { key: 'debito', label: 'Débito', dicas: ['débito', 'debito', 'valor débito', 'vlr deb'] },
  { key: 'credito', label: 'Crédito', dicas: ['crédito', 'credito', 'valor crédito', 'vlr cred'] },
]

// Converte valor pt-BR ("1.234,56") ou número para float.
function num(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  let s = String(v).trim()
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s.replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : n
}

// Converte data (Date do Excel ou "dd/mm/aaaa") para ISO "aaaa-mm-dd".
function toISO(v) {
  if (!v) return null
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) {
    let [, d, mo, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

// Acha a linha de cabeçalho: a primeira com 3+ células de texto.
function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 25); i++) {
    const textos = linhas[i].filter(c => typeof c === 'string' && c.trim().length > 1)
    if (textos.length >= 3) return i
  }
  return 0
}

function autoMapear(headers) {
  const map = {}
  for (const alvo of ALVOS) {
    const idx = headers.findIndex(h => {
      const hl = String(h || '').toLowerCase()
      if (alvo.key === 'conta') return hl.includes('conta') && !hl.includes('contra')
      return alvo.dicas.some(d => hl.includes(d))
    })
    map[alvo.key] = idx >= 0 ? String(idx) : ''
  }
  return map
}

export default function ImportarRazao() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const [headers, setHeaders] = useState([])
  const [linhas, setLinhas] = useState([])   // linhas de dados (arrays)
  const [map, setMap] = useState({})
  const [arquivo, setArquivo] = useState('')
  const [erro, setErro] = useState('')
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [jaImportado, setJaImportado] = useState(null)

  // Mostra se já há razão importado para a competência atual.
  useEffect(() => {
    setResultado(null); setJaImportado(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      const [mes, ano] = competencia.split('/').map(Number)
      const { data: comp } = await supabase.from('competencias').select('id')
        .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      if (!comp || !vivo) return
      const { count } = await supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
      if (vivo && count) setJaImportado(count)
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  function aoEscolherArquivo(file) {
    if (!file) return
    setErro(''); setResultado(''); setArquivo(file.name)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(ev.target.result, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const linhasBrutas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
        if (!linhasBrutas.length) { setErro('Planilha vazia.'); return }
        const hIdx = acharCabecalho(linhasBrutas)
        const hs = linhasBrutas[hIdx].map(c => String(c || '').trim())
        const dados = linhasBrutas.slice(hIdx + 1).filter(r => r.some(c => c !== '' && c != null))
        setHeaders(hs); setLinhas(dados); setMap(autoMapear(hs)); setResultado(null)
      } catch (err) {
        setErro('Não consegui ler o arquivo: ' + err.message)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  function valorCol(linha, key) {
    const idx = map[key]
    return idx === '' || idx == null ? '' : linha[Number(idx)]
  }

  async function importar() {
    setErro(''); setImportando(true); setResultado(null)
    try {
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setErro('Selecione uma empresa no topo.'); setImportando(false); return }

      const registros = linhas.map(l => ({
        competencia_id,
        data: toISO(valorCol(l, 'data')),
        conta: String(valorCol(l, 'conta') ?? '').trim() || null,
        contrapartida: String(valorCol(l, 'contrapartida') ?? '').trim() || null,
        historico: String(valorCol(l, 'historico') ?? '').trim() || null,
        debito: num(valorCol(l, 'debito')),
        credito: num(valorCol(l, 'credito')),
      })).filter(r => r.conta && (r.debito || r.credito))

      if (!registros.length) { setErro('Nenhuma linha válida (confira o mapeamento de Conta/Débito/Crédito).'); setImportando(false); return }

      // Reimportação: limpa o que havia desta competência e regrava.
      await supabase.from('razao').delete().eq('competencia_id', competencia_id)
      for (let i = 0; i < registros.length; i += 500) {
        const { error } = await supabase.from('razao').insert(registros.slice(i, i + 500))
        if (error) throw error
      }

      // Balancete derivado: agrupa por conta (saldo final = débito − crédito).
      const porConta = {}
      for (const r of registros) {
        const c = porConta[r.conta] || (porConta[r.conta] = { conta: r.conta, debito: 0, credito: 0 })
        c.debito += r.debito; c.credito += r.credito
      }
      const balancete = Object.values(porConta).map(c => ({
        competencia_id, conta: c.conta, nome: null,
        saldo_inicial: 0, debito: c.debito, credito: c.credito,
        saldo_final: c.debito - c.credito,
      }))
      await supabase.from('balancete').delete().eq('competencia_id', competencia_id)
      for (let i = 0; i < balancete.length; i += 500) {
        const { error } = await supabase.from('balancete').insert(balancete.slice(i, i + 500))
        if (error) throw error
      }

      const totDeb = registros.reduce((s, r) => s + r.debito, 0)
      const totCred = registros.reduce((s, r) => s + r.credito, 0)
      setResultado({ lancamentos: registros.length, contas: balancete.length, totDeb, totCred })
      setJaImportado(registros.length)
      recalcularPendencias()
      setHeaders([]); setLinhas([]); setArquivo('')
    } catch (err) {
      setErro('Erro ao gravar: ' + err.message)
    } finally {
      setImportando(false)
    }
  }

  const temArquivo = headers.length > 0

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no seletor do menu lateral para importar o razão." />
      </Wrapper>
    )
  }

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {jaImportado != null && !resultado && (
        <div style={{ background: 'rgba(48,164,108,0.12)', border: '0.5px solid rgba(48,164,108,0.4)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: theme.green, marginBottom: 18 }}>
          <i className="ti ti-circle-check" /> Já há <b>{jaImportado}</b> lançamento(s) importado(s) nesta competência. Importar de novo substitui os dados.
        </div>
      )}

      {/* Upload */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <label style={{ fontSize: 13, color: theme.text, marginBottom: 10, display: 'block' }}>Arquivo do razão (Excel do Domínio — .xlsx, .xls ou .csv)</label>
        <DropZone onArquivo={aoEscolherArquivo} hint="Arraste o razão aqui ou clique · .xlsx, .xls ou .csv" />
        {arquivo && <p style={{ fontSize: 12.5, color: theme.sub, marginTop: 10 }}><i className="ti ti-file-spreadsheet" /> {arquivo} — {linhas.length} linha(s) detectada(s)</p>}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>{erro}</p>}

      {/* Mapeamento + prévia */}
      {temArquivo && (
        <>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
            <h3 style={{ fontSize: 14, marginBottom: 4 }}>Mapeamento de colunas</h3>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>Confira a correspondência detectada automaticamente e ajuste se necessário.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>
              {ALVOS.map(a => (
                <div key={a.key}>
                  <label>{a.label}</label>
                  <select className="input" value={map[a.key] ?? ''} onChange={e => setMap(m => ({ ...m, [a.key]: e.target.value }))}>
                    <option value="">— nenhuma —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden', marginBottom: 18 }}>
            <p style={{ fontSize: 12.5, color: theme.sub, padding: '12px 16px' }}>Prévia (5 primeiras linhas)</p>
            <table>
              <thead>
                <tr style={{ background: theme.input }}>
                  {ALVOS.map(a => <th key={a.key} style={th}>{a.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {linhas.slice(0, 5).map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    {ALVOS.map(a => {
                      const v = valorCol(l, a.key)
                      const txt = a.key === 'debito' || a.key === 'credito' ? (num(v) ? money(num(v)) : '') : (a.key === 'data' ? (toISO(v) || '') : String(v ?? ''))
                      return <td key={a.key} style={td}>{txt}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn" disabled={importando} onClick={importar} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-cloud-upload" /> {importando ? 'Importando…' : `Importar ${linhas.length} linha(s)`}
          </button>
        </>
      )}

      {/* Resultado */}
      {resultado && (
        <div style={{ background: 'rgba(48,164,108,0.1)', border: '0.5px solid rgba(48,164,108,0.4)', borderRadius: 12, padding: 22 }}>
          <h3 style={{ fontSize: 15, color: theme.green, marginBottom: 12 }}><i className="ti ti-circle-check" /> Importação concluída</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 14 }}>
            <Stat label="Lançamentos" valor={resultado.lancamentos} />
            <Stat label="Contas (balancete)" valor={resultado.contas} />
            <Stat label="Total débito" valor={money(resultado.totDeb)} />
            <Stat label="Total crédito" valor={money(resultado.totCred)} />
          </div>
          <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 14 }}>
            O balancete da competência foi gerado a partir deste razão (saldo final = débito − crédito por conta).
          </p>
        </div>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Importar Razão</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Upload do razão do Domínio, gravação por competência e geração do balancete.</p>
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

function Stat({ label, valor }) {
  return (
    <div>
      <p style={{ color: theme.sub, fontSize: 12, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 700 }}>{valor}</p>
    </div>
  )
}
