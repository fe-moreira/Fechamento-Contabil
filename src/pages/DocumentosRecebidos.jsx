import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'
import { receberArquivo, verArquivoImportado, excluirArquivoRecebido, tipoEfetivoDoc } from '../lib/importacaoMassa'
import CampoConta from '../components/CampoConta'

// Lista padrão (só nomes — sem separação por departamento).
const PADRAO = ['Extratos bancários', 'Notas fiscais de entrada', 'Notas fiscais de saída', 'Folha de pagamento', 'Guias de impostos (DARF/GPS/DAS)', 'Razão do Domínio']
const hojeCurto = () => new Date().toLocaleDateString('pt-BR').slice(0, 5)

// Tipo do documento — decide para onde o arquivo daquela conta vai:
//   conciliacao  extrato do banco (PDF) → Conciliação
//   integracao   planilha do sistema (Excel) → Integração financeira
// Vazio = Auto: o sistema deduz pela descrição/formato. Permite duas linhas na MESMA conta
// (extrato + planilha) sem uma marcar a outra.
const TIPO = { '': { label: 'Auto', curto: '' }, conciliacao: { label: 'Conciliação (PDF)', curto: 'conciliação' }, integracao: { label: 'Integração (Excel)', curto: 'integração' } }
const tipoCanon = v => { const s = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); if (/pdf|concil/.test(s)) return 'conciliacao'; if (/excel|integr|planilha/.test(s)) return 'integracao'; return '' }

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
// Cada documento tem uma CONTA contábil (chave que casa com o arquivo código-conta) e,
// quando recebido, o caminho do arquivo guardado (para ver/baixar).
const novoDoc = (name, conta = '', tipo = '') => ({ name, conta, tipo, arquivo_path: '', arquivo: '', situacao: '', rec: false, date: '' })
// Mantém a lista sempre em ordem alfabética (inclusive itens novos).
const ordenar = arr => [...(arr || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR', { sensitivity: 'base' }))
// Converte formato antigo (rec bool) e novo (situacao) para o mesmo shape.
const normaliza = (arr) => (arr || []).map(x => {
  const name = String(x.name || '').trim()
  const situacao = situOf(x)
  return { name, conta: x.conta || '', tipo: x.tipo || '', arquivo_path: x.arquivo_path || '', arquivo: x.arquivo || '', situacao, rec: situacao === 'recebido', date: x.date || '' }
}).filter(x => x.name)

export default function DocumentosRecebidos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const [docs, setDocs] = useState([])
  const [status, setStatus] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState('')
  const [contaNovo, setContaNovo] = useState('')
  const [tipoNovo, setTipoNovo] = useState('')
  const [editIdx, setEditIdx] = useState(null)
  const [editNome, setEditNome] = useState('')
  const [editConta, setEditConta] = useState('')
  const [editTipo, setEditTipo] = useState('')
  const [subindo, setSubindo] = useState(null) // índice do documento com upload em andamento
  const [msg, setMsg] = useState('')
  const [fSit, setFSit] = useState('todos')    // filtro por situação ('todos' | '' pendente | recebido | nao_tem | nao_enviou)

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
        setDocs(ordenar(herdado.map(x => novoDoc(x.name, x.conta, x.tipo))))
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
    const contaPorNome = Object.fromEntries(novo.map(d => [d.name, d.conta || '']))
    const tipoPorNome = Object.fromEntries(novo.map(d => [d.name, d.tipo || '']))
    for (const c of futuras) {
      const recPorNome = Object.fromEntries(normaliza(c.documentos).map(x => [x.name, x]))
      // Conta e tipo são definição do documento → propagam; situação/arquivo do mês são preservados.
      const merged = nomes.map(name => { const prev = recPorNome[name]; return prev ? { ...prev, conta: contaPorNome[name], tipo: tipoPorNome[name] } : novoDoc(name, contaPorNome[name], tipoPorNome[name]) })
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
  const incluir = () => { if (ro || !nome.trim()) return; persistir([...docs, novoDoc(nome.trim(), contaNovo.trim(), tipoNovo)], true); setNome(''); setContaNovo(''); setTipoNovo('') }
  const abrirEdicao = (i) => { setEditIdx(i); setEditNome(docs[i].name); setEditConta(docs[i].conta || ''); setEditTipo(docs[i].tipo || '') }
  const salvarEdicao = () => {
    const n = editNome.trim()
    if (n && editIdx !== null) persistir(docs.map((d, j) => j === editIdx ? { ...d, name: n, conta: editConta.trim(), tipo: editTipo } : d), true)
    setEditIdx(null); setEditNome(''); setEditConta(''); setEditTipo('')
  }

  // Upload individual: recebe o arquivo, roteia (PDF→conciliação lê saldo; Excel→integração
  // classifica/sugere; sem conta → arquivo avulso), marca RECEBIDO e guarda o caminho.
  async function uploadDoc(i, file) {
    if (!file || ro) return
    const compId = await getCompetenciaId()
    if (!compId) { setMsg('Abra um fechamento para esta competência.'); return }
    setSubindo(i)
    try {
      const r = await receberArquivo({ compId, empresaId, conta: (docs[i].conta || '').trim(), file })
      persistir(docs.map((d, j) => j === i ? { ...d, situacao: 'recebido', rec: true, date: hojeCurto(), arquivo_path: r.path, arquivo: file.name } : d))
      const integMsg = r.integ?.classificado
        ? ` · ${r.integ.classificadas}/${r.integ.total} lançamentos sugeridos`
        : /perfil/i.test(r.integ?.motivo || '')
          ? ' · a Integração ainda não tem o PERFIL DE LEITURA deste banco — faça a 1ª importação na tela Integração para o sistema aprender o layout; depois os próximos meses entram automáticos'
          : ` · ajuste a leitura na Integração${r.integ?.motivo ? ` (${r.integ.motivo})` : ''}`
      const extra = r.destino === 'conciliacao'
        ? (r.saldoLido != null
            ? (r.via === 'amarelo'
                ? ` · saldo = SOMA de ${r.n} valor(es) destacado(s) em amarelo = ${money(r.saldoLido)}`
                : ` · saldo lido AUTOMATICAMENTE = ${money(r.saldoLido)} — confira; se precisar somar vários saldos, pinte-os de amarelo (destaque) e suba de novo`)
            : ' · não identifiquei o saldo — informe na conciliação (ou pinte de amarelo)')
        : r.destino === 'integracao' ? integMsg
        : ''
      setMsg(`“${docs[i].name}” recebido${extra}.`)
    } catch (e) { setMsg('Erro ao subir: ' + e.message) } finally { setSubindo(null) }
  }
  const limparDoc = (i) => persistir(docs.map((x, j) => j === i ? { ...x, arquivo_path: '', arquivo: '', situacao: '', rec: false, date: '' } : x))
  // Ver o arquivo; se ele não existir mais no Storage, auto-corrige: volta o documento a pendente.
  async function verArquivo(i) {
    const d = docs[i]
    try { await verArquivoImportado(d.arquivo_path) }
    catch (e) {
      if (/not found|não encontrad|no such|does not exist/i.test(e.message || '')) {
        await limparDoc(i)
        setMsg(`O arquivo de “${d.name}” não está mais no armazenamento — o documento voltou a pendente. Suba novamente.`)
      } else setMsg('Não consegui abrir o arquivo: ' + e.message)
    }
  }
  // Exclui o arquivo (subiu errado / conta errada): apaga do Storage, limpa o anexo/saldo
  // da conciliação se for o caso, e o documento volta a PENDENTE. A limpeza é best-effort —
  // mesmo que ela falhe, o documento SEMPRE é resetado (não pode ficar travado em "recebido").
  async function excluirArquivo(i) {
    const d = docs[i]
    if (!d.arquivo_path || ro) return
    if (!confirm(`Excluir o arquivo de “${d.name}”? O documento volta a ficar pendente.`)) return
    setSubindo(i)
    try { await excluirArquivoRecebido({ path: d.arquivo_path, conta: (d.conta || '').trim(), compId: await getCompetenciaId() }) } catch (e) { console.error('excluir arquivo:', e) }
    await limparDoc(i)
    setMsg(`Arquivo de “${d.name}” excluído — voltou a pendente.`)
    setSubindo(null)
  }

  async function baixarModelo() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([['Documento', 'Conta contábil', 'Tipo (Conciliação/Integração ou vazio)'], ...PADRAO.map(n => [n, '', ''])])
    ws['!cols'] = [{ wch: 46 }, { wch: 18 }, { wch: 34 }]
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
      let body = rows
      if (body[0] && /^documento/i.test(String(body[0][0] ?? ''))) body = body.slice(1) // ignora cabeçalho
      const seen = new Set(), itens = []
      for (const r of body) {
        const name = String(r[0] ?? '').trim(); if (!name || seen.has(name)) continue
        seen.add(name); itens.push(novoDoc(name, String(r[1] ?? '').trim(), tipoCanon(r[2])))
      }
      if (!itens.length) { setMsg('Nenhum documento encontrado na planilha (coluna A).'); return }
      if (!confirm(`Importar ${itens.length} documento(s)? Isso substitui a lista desta competência (em diante).`)) return
      await persistir(itens, true)
      setMsg(`${itens.length} documento(s) importado(s).`)
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
  const docsVis = docs.map((d, i) => [d, i]).filter(([d]) => fSit === 'todos' ? true : situOf(d) === fSit)

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
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Nome do documento" value={nome}
              onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === 'Enter' && incluir()} />
            <CampoConta value={contaNovo} onChange={setContaNovo} onEnter={incluir} placeholder="Conta (F4)" style={{ width: 170 }} />
            <select className="input" style={{ width: 'auto', padding: '8px 10px' }} value={tipoNovo} onChange={e => setTipoNovo(e.target.value)} title="Tipo: para onde vai o arquivo desta conta">
              {Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <button className="btn" onClick={incluir}><i className="ti ti-plus" /> Incluir</button>
            <span style={{ width: 1, height: 24, background: theme.border, margin: '0 2px' }} />
            <label className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <i className="ti ti-file-import" /> Importar Excel
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={importar} />
            </label>
            <button className="btn btn-ghost" onClick={baixarModelo}><i className="ti ti-file-spreadsheet" /> Baixar modelo</button>
          </div>
          <p style={{ fontSize: 11.5, color: theme.sub, margin: '9px 2px 0' }}>
            Amarre a <b style={{ color: theme.text }}>conta contábil</b> (F4) em cada documento. Quando a mesma conta tiver dois arquivos — <b style={{ color: theme.text }}>extrato (PDF)</b> e <b style={{ color: theme.text }}>planilha (Excel)</b> — use o <b style={{ color: theme.text }}>Tipo</b> para o PDF ir à Conciliação e o Excel à Integração (deixe em <b style={{ color: theme.text }}>Auto</b> que ele deduz pela descrição). <b style={{ color: theme.text }}>Recebido</b> é automático ao subir o arquivo (aqui ou em <b style={{ color: theme.text }}>Importação em massa</b>). Sem baixa manual.
          </p>
        </div>
      )}

      {/* Filtro por situação */}
      {docs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 10px' }}>
          {[
            { k: 'todos', label: 'Todos', n: total, cor: theme.text },
            { k: '', label: 'Pendentes', n: cont[''], cor: theme.yellow },
            { k: 'recebido', label: 'Recebidos', n: cont.recebido, cor: theme.green },
            { k: 'nao_tem', label: 'Não tem', n: cont.nao_tem, cor: theme.sub },
            { k: 'nao_enviou', label: 'Não enviou', n: cont.nao_enviou, cor: theme.red },
          ].map(c => (
            <button key={c.k} onClick={() => setFSit(c.k)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                border: `1px solid ${fSit === c.k ? c.cor : theme.border}`, background: fSit === c.k ? `${c.cor}22` : 'transparent', color: fSit === c.k ? c.cor : theme.sub, fontWeight: fSit === c.k ? 700 : 500 }}>
              {c.label} <b style={{ color: c.cor }}>{c.n}</b>
            </button>
          ))}
        </div>
      )}

      {/* Lista */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        {carregando ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Carregando…</p>
        ) : docs.length === 0 ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Nenhum documento na lista.{!ro && ' Inclua acima ou importe do Excel.'}</p>
        ) : docsVis.length === 0 ? (
          <p style={{ padding: 18, color: theme.sub, fontSize: 13 }}>Nenhum documento nesta situação.</p>
        ) : docsVis.map(([d, i], k) => {
          const s = situOf(d)
          return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: k ? `1px solid ${theme.border}` : 'none', fontSize: 13.5, flexWrap: 'wrap' }}>
            <i className={`ti ${SIT[s].icon}`} style={{ color: SIT[s].cor, fontSize: 20 }} />
            {editIdx === i ? (
              <div style={{ flex: 1, minWidth: 260, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" autoFocus value={editNome} placeholder="Nome do documento"
                  onChange={e => setEditNome(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') salvarEdicao(); if (e.key === 'Escape') { setEditIdx(null); setEditNome('') } }}
                  style={{ flex: 1, minWidth: 140 }} />
                <CampoConta value={editConta} onChange={setEditConta} onEnter={salvarEdicao} placeholder="Conta (F4)" style={{ width: 160 }} />
                <select className="input" style={{ width: 'auto', padding: '7px 9px', fontSize: 12 }} value={editTipo} onChange={e => setEditTipo(e.target.value)} title="Tipo: para onde vai o arquivo desta conta">
                  {Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <button className="btn" style={{ fontSize: 12, padding: '6px 10px' }} onClick={salvarEdicao}>Salvar</button>
              </div>
            ) : (
              <span style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: s === 'recebido' ? theme.text : theme.sub }}>{d.name}</span>
                {d.conta
                  ? <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, background: 'rgba(74,124,255,0.13)', color: theme.accent, fontFamily: 'monospace' }} title="Conta amarrada — casa com o arquivo código-conta">conta {d.conta}</span>
                  : <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, background: theme.input, color: theme.sub }} title="Sem conta — não casa com arquivo por código">sem conta</span>}
                {(() => { const t = tipoEfetivoDoc(d); return t ? <span style={{ fontSize: 10.5, padding: '3px 8px', borderRadius: 20, background: t === 'conciliacao' ? 'rgba(74,124,255,0.13)' : 'rgba(48,164,108,0.13)', color: t === 'conciliacao' ? theme.accent : theme.green }} title={d.tipo ? 'Tipo definido' : 'Tipo deduzido pela descrição'}><i className={`ti ${t === 'conciliacao' ? 'ti-file-type-pdf' : 'ti-file-spreadsheet'}`} /> {TIPO[t].curto}{d.tipo ? '' : ' (auto)'}</span> : null })()}
                {d.arquivo_path && (
                  <>
                    <button className="btn btn-ghost" onClick={() => verArquivo(i)} style={{ fontSize: 11, padding: '3px 8px', color: theme.green, borderColor: theme.green }} title={d.arquivo || 'Ver o arquivo recebido'}>
                      <i className="ti ti-eye" /> ver arquivo</button>
                    {!ro && <button className="btn btn-ghost" onClick={() => excluirArquivo(i)} disabled={subindo != null} style={{ fontSize: 11, padding: '3px 8px', color: theme.red, borderColor: theme.red }} title="Excluir o arquivo (subiu errado) — volta a pendente">
                      <i className="ti ti-trash" /> excluir</button>}
                  </>
                )}
              </span>
            )}
            {editIdx !== i && <span style={{ color: SIT[s].cor, fontSize: 12, fontWeight: 500, minWidth: 76 }}>{SIT[s].label}{s === 'recebido' && d.date ? ` ${d.date}` : ''}</span>}
            {!ro && editIdx !== i && (
              <>
                {/* 'Recebido' NÃO é manual — vem do upload. Aqui: subir arquivo + marcações sem arquivo. */}
                <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 9px', cursor: subindo === i ? 'default' : 'pointer', color: theme.accent, borderColor: theme.accent }} title="Subir o arquivo deste documento (marca recebido automaticamente)">
                  <i className={`ti ${subindo === i ? 'ti-loader-2' : 'ti-upload'}`} /> {subindo === i ? 'Subindo…' : 'Subir arquivo'}
                  <input type="file" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg" disabled={subindo != null} style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; uploadDoc(i, f) }} />
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['nao_tem', 'nao_enviou'].map(k => (
                    <button key={k} className={s === k ? 'btn' : 'btn btn-ghost'} title={SIT[k].label}
                      style={{ fontSize: 12, padding: '5px 9px', ...(s === k ? { background: SIT[k].cor, borderColor: SIT[k].cor } : { color: SIT[k].cor, borderColor: SIT[k].cor }) }}
                      onClick={() => setSit(i, k)}>
                      <i className={`ti ${SIT[k].icon}`} /> {SIT[k].label}
                    </button>
                  ))}
                </div>
                <i className="ti ti-pencil" title="Editar nome / conta" onClick={() => abrirEdicao(i)} style={{ color: theme.sub, fontSize: 16, marginLeft: 2, cursor: 'pointer' }} />
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
  return anteriores[0] ? normaliza(anteriores[0].documentos).map(x => ({ name: x.name, conta: x.conta, tipo: x.tipo })) : []
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
