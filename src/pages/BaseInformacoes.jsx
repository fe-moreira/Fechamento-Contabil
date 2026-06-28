import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

// Tipos de carga (nível cliente, preservando histórico por vigência).
// 'financeiro' existe no banco mas não é exposto aqui.
const TIPOS = [
  { tipo: 'plano', label: 'Plano de contas', helper: 'Plano de contas (com tipo de conciliação por conta)' },
  { tipo: 'depara', label: 'De/Para integrações', helper: 'De/Para: acumulador → conta' },
  { tipo: 'apelidos', label: 'Apelidos', helper: 'Apelidos para leitura de histórico' },
  { tipo: 'bancoresult', label: 'Banco × Resultado', helper: 'Amarração banco × resultado (Tipo, Código, Nome)' },
]

function fmtData(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export default function BaseInformacoes() {
  const { empresaId, empresaNome } = useAppData()
  const [tipoAtivo, setTipoAtivo] = useState('plano')
  const [cargas, setCargas] = useState([])
  const [carregando, setCarregando] = useState(false)

  const [vigencia, setVigencia] = useState('')
  const [arquivo, setArquivo] = useState('')
  const [dados, setDados] = useState([])      // array de objetos (linhas)
  const [colunas, setColunas] = useState([])  // cabeçalhos detectados
  const [erro, setErro] = useState('')
  const [importando, setImportando] = useState(false)

  const ativo = TIPOS.find(t => t.tipo === tipoAtivo)

  // Carrega o histórico de cargas do tipo ativo para o cliente.
  async function carregarCargas() {
    if (!empresaId) return
    setCarregando(true)
    const { data } = await supabase
      .from('cargas_cadastro')
      .select('id, vigencia, dados, obs, usuario, created_at')
      .eq('cliente_id', empresaId)
      .eq('tipo', tipoAtivo)
      .order('created_at', { ascending: false })
    setCargas(data || [])
    setCarregando(false)
  }

  useEffect(() => {
    setCargas([]); setErro(''); limparArquivo()
    carregarCargas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId, tipoAtivo])

  function limparArquivo() {
    setArquivo(''); setDados([]); setColunas([])
  }

  function aoEscolherArquivo(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setErro(''); setArquivo(file.name)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(ev.target.result, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        // Primeira linha como cabeçalho → array de objetos.
        const linhas = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' })
        if (!linhas.length) { setErro('Planilha vazia.'); setDados([]); setColunas([]); return }
        const cols = Object.keys(linhas[0])
        setDados(linhas); setColunas(cols)
      } catch (err) {
        setErro('Não consegui ler o arquivo: ' + err.message)
        setDados([]); setColunas([])
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function importar() {
    setErro('')
    if (!/^\d{2}\/\d{4}$/.test(vigencia.trim())) {
      setErro('Informe a vigência no formato MM/AAAA.')
      return
    }
    if (!dados.length) { setErro('Escolha um arquivo com pelo menos uma linha.'); return }
    setImportando(true)
    try {
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId,
        tipo: tipoAtivo,
        vigencia: vigencia.trim(),
        dados,
        obs: arquivo || null,
      })
      if (error) throw error
      setVigencia(''); limparArquivo()
      await carregarCargas()
    } catch (err) {
      setErro('Erro ao gravar: ' + err.message)
    } finally {
      setImportando(false)
    }
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

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b>
      </p>

      {/* Abas por tipo de carga */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {TIPOS.map(t => {
          const sel = t.tipo === tipoAtivo
          return (
            <button
              key={t.tipo}
              className={sel ? 'btn' : 'btn-ghost'}
              onClick={() => setTipoAtivo(t.tipo)}
              style={{ fontSize: 13 }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 18 }}>
        <i className="ti ti-info-circle" /> {ativo.helper}
      </p>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>{erro}</p>}

      {/* Formulário de nova carga */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>Nova carga — {ativo.label}</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>
          Cada importação cria uma nova vigência. O histórico é preservado.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12, alignItems: 'end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12.5, color: theme.sub, marginBottom: 6 }}>Vigência (MM/AAAA)</label>
            <input className="input" placeholder="06/2026" value={vigencia} onChange={e => setVigencia(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12.5, color: theme.sub, marginBottom: 6 }}>Arquivo (.xlsx, .xls, .csv)</label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolherArquivo}
              style={{ display: 'block', fontSize: 13, color: theme.sub }} />
          </div>
        </div>
        {arquivo && (
          <p style={{ fontSize: 12.5, color: theme.sub, marginTop: 12 }}>
            <i className="ti ti-file-spreadsheet" /> {arquivo} — {dados.length} linha(s) detectada(s)
          </p>
        )}

        {/* Prévia das 5 primeiras linhas */}
        {dados.length > 0 && (
          <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto', marginTop: 14 }}>
            <p style={{ fontSize: 12.5, color: theme.sub, padding: '10px 14px' }}>Prévia (5 primeiras linhas)</p>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.card }}>
                  {colunas.map((c, i) => <th key={i} style={th}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {dados.slice(0, 5).map((linha, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    {colunas.map((c, j) => <td key={j} style={td}>{String(linha[c] ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <button className="btn" disabled={importando} onClick={importar}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <i className="ti ti-cloud-upload" /> {importando ? 'Importando…' : 'Importar carga'}
        </button>
      </div>

      {/* Histórico de vigências */}
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>Vigências importadas</h3>
      {carregando ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : cargas.length === 0 ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '22px 20px' }}>
          <p style={{ fontSize: 13, color: theme.sub }}>
            <i className="ti ti-inbox" /> Nenhuma carga de {ativo.label.toLowerCase()} importada para este cliente.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
          {cargas.map(c => (
            <div key={c.id} style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '16px 18px' }}>
              <p style={{ fontSize: 12.5, color: theme.sub, marginBottom: 6 }}>Vigência</p>
              <p style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{c.vigencia}</p>
              <p style={{ fontSize: 12.5, color: theme.sub }}>
                <i className="ti ti-list-numbers" /> {Array.isArray(c.dados) ? c.dados.length : 0} linha(s)
              </p>
              <p style={{ fontSize: 12.5, color: theme.sub, marginTop: 6 }}>
                <i className="ti ti-calendar" /> {fmtData(c.created_at)}
              </p>
              {c.obs && (
                <p style={{ fontSize: 12, color: theme.sub, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <i className="ti ti-file-spreadsheet" /> {c.obs}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '9px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '8px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Base de Informações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Parâmetros do fechamento por vigência (preserva histórico).</p>
      {children}
    </div>
  )
}
