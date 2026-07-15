import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { fechaSozinho } from '../lib/clientes'
import { folhaPorEmpresa, novoRotuloArq, marcarEventos, arquivosDoSlot } from '../lib/folha'

const TIPOKEY_LABEL = { folha: 'Folha mensal', adiant: 'Adiantamento', decimo_adiant: '13º Adiantamento', complementar: 'Folha Complementar', plr: 'Participação de Lucros' }
import { parsePlano } from '../lib/balancete'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import { parseNomeArquivo, anexarExtratoPdf, anexarExtratoExcel, alimentarIntegracaoFinanceira, lerIdentificacao, lerMemoriaContas, lembrarContaBancaria, chaveContaBanco, tipoEfetivoDoc } from '../lib/importacaoMassa'

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

        {/* Recebimento de arquivos (extratos PDF/Excel) */}
        <RecebeArquivos competencias={competencias} competencia={competencia} recalcularPendencias={recalcularPendencias} />

        {/* Folha em massa (um arquivo do Domínio com várias empresas → quebra por empresa) */}
        <MassaFolha competencias={competencias} competencia={competencia} recalcularPendencias={recalcularPendencias} />
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

// ---- Card: Folha em massa ----
// Um único relatório de rubricas do Domínio traz VÁRIAS empresas (coluna A = código no
// Domínio). Aqui a gente quebra por empresa e joga a folha na Integração de cada cliente,
// respeitando o cadastro: filial "Consolidado" centraliza na MATRIZ; individualizado vai
// na própria empresa. Casa por código do Domínio (CNPJ de reserva).
const TIPOS_FOLHA = [
  ['folha', 'Folha mensal'],
  ['adiant', 'Adiantamento'],
  ['decimo_adiant', '13º Adiantamento'],
  ['complementar', 'Folha Complementar'],
  ['plr', 'Participação de Lucros'],
]
function MassaFolha({ competencias, competencia, recalcularPendencias }) {
  const { user } = useAuth()
  const [alvo, setAlvo] = useState(competencia)
  const [tipo, setTipo] = useState('folha')
  const [msg, setMsg] = useState('')
  const [erro, setErro] = useState('')
  const [dados, setDados] = useState(null)   // { file, empresas } lido do arquivo
  const [prev, setPrev] = useState(null)     // conferência montada
  const [modo, setModo] = useState('complementar') // como gravar quando já existe
  const [aplicando, setAplicando] = useState(false)
  const [envios, setEnvios] = useState(null) // lista de envios da competência (para excluir)
  const [carregEnv, setCarregEnv] = useState(false)

  const tipoLabel = TIPOS_FOLHA.find(t => t[0] === tipo)?.[1] || tipo

  async function analisar(e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setMsg(''); setErro(''); setPrev(null); setDados(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const empresas = folhaPorEmpresa(arr)
      if (!empresas.length) { setErro('Não encontrei empresas no arquivo (coluna A = código no Domínio). Confira se é o relatório de rubricas do Domínio com várias empresas.'); return }
      setDados({ file, empresas })
      await montarConferencia(file, empresas)
    } catch (err) { setErro('Erro ao ler o arquivo: ' + err.message) }
  }

  async function montarConferencia(file, empresas) {
    const { data: clientes } = await supabase.from('clientes')
      .select('id, codigo_dominio, tipo, tipo_fechamento, codigo_matriz, razao_social, cnpj')
    const porCod = new Map((clientes || []).map(c => [String(c.codigo_dominio || '').trim(), c]))
    const porCnpj = new Map((clientes || []).map(c => [cnpj14(c.cnpj), c]))
    const destinos = new Map()   // id → { id, nome, fontes:[], eventos:[] }
    const naoEncontrados = [], matrizAusente = [], semRubrica = []
    for (const emp of empresas) {
      const cli = porCod.get(emp.cod) || porCnpj.get(cnpj14(emp.cnpj))
      if (!cli) { naoEncontrados.push(`${emp.cod} · ${emp.nome}`); continue }
      if (!emp.eventos.length) { semRubrica.push(`${emp.cod} · ${emp.nome}`); continue }
      let dest = cli
      if (!fechaSozinho(cli)) {   // filial consolidada → centraliza na matriz
        const matriz = porCod.get(String(cli.codigo_matriz || '').trim())
        if (!matriz) { matrizAusente.push(`${emp.cod} · ${emp.nome} (matriz ${cli.codigo_matriz || '?'} não cadastrada)`); continue }
        dest = matriz
      }
      let d = destinos.get(dest.id)
      if (!d) { d = { id: dest.id, nome: dest.razao_social, cod: dest.codigo_dominio, fontes: [], eventos: [] }; destinos.set(dest.id, d) }
      d.fontes.push({ cod: emp.cod, nome: emp.nome, n: emp.eventos.length, consolida: dest.id !== cli.id })
      d.eventos.push(...emp.eventos)
    }
    const lista = [...destinos.values()].map(d => ({ ...d, total: Math.round(d.eventos.reduce((s, e) => s + e.valor, 0) * 100) / 100 }))
    const [mes, ano] = alvo.split('/').map(Number)
    setPrev({ fileName: file.name, destinos: lista, naoEncontrados, matrizAusente, semRubrica, ano, mes })
  }

  async function aplicar() {
    if (!prev || !dados) return
    setAplicando(true); setMsg(''); setErro('')
    try {
      const { ano, mes } = prev
      // Um RÓTULO por envio (mesmo em todas as empresas) → dá para excluir o envio inteiro
      // depois. Sobe o arquivo original UMA vez (para o "Extrair" na Integração baixar depois).
      const rotulo = novoRotuloArq(dados.file.name)
      let path = ''
      try {
        const ext = (dados.file.name.match(/\.[a-z0-9]+$/i) || ['.xls'])[0].toLowerCase()
        path = `folha/massa/${rotulo.arq.split('#')[1] || ''}${ext}`
        await supabase.storage.from('extratos').upload(path, dados.file, { upsert: true, contentType: dados.file.type || undefined })
      } catch { path = '' }
      const fileMeta = { arq: rotulo.arq, doc: rotulo.doc, data: rotulo.data, path, usuario: user?.email || null }

      let gravados = 0, pulados = 0
      for (const d of prev.destinos) {
        const { data: ex } = await supabase.from('competencias').select('id, status, integracoes').eq('cliente_id', d.id).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (ex?.status === 'fechado') { pulados++; continue }
        let compId = ex?.id
        if (!compId) {
          const { data: cr } = await supabase.from('competencias').insert({ cliente_id: d.id, ano, mes }).select('id').single()
          compId = cr?.id
        }
        if (!compId) { pulados++; continue }
        const integ = ex?.integracoes || {}
        const folha = integ.folha || {}
        const atual = folha.arquivos?.[tipo]
        const eventosTag = marcarEventos(d.eventos, rotulo.arq)
        let slot
        if (modo === 'complementar' && atual?.eventos?.length) {
          const filesAnt = atual.files?.length ? atual.files : arquivosDoSlot(atual).map(f => ({ arq: f.arq, doc: f.doc, data: f.data, path: atual.path || '' }))
          slot = { doc: rotulo.doc, path: path || atual.path || '', eventos: [...atual.eventos, ...eventosTag], files: [...filesAnt, fileMeta] }
        } else {
          slot = { doc: rotulo.doc, path, eventos: eventosTag, files: [fileMeta] }
        }
        const arquivos = { ...(folha.arquivos || {}), [tipo]: slot }
        const done = !!(arquivos.folha?.eventos?.length)
        const novaFolha = { ...folha, arquivos, justif: folha.justif || {}, estado: done ? 'validado' : (folha.estado || null), doc: done ? 'Folha · rubricas cruzadas' : (folha.doc || null), usuario: user?.email || null }
        await supabase.from('competencias').update({ integracoes: { ...integ, folha: novaFolha } }).eq('id', compId)
        gravados++
      }
      setMsg(`${tipoLabel}: ${gravados} empresa(s) gravada(s) em ${String(mes).padStart(2, '0')}/${ano} (${modo === 'complementar' ? 'complementado' : 'substituído'})${pulados ? ` · ${pulados} pulado(s) (fechado)` : ''}.`)
      setPrev(null); setDados(null)
      if (envios) carregarEnvios()
      recalcularPendencias?.()
    } catch (err) { setErro('Erro ao aplicar: ' + err.message) } finally { setAplicando(false) }
  }

  // Lista os ENVIOS de folha da competência (agrupa por rótulo do arquivo em todas as
  // empresas) — para conferir e excluir um envio inteiro caso tenha subido errado.
  async function carregarEnvios() {
    setCarregEnv(true); setErro('')
    try {
      const [mes, ano] = alvo.split('/').map(Number)
      const { data: comps } = await supabase.from('competencias').select('id, integracoes').eq('ano', ano).eq('mes', mes)
      const grupos = new Map()
      for (const c of (comps || [])) {
        const arqs = c.integracoes?.folha?.arquivos || {}
        for (const [tk, slot] of Object.entries(arqs)) {
          for (const f of arquivosDoSlot(slot)) {
            // Envios NOVOS têm carimbo (arq). Os ANTIGOS (subidos antes desta versão) não têm —
            // aí agrupamos pelo tipo + nome do arquivo, para também poder conferir e excluir.
            const legado = !f.arq || f.arq === '__legado'
            const key = legado ? `legado::${tk}::${f.doc || ''}` : f.arq
            const g = grupos.get(key) || { key, arq: legado ? null : f.arq, legado, tipo: tk, doc: f.doc, data: f.data || '', empresas: 0, rubricas: 0 }
            g.empresas++; g.rubricas += f.n
            grupos.set(key, g)
          }
        }
      }
      setEnvios([...grupos.values()].sort((a, b) => (Number(a.legado) - Number(b.legado)) || (b.data || '').localeCompare(a.data || '')))
    } catch (err) { setErro('Erro ao carregar envios: ' + err.message) } finally { setCarregEnv(false) }
  }

  async function excluirEnvio(env) {
    if (!window.confirm(`Excluir o envio "${env.doc}" (${TIPOKEY_LABEL[env.tipo] || env.tipo}) de ${env.empresas} empresa(s)? As rubricas desse arquivo saem de todas elas.`)) return
    setAplicando(true); setErro('')
    try {
      const [mes, ano] = alvo.split('/').map(Number)
      const { data: comps } = await supabase.from('competencias').select('id, status, integracoes').eq('ano', ano).eq('mes', mes)
      let n = 0
      for (const c of (comps || [])) {
        if (c.status === 'fechado') continue
        const folha = c.integracoes?.folha; const slot = folha?.arquivos?.[env.tipo]
        if (!slot) continue
        let eventos, files
        if (env.legado) {
          // Antigo: casa pelo nome do arquivo; tira os eventos SEM carimbo (mantém os novos, se houver).
          if ((slot.doc || '') !== env.doc) continue
          if (!(slot.eventos || []).some(e => !e.__arq)) continue
          eventos = (slot.eventos || []).filter(e => e.__arq)
          files = (slot.files || []).filter(f => f.arq && f.arq !== '__legado')
        } else {
          if (!(slot.eventos || []).some(e => e.__arq === env.arq)) continue
          eventos = (slot.eventos || []).filter(e => e.__arq !== env.arq)
          files = (slot.files || []).filter(f => f.arq !== env.arq)
        }
        const arquivos = { ...folha.arquivos }
        if (eventos.length) arquivos[env.tipo] = { doc: files.slice(-1)[0]?.doc || slot.doc, path: files.slice(-1)[0]?.path || '', eventos, files }
        else delete arquivos[env.tipo]
        const done = !!(arquivos.folha?.eventos?.length)
        const novaFolha = { ...folha, arquivos, estado: done ? 'validado' : null, doc: done ? 'Folha · rubricas cruzadas' : null, usuario: user?.email || null }
        await supabase.from('competencias').update({ integracoes: { ...c.integracoes, folha: novaFolha } }).eq('id', c.id)
        n++
      }
      setMsg(`Envio "${env.doc}" excluído de ${n} empresa(s).`)
      await carregarEnvios()
      recalcularPendencias?.()
    } catch (err) { setErro('Erro ao excluir envio: ' + err.message) } finally { setAplicando(false) }
  }

  return (
    <Bloco icon="ti-users-group" titulo="Folha em massa" desc="Suba UM relatório de rubricas do Domínio com várias empresas — o sistema quebra por empresa e joga a folha na Integração de cada cliente. Filial consolidada centraliza na matriz; individualizada vai na própria empresa.">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: theme.sub }}>Tipo:</span>
        <select className="input" style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }} value={tipo} onChange={e => setTipo(e.target.value)}>
          {TIPOS_FOLHA.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span style={{ fontSize: 12.5, color: theme.sub }}>Competência:</span>
        <select className="input" style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }} value={alvo} onChange={e => setAlvo(e.target.value)}>
          {(competencias || [competencia]).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
        <i className="ti ti-file-import" /> Subir arquivo ({tipoLabel})
        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={analisar} />
      </label>
      {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}

      {prev && (
        <div onClick={() => !aplicando && (setPrev(null), setDados(null))} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(620px,96vw)', maxHeight: '88vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>Folha em massa — {tipoLabel}</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
              Competência <b style={{ color: theme.text }}>{String(prev.mes).padStart(2, '0')}/{prev.ano}</b>. Cada empresa vira a folha <b style={{ color: theme.text }}>{tipoLabel}</b> na Integração do cliente. Filial consolidada é somada na <b>matriz</b>. Fechados são pulados.
            </p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              <Tag c={theme.green} n={prev.destinos.length} t="destino(s) a gravar" />
              {prev.matrizAusente.length > 0 && <Tag c={theme.yellow} n={prev.matrizAusente.length} t="sem matriz cadastrada" />}
              {prev.naoEncontrados.length > 0 && <Tag c={theme.red} n={prev.naoEncontrados.length} t="empresa(s) sem cadastro" />}
              {prev.semRubrica.length > 0 && <Tag c={theme.sub} n={prev.semRubrica.length} t="sem rubrica no arquivo" />}
            </div>
            {prev.destinos.length > 0 && (
              <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${theme.border}`, borderRadius: 10, marginBottom: 12 }}>
                {prev.destinos.map((d, i) => (
                  <div key={i} style={{ padding: '9px 12px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12.5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <b>{d.cod} · {d.nome}</b>
                      <span style={{ color: theme.sub, whiteSpace: 'nowrap' }}>{money(d.total)} · {d.eventos.length} rubrica(s)</span>
                    </div>
                    {d.fontes.some(f => f.consolida) && (
                      <div style={{ color: theme.sub, fontSize: 11.5, marginTop: 3 }}>
                        <i className="ti ti-arrows-join" /> consolida: {d.fontes.map(f => `${f.cod}${f.consolida ? '' : ' (matriz)'}`).join(' + ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {prev.matrizAusente.length > 0 && <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 8px' }}><b style={{ color: theme.yellow }}>Sem matriz:</b> {prev.matrizAusente.join(', ')}</p>}
            {prev.naoEncontrados.length > 0 && <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 12px' }}><b style={{ color: theme.red }}>Sem cadastro:</b> {prev.naoEncontrados.join(', ')}</p>}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14, fontSize: 12.5 }}>
              <span style={{ color: theme.sub }}>Se a empresa já tiver folha deste tipo:</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}><input type="radio" checked={modo === 'complementar'} onChange={() => setModo('complementar')} /> Complementar (soma)</label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}><input type="radio" checked={modo === 'substituir'} onChange={() => setModo('substituir')} /> Substituir</label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { setPrev(null); setDados(null) }} disabled={aplicando}>Cancelar</button>
              <button className="btn" onClick={aplicar} disabled={aplicando || !prev.destinos.length}>{aplicando ? 'Gravando…' : 'Gravar folha'}</button>
            </div>
          </div>
        </div>
      )}
      {msg && <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-info-circle" /> {msg}</p>}

      {/* Envios da competência — conferir e excluir um arquivo subido errado (em todas as empresas de uma vez) */}
      <div style={{ marginTop: 12, borderTop: `1px solid ${theme.border}`, paddingTop: 10 }}>
        <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '5px 10px' }} onClick={() => (envios ? setEnvios(null) : carregarEnvios())} disabled={carregEnv}>
          <i className={`ti ${envios ? 'ti-chevron-up' : 'ti-history'}`} /> {carregEnv ? 'Carregando…' : envios ? 'Ocultar envios' : `Envios de ${alvo}`}
        </button>
        {envios && (
          envios.length
            ? <div style={{ marginTop: 8, border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden' }}>
                {envios.map((e, i) => (
                  <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b>{e.doc}</b> <span style={{ color: theme.sub }}>· {TIPOKEY_LABEL[e.tipo] || e.tipo}</span></div>
                      <div style={{ color: theme.sub, fontSize: 11 }}>{e.data ? e.data + ' · ' : e.legado ? 'subido antes · ' : ''}{e.empresas} empresa(s) · {e.rubricas} rubrica(s)</div>
                    </div>
                    <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px', color: theme.red, borderColor: 'rgba(229,72,77,0.4)' }} onClick={() => excluirEnvio(e)} disabled={aplicando}><i className="ti ti-trash" /> excluir</button>
                  </div>
                ))}
              </div>
            : <p style={{ color: theme.sub, fontSize: 12, margin: '8px 0 0' }}>Nenhum envio de folha em massa nesta competência.</p>
        )}
      </div>
    </Bloco>
  )
}

// ---- Card: Recebimento de arquivos (extratos PDF/Excel, cross-client, sem renomear) ----
// O sistema RECONHECE cada arquivo em duas vias (nesta ordem):
//   1) Nome código-conta-… (atalho antigo, mantido).
//   2) Conteúdo: CNPJ → cliente; agência/conta → conta contábil pela MEMÓRIA aprendida.
// Depois mostra uma GRADE de conferência (verde/amarelo/vermelho) e, ao receber, aprende
// o número da conta confirmado (F4) para o próximo mês ser automático.
const nivelDe = row => {
  if (!row.destino) return 'vermelho'
  if (!row.cliente) return 'vermelho'
  if (!row.comp) return 'vermelho'
  if (row.comp.status === 'fechado') return 'vermelho'
  if (!String(row.conta || '').trim()) return 'amarelo'
  return 'verde'
}
const msgErro = row => {
  if (!row.destino) return `Formato .${row.ext} não suportado`
  if (!row.cliente) return 'Cliente não identificado — escolha ou renomeie código-conta'
  if (!row.comp) return `Sem fechamento ${row.alvo}`
  if (row.comp.status === 'fechado') return 'Fechamento fechado'
  return ''
}

function RecebeArquivos({ competencias, competencia, recalcularPendencias }) {
  const [alvo, setAlvo] = useState(competencia)
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [rows, setRows] = useState(null)   // grade de conferência (após analisar)
  const [rel, setRel] = useState(null)     // resultado final
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const clientesRef = useRef([])
  const planoCache = useRef(new Map())
  const compCache = useRef(new Map())

  const addFiles = list => { const arr = Array.from(list || []).filter(f => /\.(pdf|xlsx|xls|csv)$/i.test(f.name)); if (arr.length) { setFiles(f => [...f, ...arr]); setRows(null); setRel(null) } }
  const onDrop = e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files) }
  const fechar = () => { setOpen(false); setFiles([]); setRows(null); setRel(null) }

  const [mes, ano] = alvo.split('/').map(Number)
  async function planoDe(id) {
    if (planoCache.current.has(id)) return planoCache.current.get(id)
    const { data } = await supabase.from('cargas_cadastro').select('dados').eq('cliente_id', id).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
    const p = parsePlano(data?.dados); planoCache.current.set(id, p); return p
  }
  async function compDe(id) {
    const k = id + '|' + alvo
    if (compCache.current.has(k)) return compCache.current.get(k)
    const { data } = await supabase.from('competencias').select('id, status').eq('cliente_id', id).eq('ano', ano).eq('mes', mes).maybeSingle()
    compCache.current.set(k, data || null); return data || null
  }

  // Fase 1 — reconhece cada arquivo (nome → conteúdo) e monta a grade.
  async function analisar() {
    if (!files.length || busy) return
    setBusy(true)
    const { data: clientes } = await supabase.from('clientes').select('id, codigo_dominio, razao_social, cnpj')
    clientesRef.current = clientes || []
    const porCod = new Map((clientes || []).map(c => [String(c.codigo_dominio || '').trim(), c]))
    const porCnpj = new Map((clientes || []).map(c => [cnpj14(c.cnpj), c]))
    const memCache = new Map()
    const memDe = async id => { if (memCache.has(id)) return memCache.get(id); const m = await lerMemoriaContas(id); memCache.set(id, m); return m }

    const out = []
    for (const file of files) {
      const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
      const destino = ext === 'pdf' ? 'conciliacao' : (['xlsx', 'xls', 'csv'].includes(ext) ? 'integracao' : null)
      const row = { file, nome: file.name, ext, destino, alvo, cliente: null, clienteVia: null, conta: '', contaVia: null, agencia: '', contaBanco: '', comp: null }
      if (destino) {
        // 1) Nome código-conta (atalho antigo).
        const pn = parseNomeArquivo(file.name)
        const cliNome = pn.cli && porCod.get(String(pn.cli).trim())
        if (cliNome) { row.cliente = cliNome; row.clienteVia = 'nome'; if (pn.conta) { row.conta = String(pn.conta).trim(); row.contaVia = 'nome' } }
        // 2) Conteúdo (CNPJ + impressão digital da conta), quando faltou algo.
        if (!row.cliente || !row.conta) {
          const id = await lerIdentificacao(file)
          row.agencia = id.agencia; row.contaBanco = id.conta
          if (!row.cliente) for (const c of (id.cnpjs || [])) { const cli = porCnpj.get(cnpj14(c)); if (cli) { row.cliente = cli; row.clienteVia = 'cnpj'; break } }
          if (row.cliente && !row.conta) {
            const fp = chaveContaBanco(id.agencia, id.conta)
            const mem = await memDe(row.cliente.id)
            if (fp && mem[fp]) { row.conta = mem[fp]; row.contaVia = 'memoria' }
          }
        }
        if (row.cliente) { row.plano = await planoDe(row.cliente.id); row.comp = await compDe(row.cliente.id) }
      }
      out.push(row)
    }
    setRows(out); setBusy(false)
  }

  // Troca manual de cliente numa linha (para os vermelhos "não identificado").
  async function escolherCliente(i, cliId) {
    const cli = clientesRef.current.find(c => c.id === cliId) || null
    const plano = cli ? await planoDe(cli.id) : []
    const comp = cli ? await compDe(cli.id) : null
    setRows(rs => rs.map((r, j) => j === i ? { ...r, cliente: cli, clienteVia: cli ? 'manual' : null, plano, comp } : r))
  }
  const setConta = (i, v) => setRows(rs => rs.map((r, j) => j === i ? { ...r, conta: v, contaVia: 'manual' } : r))

  // Fase 2 — recebe o que está verde (aprende a conta confirmada).
  async function receber() {
    if (busy || !rows) return
    setBusy(true)
    const resultado = [], vistos = new Set(), marc = new Map()
    for (const row of rows) {
      const nivel = nivelDe(row)
      const base = { nome: row.nome, cliente: row.cliente?.razao_social }
      if (nivel !== 'verde') { resultado.push({ ...base, nivel: 'erro', msg: nivel === 'amarelo' ? 'Sem conta — não recebido' : msgErro(row) }); continue }
      const cli = row.cliente, conta = String(row.conta).trim(), comp = row.comp
      const chave = cli.id + '|' + conta + '|' + row.destino
      if (vistos.has(chave)) { resultado.push({ ...base, nivel: 'erro', msg: 'Duplicado no lote' }); continue }
      vistos.add(chave)
      try {
        let path
        if (row.destino === 'conciliacao') {
          const r = await anexarExtratoPdf({ compId: comp.id, conta, file: row.file }); path = r.path
          resultado.push(r.saldoLido != null
            ? { ...base, nivel: 'ok', msg: `Conciliação · conta ${conta} · saldo ${money(r.saldoLido)}` }
            : { ...base, nivel: 'duvida', msg: `Conciliação · conta ${conta} · informe o saldo lá` })
        } else {
          const e1 = await anexarExtratoExcel({ compId: comp.id, conta, file: row.file }); path = e1.path
          let r
          try { r = await alimentarIntegracaoFinanceira({ compId: comp.id, empresaId: cli.id, conta, file: row.file }) } catch (e) { r = { classificado: false, motivo: e.message } }
          resultado.push(r?.classificado
            ? { ...base, nivel: 'ok', msg: `Integração · conta ${conta} · ${r.classificadas}/${r.total} sugeridos` }
            : { ...base, nivel: 'duvida', msg: /perfil/i.test(r?.motivo || '')
                ? `Integração · conta ${conta} · falta o PERFIL DE LEITURA — faça a 1ª importação na Integração`
                : `Integração · conta ${conta} · ajuste a leitura (${r?.motivo || '—'})` })
        }
        const arr = marc.get(comp.id) || []; arr.push({ conta, tipo: row.destino, path, arquivo: row.nome }); marc.set(comp.id, arr)
        // Aprende: número da conta do extrato → conta contábil confirmada (para o próximo mês).
        if (row.contaBanco) { try { await lembrarContaBancaria(cli.id, { conta_contabil: conta, agencia: row.agencia, conta: row.contaBanco }) } catch { /* aprendizado é best-effort */ } }
      } catch (e) { resultado.push({ ...base, nivel: 'erro', msg: 'Falha: ' + e.message }) }
    }
    // Marca "recebido" + guarda o arquivo nos documentos que têm a conta recebida.
    const hoje = new Date().toLocaleDateString('pt-BR').slice(0, 5)
    for (const [compId, itens] of marc) {
      const { data: c } = await supabase.from('competencias').select('documentos').eq('id', compId).maybeSingle()
      const lista = Array.isArray(c?.documentos) ? c.documentos : []
      if (!lista.length) continue
      const novos = [...lista]
      const usados = new Set()
      let mudou = false
      // Cada arquivo marca a linha do checklist que casa por CONTA + TIPO (PDF→conciliação,
      // Excel→integração). Assim, dois documentos na mesma conta (extrato e planilha) não se
      // atropelam. Sem tipo definido → casa por conta (compatível com o que já existe).
      const casa = (it, exigirTipo) => novos.findIndex((d, j) => !usados.has(j)
        && String(d.conta || '').trim() === String(it.conta)
        && (exigirTipo == null ? true : tipoEfetivoDoc(d) === exigirTipo))
      for (const it of itens) {
        let idx = casa(it, it.tipo)          // conta + tipo do arquivo
        if (idx < 0) idx = casa(it, '')      // conta + documento sem tipo definido
        if (idx < 0) idx = casa(it, null)    // qualquer documento com a conta
        if (idx >= 0) { usados.add(idx); novos[idx] = { ...novos[idx], situacao: 'recebido', rec: true, date: hoje, arquivo_path: it.path, arquivo: it.arquivo }; mudou = true }
      }
      if (mudou) await supabase.from('competencias').update({ documentos: novos }).eq('id', compId)
    }
    if (marc.size) recalcularPendencias?.()
    setRel(resultado); setBusy(false)
  }

  const COR = { ok: theme.green, duvida: theme.yellow, erro: theme.red }
  const ICO = { ok: 'ti-circle-check', duvida: 'ti-alert-triangle', erro: 'ti-circle-x' }
  const CORN = { verde: theme.green, amarelo: theme.yellow, vermelho: theme.red }
  const VIA = { nome: 'nome', cnpj: 'CNPJ', memoria: 'memória', manual: 'manual' }
  const resumo = rel ? { ok: rel.filter(r => r.nivel === 'ok').length, duvida: rel.filter(r => r.nivel === 'duvida').length, erro: rel.filter(r => r.nivel === 'erro').length } : null
  const cont = rows ? { verde: rows.filter(r => nivelDe(r) === 'verde').length, amarelo: rows.filter(r => nivelDe(r) === 'amarelo').length, vermelho: rows.filter(r => nivelDe(r) === 'vermelho').length } : null

  return (
    <>
      <Bloco icon="ti-cloud-upload" titulo="Recebimento de arquivos" desc="Solte os extratos de vários clientes de uma vez — sem renomear. O sistema lê o CNPJ (cliente) e a conta bancária (conta contábil), mostra a conferência e aprende para o próximo mês. PDF → Conciliação; Excel → Integração.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: theme.sub }}>Competência:</span>
          <select className="input" style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }} value={alvo} onChange={e => setAlvo(e.target.value)}>
            {(competencias || [competencia]).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button className="btn" style={{ fontSize: 13 }} onClick={() => setOpen(true)}><i className="ti ti-upload" /> Importar arquivos</button>
      </Bloco>

      {open && (
        <div onClick={e => { if (e.target === e.currentTarget && !busy) fechar() }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 55 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(760px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>Recebimento de arquivos · {alvo}</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>Arraste os extratos — <b style={{ color: theme.text }}>não precisa renomear</b>. O sistema identifica o cliente pelo CNPJ e a conta pela memória; confira e receba. Nomear <b style={{ color: theme.text }}>código-conta-…</b> continua funcionando como atalho.</p>

            {!rel && (
              <label onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
                style={{ display: 'block', border: `1.5px dashed ${drag ? theme.accent : theme.border}`, borderRadius: 12, padding: '24px 16px', textAlign: 'center', cursor: 'pointer', background: drag ? 'rgba(74,124,255,0.06)' : theme.input }}>
                <i className="ti ti-cloud-upload" style={{ fontSize: 26, color: theme.accent }} />
                <p style={{ margin: '8px 0 0', fontSize: 13, color: theme.text }}>Arraste os arquivos aqui, ou clique para escolher</p>
                <p style={{ margin: '2px 0 0', fontSize: 11.5, color: theme.sub }}>PDF, XLSX, XLS ou CSV</p>
                <input type="file" multiple accept=".pdf,.xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
              </label>
            )}

            {/* Lista simples antes de analisar */}
            {files.length > 0 && !rows && !rel && (
              <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                {files.map((f, i) => {
                  const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '?').toLowerCase()
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '7px 10px', background: theme.input, borderRadius: 8 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 10.5, fontWeight: 800, color: '#fff', background: ext === 'pdf' ? theme.accent : theme.green, borderRadius: 5, padding: '2px 5px' }}>{ext.toUpperCase()}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <i className="ti ti-x" style={{ cursor: 'pointer', color: theme.sub }} onClick={() => setFiles(files.filter((_, j) => j !== i))} />
                    </div>
                  )
                })}
              </div>
            )}

            {/* Grade de conferência */}
            {rows && !rel && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', gap: 16, fontSize: 12.5, marginBottom: 10 }}>
                  <span style={{ color: theme.green }}><b>{cont.verde}</b> pronto</span>
                  <span style={{ color: theme.yellow }}><b>{cont.amarelo}</b> falta conta</span>
                  <span style={{ color: theme.red }}><b>{cont.vermelho}</b> sem cliente</span>
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {rows.map((row, i) => {
                    const nivel = nivelDe(row)
                    const ext = (row.ext || '?').toUpperCase()
                    return (
                      <div key={i} style={{ padding: '10px 12px', background: theme.input, borderRadius: 10, borderLeft: `3px solid ${CORN[nivel]}`, display: 'grid', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 800, color: '#fff', background: row.ext === 'pdf' ? theme.accent : theme.green, borderRadius: 5, padding: '2px 5px' }}>{ext}</span>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.nome}</span>
                          {nivel === 'vermelho' && <span style={{ color: theme.red, fontSize: 11 }}>{msgErro(row)}</span>}
                        </div>
                        {row.destino && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {/* Cliente */}
                            {row.cliente
                              ? <span style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <i className="ti ti-building" style={{ color: theme.sub }} /> <b>{row.cliente.razao_social}</b>
                                  <span style={{ fontSize: 9.5, color: theme.sub, border: `0.5px solid ${theme.cb}`, borderRadius: 5, padding: '1px 5px' }}>{VIA[row.clienteVia] || '—'}</span>
                                </span>
                              : <select className="input" style={{ width: 'auto', maxWidth: 260, padding: '5px 8px', fontSize: 12 }} value="" onChange={e => escolherCliente(i, e.target.value)}>
                                  <option value="">Escolher cliente…</option>
                                  {clientesRef.current.map(c => <option key={c.id} value={c.id}>{c.razao_social}</option>)}
                                </select>}
                            {/* Conta contábil (F4 com o plano do cliente da linha) */}
                            {row.cliente && row.comp && row.comp.status !== 'fechado' && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                                <span style={{ fontSize: 11, color: theme.sub }}>Conta:</span>
                                <div style={{ width: 150 }}>
                                  <CampoConta value={row.conta} plano={row.plano || []} placeholder="F4 = plano" onChange={v => setConta(i, v)} onPick={p => setConta(i, p.cod)} />
                                </div>
                                {row.contaVia === 'memoria' && <span title="Reconhecida pela memória" style={{ fontSize: 9.5, color: theme.green, border: `0.5px solid ${theme.green}`, borderRadius: 5, padding: '1px 5px' }}>memória</span>}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Resultado final */}
            {rel && (
              <div style={{ marginTop: 4 }}>
                <div style={{ display: 'flex', gap: 16, fontSize: 12.5, marginBottom: 10 }}>
                  <span style={{ color: theme.green }}><b>{resumo.ok}</b> ok</span>
                  <span style={{ color: theme.yellow }}><b>{resumo.duvida}</b> dúvida</span>
                  <span style={{ color: theme.red }}><b>{resumo.erro}</b> erro</span>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {rel.map((r, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '8px 10px', background: theme.input, borderRadius: 8, borderLeft: `3px solid ${COR[r.nivel]}` }}>
                      <i className={`ti ${ICO[r.nivel]}`} style={{ color: COR[r.nivel], fontSize: 16 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nome}</span>
                        {r.cliente && <span style={{ color: theme.sub, fontSize: 11 }}>{r.cliente}</span>}
                      </span>
                      <span style={{ color: theme.sub, fontSize: 11.5, textAlign: 'right', maxWidth: '50%' }}>{r.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={fechar} disabled={busy}>{rel ? 'Fechar' : 'Cancelar'}</button>
              {!rows && !rel && <button className="btn" disabled={!files.length || busy} onClick={analisar}>{busy ? 'Lendo arquivos…' : `Analisar ${files.length || ''}`.trim()}</button>}
              {rows && !rel && <button className="btn" disabled={busy || !cont.verde} onClick={receber}>{busy ? 'Recebendo…' : `Receber ${cont.verde || ''}`.trim()}</button>}
              {rel && <button className="btn" onClick={() => { setFiles([]); setRows(null); setRel(null) }}>Receber mais</button>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
