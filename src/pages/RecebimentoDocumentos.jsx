import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'
import { parseNomeArquivo, anexarExtratoPdf, anexarExtratoExcel, alimentarIntegracaoFinanceira } from '../lib/importacaoMassa'

const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)
const situOf = d => { const s = d?.situacao ?? (d?.rec ? 'recebido' : ''); return ['', 'recebido', 'nao_tem', 'nao_enviou'].includes(s) ? s : '' }
// Destino do documento (com compatibilidade do legado 'conta' = conciliação).
const rotaDoc = d => d.tipo === 'integracao' ? 'integracao' : (d.tipo === 'conciliacao' || d.tipo === 'conta') ? 'conciliacao' : ''
const rotaLabel = r => r === 'integracao' ? 'integração' : 'conciliação'
const normaliza = arr => (arr || []).map(x => ({
  name: String(x.name || '').trim(), tipo: x.tipo || '', conta: x.conta || '',
  arquivo_path: x.arquivo_path || '', arquivo: x.arquivo || '',
  situacao: situOf(x), rec: situOf(x) === 'recebido', date: x.date || '',
})).filter(x => x.name)

export default function RecebimentoDocumentos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const [codDominio, setCodDominio] = useState('')
  const [docs, setDocs] = useState([])
  const [status, setStatus] = useState(null)
  const [files, setFiles] = useState([])
  const [rel, setRel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [carregando, setCarregando] = useState(true)

  const ro = status === 'fechado'

  useEffect(() => {
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true); setRel(null); setFiles([])
    const [mes, ano] = competencia.split('/').map(Number)
    ;(async () => {
      supabase.from('clientes').select('codigo_dominio').eq('id', empresaId).maybeSingle()
        .then(({ data }) => setCodDominio(data?.codigo_dominio || ''))
      const { data: comp } = await supabase.from('competencias').select('documentos, status')
        .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      setStatus(comp?.status || null)
      setDocs(normaliza(comp?.documentos))
      setCarregando(false)
    })()
  }, [empresaId, competencia])

  const addFiles = list => { const arr = Array.from(list || []); if (arr.length && !ro) { setFiles(f => [...f, ...arr]); setRel(null) } }
  const onDrop = e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer?.files) }

  const contasComDoc = docs.filter(d => rotaDoc(d) && String(d.conta || '').trim())

  async function processar() {
    if (!files.length || busy || ro) return
    setBusy(true)
    const compId = await getCompetenciaId()
    if (!compId) { setBusy(false); setRel([{ nome: '—', nivel: 'erro', msg: 'Abra um fechamento para esta competência.' }]); return }
    const porConta = {}
    for (const d of docs) { const r = rotaDoc(d); const c = String(d.conta || '').trim(); if (r && c) { (porConta[c] = porConta[c] || {})[r] = d } }
    const resultado = [], recebidos = new Map(), vistos = new Set()
    for (const file of files) {
      const p = parseNomeArquivo(file.name)
      const linha = { nome: file.name }
      if (!p.cli || !p.conta) { resultado.push({ ...linha, nivel: 'erro', msg: 'Nome fora do padrão cliente-conta' }); continue }
      if (codDominio && String(p.cli) !== String(codDominio)) { resultado.push({ ...linha, nivel: 'erro', msg: `Cliente ${p.cli} ≠ ${codDominio} (este cadastro)` }); continue }
      const destino = p.ext === 'pdf' ? 'conciliacao' : (['xlsx', 'xls', 'csv'].includes(p.ext) ? 'integracao' : null)
      if (!destino) { resultado.push({ ...linha, nivel: 'erro', msg: `Formato .${p.ext} não suportado (use PDF ou Excel)` }); continue }
      const doc = porConta[String(p.conta).trim()]?.[destino]
      if (!doc) { resultado.push({ ...linha, nivel: 'erro', msg: `Conta ${p.conta} sem documento de ${rotaLabel(destino)} cadastrado` }); continue }
      const chave = p.conta + '|' + destino
      if (vistos.has(chave)) { resultado.push({ ...linha, nivel: 'erro', msg: 'Duplicado no lote (mesma conta e destino)' }); continue }
      vistos.add(chave)
      try {
        if (destino === 'conciliacao') {
          const { saldoLido, path } = await anexarExtratoPdf({ compId, conta: p.conta, file })
          recebidos.set(doc.name, { arquivo_path: path, arquivo: file.name })
          resultado.push(saldoLido != null
            ? { ...linha, nivel: 'ok', msg: `Conciliação · saldo lido ${money(saldoLido)}` }
            : { ...linha, nivel: 'duvida', msg: 'Conciliação · anexado, mas informe o saldo lá' })
        } else {
          const { path } = await anexarExtratoExcel({ compId, conta: p.conta, file })
          recebidos.set(doc.name, { arquivo_path: path, arquivo: file.name })
          let r
          try { r = await alimentarIntegracaoFinanceira({ compId, empresaId, conta: p.conta, file, usuario: null }) } catch (e) { r = { classificado: false, motivo: e.message } }
          resultado.push(r?.classificado
            ? { ...linha, nivel: 'ok', msg: `Integração · ${r.classificadas}/${r.total} lançamentos sugeridos` }
            : { ...linha, nivel: 'duvida', msg: `Integração · Excel recebido; classifique lá (${r?.motivo || 'não classificado'})` })
        }
      } catch (e) { resultado.push({ ...linha, nivel: 'erro', msg: 'Falha ao subir: ' + e.message }) }
    }
    // Marca como recebido + guarda o caminho do arquivo, e persiste na competência.
    if (recebidos.size) {
      const novos = docs.map(d => recebidos.has(d.name)
        ? { ...d, situacao: 'recebido', rec: true, date: hojeCurto(), ...recebidos.get(d.name) } : d)
      setDocs(novos)
      await supabase.from('competencias').update({ documentos: novos }).eq('id', compId)
      recalcularPendencias && recalcularPendencias()
    }
    setRel(resultado); setBusy(false)
  }

  const COR = { ok: theme.green, duvida: theme.yellow, erro: theme.red }
  const ICO = { ok: 'ti-circle-check', duvida: 'ti-alert-triangle', erro: 'ti-circle-x' }
  const resumo = rel ? { ok: rel.filter(r => r.nivel === 'ok').length, duvida: rel.filter(r => r.nivel === 'duvida').length, erro: rel.filter(r => r.nivel === 'erro').length } : null

  if (!empresaId) return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para receber os documentos." /></Wrapper>

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
        {codDominio && <> · código <b style={{ color: theme.text }}>{codDominio}</b></>}
        {ro && <span style={{ marginLeft: 10, color: theme.red, fontWeight: 600 }}><i className="ti ti-lock" /> Fechado · somente leitura</span>}
      </p>

      {/* Área de drop */}
      <label onDragOver={e => { e.preventDefault(); if (!ro) setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        style={{ display: 'block', border: `1.5px dashed ${drag ? theme.accent : theme.border}`, borderRadius: 14, padding: '30px 18px', textAlign: 'center', cursor: ro ? 'not-allowed' : 'pointer', background: drag ? 'rgba(74,124,255,0.06)' : theme.card, opacity: ro ? 0.6 : 1 }}>
        <i className="ti ti-cloud-upload" style={{ fontSize: 32, color: theme.accent }} />
        <p style={{ margin: '10px 0 0', fontSize: 14.5, color: theme.text, fontWeight: 600 }}>Arraste os documentos aqui, ou clique para escolher</p>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: theme.sub }}>Nomeie cada arquivo com <b style={{ color: theme.text }}>{codDominio || 'código'}-conta-…</b> · PDF (conciliação) ou Excel (integração)</p>
        <input type="file" multiple accept=".pdf,.xlsx,.xls,.csv" disabled={ro} style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
      </label>

      {contasComDoc.length === 0 && !carregando && (
        <p style={{ color: theme.yellow, fontSize: 12.5, marginTop: 12 }}>
          <i className="ti ti-alert-triangle" /> Nenhum documento com conta cadastrada nesta competência. Cadastre o de-para no <b style={{ color: theme.text }}>Controle de Documentos</b> (destino + conta) para o roteamento funcionar.
        </p>
      )}

      {/* Fila de arquivos */}
      {files.length > 0 && !rel && (
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
          {files.map((f, i) => {
            const p = parseNomeArquivo(f.name)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '8px 11px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 9 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 10.5, fontWeight: 800, color: '#fff', background: p.ext === 'pdf' ? theme.accent : theme.green, borderRadius: 5, padding: '2px 5px' }}>{(p.ext || '?').toUpperCase()}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ color: theme.sub, fontSize: 11 }}>{p.conta ? 'conta ' + p.conta : 'sem conta'}</span>
                <i className="ti ti-x" style={{ cursor: 'pointer', color: theme.sub }} onClick={() => setFiles(files.filter((_, j) => j !== i))} />
              </div>
            )
          })}
          <div>
            <button className="btn" disabled={!files.length || busy || ro} onClick={processar}>{busy ? 'Processando…' : `Receber ${files.length} documento(s)`}</button>
          </div>
        </div>
      )}

      {/* Relatório */}
      {rel && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 12 }}>
            <span style={{ color: theme.green }}><i className="ti ti-circle-check" /> <b>{resumo.ok}</b> ok</span>
            <span style={{ color: theme.yellow }}><i className="ti ti-alert-triangle" /> <b>{resumo.duvida}</b> dúvida</span>
            <span style={{ color: theme.red }}><i className="ti ti-circle-x" /> <b>{resumo.erro}</b> erro</span>
            <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12.5 }} onClick={() => { setFiles([]); setRel(null) }}>Receber mais</button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {rel.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '9px 11px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 9, borderLeft: `3px solid ${COR[r.nivel]}` }}>
                <i className={`ti ${ICO[r.nivel]}`} style={{ color: COR[r.nivel], fontSize: 16 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nome}</span>
                <span style={{ color: theme.sub, fontSize: 11.5, textAlign: 'right', maxWidth: '55%' }}>{r.msg}</span>
              </div>
            ))}
          </div>
          <p style={{ color: theme.sub, fontSize: 12, marginTop: 12 }}>
            <i className="ti ti-info-circle" style={{ color: theme.accent }} /> Os documentos recebidos já aparecem marcados no <b style={{ color: theme.text }}>Controle de Documentos</b> (com opção de ver o arquivo). Conciliação e Integração já refletem o que subiu.
          </p>
        </div>
      )}
    </Wrapper>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Recebimento de Documentos</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 20, maxWidth: 820 }}>
        Solte os documentos do cliente de uma vez. O nome do arquivo (<b style={{ color: theme.text }}>código-conta-…</b>) roteia cada um: <b style={{ color: theme.text }}>PDF</b> sobe para a Conciliação (lê o saldo) e <b style={{ color: theme.text }}>Excel</b> vai classificado para a Integração. O que subir fica marcado como <b style={{ color: theme.text }}>recebido</b> no Controle de Documentos.
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
