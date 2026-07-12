import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

// Lista padrão (só nomes — sem separação por departamento).
const PADRAO = ['Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída', 'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Razão do Domínio']
const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)

// Situação do documento:
// - ''           pendente (aguardando) → é pendência que bloqueia o Status.
// - 'recebido'   o cliente enviou.
// - 'nao_tem'    não se aplica no mês (ex.: adiantamento que não houve) → some, sem cobrança.
// - 'nao_enviou' o cliente não enviou → NÃO bloqueia o Status, mas entra no relatório
//                de pendências para cobrar o cliente.
const SIT = {
  '': { label: 'Pendente', cor: theme.yellow, icon: 'ti-square' },
  recebido: { label: 'Recebido', cor: theme.green, icon: 'ti-square-check' },
  nao_tem: { label: 'Não tem', cor: theme.sub, icon: 'ti-square-minus' },
  nao_enviou: { label: 'Não enviou', cor: theme.red, icon: 'ti-mail-exclamation' },
}
const situOf = d => { const s = d?.situacao ?? (d?.rec ? 'recebido' : ''); return SIT[s] ? s : '' }
const novoDoc = name => ({ name, situacao: '', rec: false, date: '' })
// Mantém a lista sempre em ordem alfabética (inclusive itens novos).
const ordenar = arr => [...(arr || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR', { sensitivity: 'base' }))
// Converte formato antigo (rec bool) e novo (situacao) para o mesmo shape.
const normaliza = (arr) => (arr || []).map(x => {
  const name = String(x.name || '').trim()
  const situacao = situOf(x)
  return { name, situacao, rec: situacao === 'recebido', date: x.date || '' }
}).filter(x => x.name)

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
        setDocs(ordenar(normaliza(d)))
      } else {
        // Herda a lista do fechamento anterior mais recente; senão, fica vazio
        // (sem lista-padrão automática — a base é importada por cliente).
        const herdado = await herdarLista(empresaId, ano, mes)
        setDocs(ordenar(herdado.map(novoDoc)))
      }
      setCarregando(false)
    })()
  }, [empresaId, competencia])

  // Grava na competência atual e, para mudanças de estrutura, propaga a lista de
  // nomes para os fechamentos ABERTOS dali pra frente (fechados nunca mudam).
  async function persistir(lista, propagar = false) {
    const novo = ordenar(lista) // sempre em ordem alfabética
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
      const merged = nomes.map(name => recPorNome[name] || novoDoc(name))
      await supabase.from('competencias').update({ documentos: merged }).eq('id', c.id)
    }
  }

  // Define a situação do documento; clicar na situação já ativa volta para pendente.
  const setSit = (i, s) => {
    if (ro || editIdx !== null) return
    persistir(docs.map((d, j) => {
      if (j !== i) return d
      const nova = situOf(d) === s ? '' : s
      return { ...d, situacao: nova, rec: nova === 'recebido', date: nova === 'recebido' ? hojeCurto() : '' }
    }))
  }
  const remover = (i) => { if (ro) return; if (confirm(`Excluir “${docs[i].name}” da lista?`)) persistir(docs.filter((_, j) => j !== i), true) }
  const incluir = () => { if (ro || !nome.trim()) return; persistir([...docs, novoDoc(nome.trim())], true); setNome('') }
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
      await persistir(unicos.map(novoDoc), true)
      setMsg(`${unicos.length} documento(s) importado(s).`)
    } catch (err) { setMsg('Erro ao importar: ' + err.message) }
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para conferir os documentos." /></Wrapper>
  }

  const total = docs.length
  const cont = { '': 0, recebido: 0, nao_tem: 0, nao_enviou: 0 }
  for (const d of docs) cont[situOf(d)]++
  const rec = cont.recebido
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
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
          <span style={{ color: theme.yellow }}><b>{cont['']}</b> pendente(s)</span>
          <span style={{ color: theme.green }}><b>{cont.recebido}</b> recebido(s)</span>
          <span style={{ color: theme.sub }}><b>{cont.nao_tem}</b> não tem</span>
          <span style={{ color: theme.red }}><b>{cont.nao_enviou}</b> não enviou (vai p/ o relatório de pendências)</span>
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
        ) : docs.map((d, i) => {
          const s = situOf(d)
          return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 13.5, flexWrap: 'wrap' }}>
            <i className={`ti ${SIT[s].icon}`} style={{ color: SIT[s].cor, fontSize: 20 }} />
            {editIdx === i ? (
              <input className="input" autoFocus value={editNome}
                onChange={e => setEditNome(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') salvarEdicao(); if (e.key === 'Escape') { setEditIdx(null); setEditNome('') } }}
                onBlur={salvarEdicao} style={{ flex: 1, minWidth: 160 }} />
            ) : (
              <span style={{ flex: 1, minWidth: 140, color: s === 'recebido' ? theme.text : theme.sub }}>{d.name}</span>
            )}
            {editIdx !== i && <span style={{ color: SIT[s].cor, fontSize: 12, fontWeight: 500, minWidth: 76 }}>{SIT[s].label}{s === 'recebido' && d.date ? ` ${d.date}` : ''}</span>}
            {!ro && editIdx !== i && (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['recebido', 'nao_tem', 'nao_enviou'].map(k => (
                    <button key={k} className={s === k ? 'btn' : 'btn btn-ghost'} title={SIT[k].label}
                      style={{ fontSize: 12, padding: '5px 9px', ...(s === k ? { background: SIT[k].cor, borderColor: SIT[k].cor } : { color: SIT[k].cor, borderColor: SIT[k].cor }) }}
                      onClick={() => setSit(i, k)}>
                      <i className={`ti ${SIT[k].icon}`} /> {SIT[k].label}
                    </button>
                  ))}
                </div>
                <i className="ti ti-pencil" title="Editar nome" onClick={() => abrirEdicao(i)} style={{ color: theme.sub, fontSize: 16, marginLeft: 2, cursor: 'pointer' }} />
                <i className="ti ti-trash" title="Excluir" onClick={() => remover(i)} style={{ color: theme.sub, fontSize: 16, cursor: 'pointer' }} />
              </>
            )}
          </div>
        )})}
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
        Lista de documentos esperados por cliente. Marque cada um como <b style={{ color: theme.green }}>Recebido</b>, <b style={{ color: theme.sub }}>Não tem</b> (não se aplica no mês) ou <b style={{ color: theme.red }}>Não enviou</b> (não bloqueia o fechamento, mas entra no relatório de pendências para cobrar o cliente). O que ficar <b style={{ color: theme.yellow }}>pendente</b> continua bloqueando. Alterações valem desta competência <b style={{ color: theme.text }}>em diante</b>.
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
