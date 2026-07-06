import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { fechaSozinho } from '../lib/clientes'
import { theme } from '../lib/theme'

// Lista padrão (só nomes — sem separação por departamento).
const PADRAO = ['Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída', 'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Razão do Domínio']
const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)
// CNPJ normalizado a 14 dígitos (repõe zero à esquerda) — chave da amarração em massa.
const cnpj14 = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 11 && d.length <= 14 ? d.padStart(14, '0') : d }
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
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
  const [massa, setMassa] = useState(null)       // preview da importação em massa
  const [aplicandoMassa, setAplicandoMassa] = useState(false)

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

  // ---- Importação em massa (todos os clientes, amarrada pelo CNPJ) ----
  async function baixarModeloMassa() {
    const XLSX = await import('xlsx')
    const linhas = [['CNPJ', 'Cliente', 'Documento']]
    for (const d of PADRAO) linhas.push(['00.000.000/0000-00', 'Razão social (opcional)', d])
    const ws = XLSX.utils.aoa_to_sheet(linhas)
    ws['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 46 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Documentos')
    XLSX.writeFile(wb, 'modelo-documentos-massa.xlsx')
  }

  async function analisarMassa(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setMsg(''); setMassa(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const hIdx = rows.findIndex(r => r.map(norm).some(h => h.includes('cnpj')))
      if (hIdx < 0) { setMsg('Não encontrei a coluna CNPJ na planilha.'); return }
      const H = rows[hIdx].map(norm)
      const iCnpj = H.findIndex(h => h.includes('cnpj'))
      const iDoc = H.findIndex(h => h.includes('documento'))
      if (iDoc < 0) { setMsg('Não encontrei a coluna Documento na planilha.'); return }

      const porCnpj = new Map()
      for (const r of rows.slice(hIdx + 1)) {
        const cnpj = cnpj14(r[iCnpj]); const doc = String(r[iDoc] ?? '').trim()
        if (!cnpj || !doc) continue
        const arr = porCnpj.get(cnpj) || []
        if (!arr.includes(doc)) arr.push(doc)
        porCnpj.set(cnpj, arr)
      }
      if (!porCnpj.size) { setMsg('Nenhuma linha válida (CNPJ + Documento).'); return }

      const { data: clientes } = await supabase.from('clientes').select('id, razao_social, cnpj, tipo, tipo_fechamento')
      const porCli = new Map((clientes || []).map(c => [cnpj14(c.cnpj), c]))
      const encontrados = [], naoEncontrados = [], consolidadas = []
      for (const [cnpj, docs] of porCnpj) {
        const cli = porCli.get(cnpj)
        if (!cli) { naoEncontrados.push(cnpj); continue }
        if (!fechaSozinho(cli)) { consolidadas.push(cli.razao_social); continue }
        encontrados.push({ id: cli.id, nome: cli.razao_social, docs })
      }
      const [mes, ano] = competencia.split('/').map(Number)
      setMassa({ encontrados, naoEncontrados, consolidadas, ano, mes })
    } catch (err) { setMsg('Erro ao ler a planilha: ' + err.message) }
  }

  async function aplicarMassa() {
    if (!massa) return
    setAplicandoMassa(true); setMsg('')
    try {
      const { ano, mes } = massa
      let atualizados = 0, pulados = 0
      for (const c of massa.encontrados) {
        const docs = c.docs.map(name => ({ name, rec: false, date: '' }))
        // competência atual do cliente (cria se não existir) → substitui a lista.
        const { data: ex } = await supabase.from('competencias').select('id, status').eq('cliente_id', c.id).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (ex?.status === 'fechado') { pulados++; continue } // não mexe em fechado
        let compId = ex?.id
        if (!compId) {
          const { data: cr } = await supabase.from('competencias').insert({ cliente_id: c.id, ano, mes }).select('id').single()
          compId = cr?.id
        }
        if (compId) { await supabase.from('competencias').update({ documentos: docs }).eq('id', compId); atualizados++ }
        // propaga para os fechamentos ABERTOS deste cliente dali pra frente.
        const { data: futuras } = await supabase.from('competencias').select('id, ano, mes, status, documentos').eq('cliente_id', c.id)
        for (const f of (futuras || []).filter(x => (x.ano > ano || (x.ano === ano && x.mes > mes)) && x.status !== 'fechado')) {
          const recPorNome = Object.fromEntries(normaliza(f.documentos).map(x => [x.name, x]))
          await supabase.from('competencias').update({ documentos: c.docs.map(name => recPorNome[name] || { name, rec: false, date: '' }) }).eq('id', f.id)
        }
      }
      setMsg(`Importação em massa: ${atualizados} cliente(s) atualizado(s) na competência ${String(mes).padStart(2, '0')}/${ano}${pulados ? ` · ${pulados} pulado(s) (fechado)` : ''}.`)
      setMassa(null)
      recalcularPendencias()
      // recarrega a lista da empresa aberta (pode ter sido atualizada na massa)
      const { data: comp } = await supabase.from('competencias').select('documentos').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      if (comp && Array.isArray(comp.documentos)) setDocs(normaliza(comp.documentos))
    } catch (err) { setMsg('Erro ao aplicar: ' + err.message) } finally { setAplicandoMassa(false) }
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
        </div>
      )}

      {/* Importação em massa (todos os clientes, por CNPJ) */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <i className="ti ti-users-group" style={{ color: theme.accent, fontSize: 18 }} />
        <span style={{ fontSize: 13, color: theme.sub, flex: 1, minWidth: 200 }}>
          <b style={{ color: theme.text }}>Importar todos por CNPJ</b> — sobe a lista de vários clientes de uma vez, na competência <b style={{ color: theme.text }}>{competencia}</b>.
        </span>
        <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <i className="ti ti-file-import" /> Importar em massa
          <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={analisarMassa} />
        </label>
        <button className="btn btn-ghost" onClick={baixarModeloMassa}><i className="ti ti-file-spreadsheet" /> Modelo (CNPJ)</button>
      </div>

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

      {/* Confirmação da importação em massa */}
      {massa && (
        <div onClick={() => !aplicandoMassa && setMassa(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '88vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>Importar documentos em massa</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
              Competência <b style={{ color: theme.text }}>{String(massa.mes).padStart(2, '0')}/{massa.ano}</b>. Cada cliente encontrado tem a lista <b style={{ color: theme.text }}>substituída</b> (e propagada para os fechamentos abertos em diante). Fechados não mudam.
            </p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              <Tag c={theme.green} n={massa.encontrados.length} t="cliente(s) a atualizar" />
              {massa.consolidadas.length > 0 && <Tag c={theme.sub} n={massa.consolidadas.length} t="filial consolidada (ignorada)" />}
              {massa.naoEncontrados.length > 0 && <Tag c={theme.red} n={massa.naoEncontrados.length} t="CNPJ não encontrado" />}
            </div>

            {massa.encontrados.length > 0 && (
              <div style={{ maxHeight: 220, overflow: 'auto', border: `1px solid ${theme.border}`, borderRadius: 10, marginBottom: 12 }}>
                {massa.encontrados.map((c, i) => (
                  <div key={i} style={{ padding: '9px 12px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12.5 }}>
                    <b>{c.nome}</b> <span style={{ color: theme.sub }}>· {c.docs.length} documento(s)</span>
                  </div>
                ))}
              </div>
            )}
            {massa.naoEncontrados.length > 0 && (
              <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 12px' }}>
                <b style={{ color: theme.red }}>Não encontrados:</b> {massa.naoEncontrados.join(', ')}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setMassa(null)} disabled={aplicandoMassa}>Cancelar</button>
              <button className="btn" onClick={aplicarMassa} disabled={aplicandoMassa || !massa.encontrados.length}>{aplicandoMassa ? 'Aplicando…' : 'Aplicar importação'}</button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  )
}

function Tag({ c, n, t }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.text }}><b style={{ color: c, fontSize: 15 }}>{n}</b> {t}</span>
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
