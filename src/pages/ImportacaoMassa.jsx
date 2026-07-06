import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { fechaSozinho } from '../lib/clientes'
import { theme } from '../lib/theme'

const PADRAO = ['Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída', 'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Razão do Domínio']
const cnpj14 = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 11 && d.length <= 14 ? d.padStart(14, '0') : d }
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const normaliza = (arr) => (arr || []).map(x => ({ name: String(x.name || '').trim(), rec: !!x.rec, date: x.date || '' })).filter(x => x.name)

export default function ImportacaoMassa() {
  const { competencia, competencias, recalcularPendencias } = useAppData()
  const [alvo, setAlvo] = useState(competencia)   // competência-alvo do import de documentos
  const [msg, setMsg] = useState('')
  const [massa, setMassa] = useState(null)
  const [aplicando, setAplicando] = useState(false)

  // ---- Relação de documentos (por CNPJ) ----
  async function baixarModeloDocs() {
    const XLSX = await import('xlsx')
    const linhas = [['CNPJ', 'Cliente', 'Documento']]
    for (const d of PADRAO) linhas.push(['00.000.000/0000-00', 'Razão social (opcional)', d])
    const ws = XLSX.utils.aoa_to_sheet(linhas)
    ws['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 46 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Documentos')
    XLSX.writeFile(wb, 'modelo-documentos-massa.xlsx')
  }

  async function analisarDocs(e) {
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
      const [mes, ano] = alvo.split('/').map(Number)
      setMassa({ tipo: 'documentos', encontrados, naoEncontrados, consolidadas, ano, mes })
    } catch (err) { setMsg('Erro ao ler a planilha: ' + err.message) }
  }

  async function aplicar() {
    if (!massa) return
    setAplicando(true); setMsg('')
    try {
      const { ano, mes } = massa
      let atualizados = 0, pulados = 0
      for (const c of massa.encontrados) {
        const docs = c.docs.map(name => ({ name, rec: false, date: '' }))
        const { data: ex } = await supabase.from('competencias').select('id, status').eq('cliente_id', c.id).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (ex?.status === 'fechado') { pulados++; continue }
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
      setMsg(`Documentos: ${atualizados} cliente(s) atualizado(s) na competência ${String(mes).padStart(2, '0')}/${ano}${pulados ? ` · ${pulados} pulado(s) (fechado)` : ''}.`)
      setMassa(null)
      recalcularPendencias?.()
    } catch (err) { setMsg('Erro ao aplicar: ' + err.message) } finally { setAplicando(false) }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Importação em massa</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 20, maxWidth: 760 }}>
        Suba informações de vários clientes de uma vez, amarrando pelo <b style={{ color: theme.text }}>CNPJ</b>. Cada bloco tem o seu modelo de arquivo.
      </p>

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 14 }}><i className="ti ti-info-circle" /> {msg}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {/* Relação de documentos */}
        <Bloco icon="ti-files" titulo="Relação de documentos" desc="Lista de documentos esperados por cliente. Substitui a lista de cada CNPJ na competência escolhida e propaga para os abertos em diante.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, color: theme.sub }}>Competência:</span>
            <select className="input" style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }} value={alvo} onChange={e => setAlvo(e.target.value)}>
              {(competencias || [competencia]).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <i className="ti ti-file-import" /> Importar em massa
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={analisarDocs} />
            </label>
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={baixarModeloDocs}><i className="ti ti-file-spreadsheet" /> Baixar modelo</button>
          </div>
        </Bloco>

        {/* Clientes (o import fica no cadastro) */}
        <Bloco icon="ti-users" titulo="Clientes" desc="Cadastro de clientes em lote (matriz e filiais), amarrado pelo CNPJ. O modelo e a importação ficam na tela de Clientes.">
          <Link to="/clientes" className="btn btn-ghost" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-arrow-right" /> Ir para Clientes
          </Link>
        </Bloco>

        {/* Placeholder para próximos */}
        <Bloco icon="ti-book" titulo="Plano de contas · De/Para" desc="Importação em massa do plano de contas e das amarrações (de/para) por CNPJ." emBreve />
      </div>

      {/* Confirmação da importação */}
      {massa && (
        <div onClick={() => !aplicando && setMassa(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '88vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>Importar relação de documentos</h2>
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
              <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 12px' }}><b style={{ color: theme.red }}>Não encontrados:</b> {massa.naoEncontrados.join(', ')}</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setMassa(null)} disabled={aplicando}>Cancelar</button>
              <button className="btn" onClick={aplicar} disabled={aplicando || !massa.encontrados.length}>{aplicando ? 'Aplicando…' : 'Aplicar importação'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Bloco({ icon, titulo, desc, children, emBreve }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, opacity: emBreve ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 20 }} />
        </span>
        <div style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          {titulo}
          {emBreve && <span style={{ fontSize: 10.5, fontWeight: 600, color: theme.sub, textTransform: 'uppercase', letterSpacing: .4, padding: '2px 7px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${theme.cb}` }}>em breve</span>}
        </div>
      </div>
      <p style={{ color: theme.sub, fontSize: 12.5, margin: 0, lineHeight: 1.5, flex: 1 }}>{desc}</p>
      {children && <div style={{ marginTop: 2 }}>{children}</div>}
    </div>
  )
}

function Tag({ c, n, t }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.text }}><b style={{ color: c, fontSize: 15 }}>{n}</b> {t}</span>
}
