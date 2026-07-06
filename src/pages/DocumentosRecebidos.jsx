import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

// Lista padrão (só nomes — sem separação por departamento).
const PADRAO = ['Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída', 'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Razão do Domínio']
const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)
// Converte formato antigo (com cat) para o novo (só name/rec/date).
const normaliza = (arr) => (arr || []).map(x => ({ name: String(x.name || '').trim(), rec: !!x.rec, date: x.date || '' })).filter(x => x.name)

export default function DocumentosRecebidos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const [docs, setDocs] = useState([])
  const [status, setStatus] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState('')
  const [editIdx, setEditIdx] = useState(null)
  const [editNome, setEditNome] = useState('')
  const [msg, setMsg] = useState('')

  const ro = status === 'fechado' // fechado = somente leitura

  useEffect(() => {
    setMsg(''); setEditIdx(null)
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)
    const [mes, ano] = competencia.split('/').map(Number)
    ;(async () => {
      const { data: comp } = await supabase.from('competencias').select('id, status, documentos')
        .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      setStatus(comp?.status || null)
      const d = comp?.documentos
      if (Array.isArray(d) && d.length) {
        setDocs(normaliza(d))
      } else {
        // Herda a lista do fechamento anterior mais recente; senão, usa o padrão.
        const herdado = await herdarLista(empresaId, ano, mes)
        setDocs((herdado.length ? herdado : PADRAO).map(name => ({ name, rec: false, date: '' })))
      }
      setCarregando(false)
    })()
  }, [empresaId, competencia])

  // Grava na competência atual e, para mudanças de estrutura, propaga a lista de
  // nomes para os fechamentos ABERTOS dali pra frente (fechados nunca mudam).
  async function persistir(novo, propagar = false) {
    setDocs(novo)
    const id = await getCompetenciaId()
    if (id) await supabase.from('competencias').update({ documentos: novo }).eq('id', id)
    if (propagar) await propagarFrente(novo)
    recalcularPendencias()
  }

  async function propagarFrente(novo) {
    const [mes, ano] = competencia.split('/').map(Number)
    const nomes = novo.map(d => d.name)
    const { data } = await supabase.from('competencias').select('id, ano, mes, status, documentos').eq('cliente_id', empresaId)
    const futuras = (data || []).filter(c => (c.ano > ano || (c.ano === ano && c.mes > mes)) && c.status !== 'fechado')
    for (const c of futuras) {
      const recPorNome = Object.fromEntries(normaliza(c.documentos).map(x => [x.name, x]))
      const merged = nomes.map(name => recPorNome[name] || { name, rec: false, date: '' })
      await supabase.from('competencias').update({ documentos: merged }).eq('id', c.id)
    }
  }

  const toggle = (i) => { if (!ro && editIdx === null) persistir(docs.map((d, j) => j === i ? { ...d, rec: !d.rec, date: !d.rec ? hojeCurto() : '' } : d)) }
  const remover = (i) => { if (ro) return; if (confirm(`Excluir “${docs[i].name}” da lista?`)) persistir(docs.filter((_, j) => j !== i), true) }
  const incluir = () => { if (ro || !nome.trim()) return; persistir([...docs, { name: nome.trim(), rec: false, date: '' }], true); setNome('') }
  const abrirEdicao = (i) => { setEditIdx(i); setEditNome(docs[i].name) }
  const salvarEdicao = () => {
    const n = editNome.trim()
    if (n && editIdx !== null) persistir(docs.map((d, j) => j === editIdx ? { ...d, name: n } : d), true)
    setEditIdx(null); setEditNome('')
  }

  async function baixarModelo() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([['Documento'], ...PADRAO.map(n => [n])])
    ws['!cols'] = [{ wch: 46 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Documentos')
    XLSX.writeFile(wb, 'modelo-documentos.xlsx')
  }

  async function importar(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file || ro) return
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      let nomes = rows.map(r => String(r[0] ?? '').trim()).filter(Boolean)
      if (nomes[0] && /^documento/i.test(nomes[0])) nomes = nomes.slice(1) // ignora cabeçalho
      const unicos = [...new Set(nomes)]
      if (!unicos.length) { setMsg('Nenhum documento encontrado na planilha (coluna A).'); return }
      if (!confirm(`Importar ${unicos.length} documento(s)? Isso substitui a lista desta competência (em diante).`)) return
      await persistir(unicos.map(name => ({ name, rec: false, date: '' })), true)
      setMsg(`${unicos.length} documento(s) importado(s).`)
    } catch (err) { setMsg('Erro ao importar: ' + err.message) }
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para conferir os documentos." /></Wrapper>
  }

  const total = docs.length, rec = docs.filter(d => d.rec).length
  const pct = total ? Math.round(rec / total * 100) : 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
        {ro && <span style={{ marginLeft: 10, color: theme.red, fontWeight: 600 }}><i className="ti ti-lock" /> Fechado · somente leitura</span>}
      </p>

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 12 }}><i className="ti ti-info-circle" /> {msg}</p>}

      {/* Progresso */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: theme.text, fontSize: 15, fontWeight: 600 }}>{rec} de {total} recebidos</span>
          <span style={{ color: pct === 100 ? theme.green : theme.yellow, fontWeight: 600 }}>{pct}%</span>
        </div>
        <div style={{ height: 8, background: theme.input, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? theme.green : theme.accent }} />
        </div>
      </div>

      {/* Ações: incluir / importar / modelo */}
      {!ro && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Nome do documento" value={nome}
            onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === 'Enter' && incluir()} />
          <button className="btn" onClick={incluir}><i className="ti ti-plus" /> Incluir</button>
          <span style={{ width: 1, height: 24, background: theme.border, margin: '0 2px' }} />
          <label className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <i className="ti ti-file-import" /> Importar Excel
            <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={importar} />
          </label>
          <button className="btn btn-ghost" onClick={baixarModelo}><i className="ti ti-file-spreadsheet" /> Baixar modelo</button>
          <span style={{ fontSize: 12, color: theme.sub, marginLeft: 'auto' }}>Vários clientes de uma vez? Use <b style={{ color: theme.text }}>Importação em massa</b> (Nível cliente).</span>
        </div>
      )}

      {/* Lista */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        {carregando ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Carregando…</p>
        ) : docs.length === 0 ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Nenhum documento na lista.{!ro && ' Inclua acima ou importe do Excel.'}</p>
        ) : docs.map((d, i) => (
          <div key={i} onClick={() => editIdx === null && toggle(i)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', cursor: ro || editIdx !== null ? 'default' : 'pointer', fontSize: 13.5 }}>
            <i className={`ti ${d.rec ? 'ti-square-check' : 'ti-square'}`} style={{ color: d.rec ? theme.green : theme.sub, fontSize: 20 }} />
            {editIdx === i ? (
              <input className="input" autoFocus value={editNome} onClick={e => e.stopPropagation()}
                onChange={e => setEditNome(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') salvarEdicao(); if (e.key === 'Escape') { setEditIdx(null); setEditNome('') } }}
                onBlur={salvarEdicao} style={{ flex: 1 }} />
            ) : (
              <span style={{ flex: 1, color: d.rec ? theme.text : theme.sub }}>{d.name}</span>
            )}
            {editIdx !== i && (d.rec
              ? <span style={{ color: theme.sub, fontSize: 12 }}>recebido {d.date}</span>
              : <span style={{ color: theme.yellow, fontSize: 12, fontWeight: 500 }}>pendente</span>)}
            {!ro && editIdx !== i && (
              <>
                <i className="ti ti-pencil" title="Editar nome" onClick={e => { e.stopPropagation(); abrirEdicao(i) }} style={{ color: theme.sub, fontSize: 16, marginLeft: 4, cursor: 'pointer' }} />
                <i className="ti ti-trash" title="Excluir" onClick={e => { e.stopPropagation(); remover(i) }} style={{ color: theme.sub, fontSize: 16, cursor: 'pointer' }} />
              </>
            )}
          </div>
        ))}
      </div>
    </Wrapper>
  )
}

// Lista de documentos do fechamento anterior mais recente (só os nomes).
async function herdarLista(empresaId, ano, mes) {
  const { data } = await supabase.from('competencias').select('ano, mes, documentos').eq('cliente_id', empresaId)
  const anteriores = (data || [])
    .filter(c => (c.ano < ano || (c.ano === ano && c.mes < mes)) && Array.isArray(c.documentos) && c.documentos.length)
    .sort((a, b) => (b.ano - a.ano) || (b.mes - a.mes))
  return anteriores[0] ? normaliza(anteriores[0].documentos).map(x => x.name) : []
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Documentos Recebidos</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Lista de documentos esperados por cliente. Alterações valem desta competência <b style={{ color: theme.text }}>em diante</b> — fechamentos já fechados não mudam. O que faltar vira pendência.
      </p>
      {children}
    </div>
  )
}
function Aviso({ texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
