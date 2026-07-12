import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'
import { verArquivoImportado } from '../lib/importacaoMassa'
import CampoConta from '../components/CampoConta'

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
const novoDoc = (name, tipo = '', conta = '') => ({ name, tipo, conta, situacao: '', rec: false, date: '' })
// Mantém a lista sempre em ordem alfabética (inclusive itens novos).
const ordenar = arr => [...(arr || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR', { sensitivity: 'base' }))
// tipo do documento = DESTINO: 'conciliacao' (sobe o arquivo para a conciliação da conta)
// ou 'integracao' (alimenta a Integração Financeira da conta). Todo documento liga numa
// conta contábil. (Legado: 'conta' = conciliação.)
const normaliza = (arr) => (arr || []).map(x => {
  const name = String(x.name || '').trim()
  const situacao = situOf(x)
  return { name, tipo: x.tipo || '', conta: x.conta || '', arquivo_path: x.arquivo_path || '', arquivo: x.arquivo || '', situacao, rec: situacao === 'recebido', date: x.date || '' }
}).filter(x => x.name)
// Destino do documento a partir do tipo (com compatibilidade do legado 'conta').
const rotaDoc = d => d.tipo === 'integracao' ? 'integracao' : (d.tipo === 'conciliacao' || d.tipo === 'conta') ? 'conciliacao' : ''
const rotaLabel = r => r === 'integracao' ? 'integração' : 'conciliação'
// Falta cadastro se não tem destino definido OU não tem conta (todo documento tem conta).
const faltaDepara = d => !rotaDoc(d) || !String(d.conta || '').trim()

export default function DocumentosRecebidos() {
  const { empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const [docs, setDocs] = useState([])
  const [status, setStatus] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [nome, setNome] = useState('')
  const [tipoNovo, setTipoNovo] = useState('conciliacao')
  const [contaNovo, setContaNovo] = useState('')
  const [editIdx, setEditIdx] = useState(null)
  const [editNome, setEditNome] = useState('')
  const [editTipo, setEditTipo] = useState('')
  const [editConta, setEditConta] = useState('')
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
        setDocs(ordenar(herdado.map(x => novoDoc(x.name, x.tipo, x.conta))))
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
    const { data } = await supabase.from('competencias').select('id, ano, mes, status, documentos').eq('cliente_id', empresaId)
    const futuras = (data || []).filter(c => (c.ano > ano || (c.ano === ano && c.mes > mes)) && c.status !== 'fechado')
    for (const c of futuras) {
      const recPorNome = Object.fromEntries(normaliza(c.documentos).map(x => [x.name, x]))
      // O de-para (tipo/conta) é definição do documento → propaga; a situação do mês é preservada.
      const merged = novo.map(d => {
        const prev = recPorNome[d.name]
        return prev ? { ...prev, tipo: d.tipo, conta: d.conta } : novoDoc(d.name, d.tipo, d.conta)
      })
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
  // Novos documentos EXIGEM tipo (e conta, quando for do tipo 'conta'). Os já existentes
  // sem cadastro não travam — só recebem o alerta na lista, corrigidos aos poucos.
  const incluir = () => {
    if (ro || !nome.trim()) return
    if (!tipoNovo) { flash('Escolha o destino (Conciliação ou Integração).'); return }
    if (!contaNovo.trim()) { flash('Informe a conta contábil (F4).'); return }
    persistir([...docs, novoDoc(nome.trim(), tipoNovo, contaNovo.trim())], true)
    setNome(''); setContaNovo(''); setTipoNovo('conciliacao')
  }
  const abrirEdicao = (i) => { setEditIdx(i); setEditNome(docs[i].name); setEditTipo(rotaDoc(docs[i]) || 'conciliacao'); setEditConta(docs[i].conta || '') }
  const salvarEdicao = () => {
    const n = editNome.trim()
    if (n && editIdx !== null) persistir(docs.map((d, j) => j === editIdx ? { ...d, name: n, tipo: editTipo, conta: editConta.trim() } : d), true)
    setEditIdx(null); setEditNome(''); setEditTipo(''); setEditConta('')
  }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 4000) }
  async function verArquivo(path) { try { await verArquivoImportado(path) } catch (e) { flash('Não consegui abrir o arquivo: ' + e.message) } }

  async function baixarModelo() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([
      ['Documento', 'Destino (conciliação/integração)', 'Conta contábil'],
      ...PADRAO.map(n => [n, 'conciliação', '']),
    ])
    ws['!cols'] = [{ wch: 46 }, { wch: 28 }, { wch: 18 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Documentos')
    XLSX.writeFile(wb, 'modelo-documentos.xlsx')
  }

  // Normaliza o destino vindo da planilha: "integração/financeira" → integracao;
  // "conciliação" (ou qualquer coisa com conta preenchida) → conciliacao; vazio → a definir.
  function tipoPlanilha(raw, conta) {
    const t = String(raw ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    if (/integra|financeira/.test(t)) return 'integracao'
    if (/concilia/.test(t) || String(conta || '').trim()) return 'conciliacao'
    return ''
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
      const seen = new Set(), items = []
      for (const r of body) {
        const name = String(r[0] ?? '').trim(); if (!name || seen.has(name)) continue
        seen.add(name)
        const conta = String(r[2] ?? '').trim()
        items.push(novoDoc(name, tipoPlanilha(r[1], conta), conta))
      }
      if (!items.length) { flash('Nenhum documento encontrado na planilha (coluna A).'); return }
      const incompletos = items.filter(faltaDepara).length
      if (!confirm(`Importar ${items.length} documento(s) — com conta/tipo? Isso substitui a lista desta competência (em diante).`)) return
      await persistir(items, true)
      flash(`${items.length} documento(s) importado(s)${incompletos ? ` · ${incompletos} ainda sem conta/tipo (veja o alerta na lista)` : ''}.`)
    } catch (err) { flash('Erro ao importar: ' + err.message) }
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para conferir os documentos." /></Wrapper>
  }

  const total = docs.length
  const cont = { '': 0, recebido: 0, nao_tem: 0, nao_enviou: 0 }
  for (const d of docs) cont[situOf(d)]++
  const rec = cont.recebido
  const pct = total ? Math.round(rec / total * 100) : 0
  const semDepara = docs.filter(faltaDepara).length

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
          {semDepara > 0 && <span style={{ color: theme.yellow }}><i className="ti ti-alert-triangle" /> <b>{semDepara}</b> sem conta/tipo cadastrado</span>}
        </div>
      </div>

      {/* Ações: incluir (com de-para) / importar / modelo */}
      {!ro && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Nome do documento" value={nome}
              onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === 'Enter' && incluir()} />
            <select className="input" style={{ width: 140 }} value={tipoNovo} onChange={e => setTipoNovo(e.target.value)} title="Destino do documento">
              <option value="conciliacao">Conciliação</option>
              <option value="integracao">Integração</option>
            </select>
            <CampoConta value={contaNovo} onChange={setContaNovo} onEnter={incluir} placeholder="Conta (F4)" style={{ width: 170 }} />
            <button className="btn" onClick={incluir}><i className="ti ti-plus" /> Incluir</button>
            <span style={{ width: 1, height: 24, background: theme.border, margin: '0 2px' }} />
            <label className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <i className="ti ti-file-import" /> Importar Excel
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={importar} />
            </label>
            <button className="btn btn-ghost" onClick={baixarModelo}><i className="ti ti-file-spreadsheet" /> Baixar modelo</button>
          </div>
          <p style={{ fontSize: 11.5, color: theme.sub, margin: '9px 2px 0' }}>
            Todo documento liga numa <b style={{ color: theme.text }}>conta</b>. <b style={{ color: theme.text }}>Conciliação</b> → o arquivo (PDF) sobe para a conciliação da conta e lê o saldo. <b style={{ color: theme.text }}>Integração</b> → o arquivo (Excel) vai classificado para a Integração Financeira. O modelo do Excel já traz as colunas <b style={{ color: theme.text }}>Destino</b> e <b style={{ color: theme.text }}>Conta</b>.
          </p>
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
              <div style={{ flex: 1, minWidth: 260, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" autoFocus value={editNome} placeholder="Nome do documento"
                  onChange={e => setEditNome(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') salvarEdicao(); if (e.key === 'Escape') { setEditIdx(null); setEditNome('') } }}
                  style={{ flex: 1, minWidth: 140 }} />
                <select className="input" style={{ width: 128 }} value={editTipo} onChange={e => setEditTipo(e.target.value)}>
                  <option value="conciliacao">Conciliação</option><option value="integracao">Integração</option>
                </select>
                <CampoConta value={editConta} onChange={setEditConta} onEnter={salvarEdicao} placeholder="Conta (F4)" style={{ width: 160 }} />
                <button className="btn" style={{ fontSize: 12, padding: '6px 10px' }} onClick={salvarEdicao}>Salvar</button>
              </div>
            ) : (
              <span style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: s === 'recebido' ? theme.text : theme.sub }}>{d.name}</span>
                {faltaDepara(d)
                  ? <button className="btn btn-ghost" onClick={() => abrirEdicao(i)} disabled={ro}
                      style={{ fontSize: 11, padding: '3px 8px', color: theme.yellow, borderColor: theme.yellow }}
                      title="Falta cadastrar o destino e/ou a conta deste documento">
                      <i className="ti ti-alert-triangle" /> falta destino/conta</button>
                  : (() => { const r = rotaDoc(d); const integ = r === 'integracao'
                      return <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, background: integ ? 'rgba(48,164,108,0.14)' : 'rgba(74,124,255,0.13)', color: integ ? theme.green : theme.accent }} title={integ ? 'Vai para a Integração Financeira' : 'Sobe para a conciliação da conta'}>{rotaLabel(r)} · <b style={{ fontFamily: 'monospace' }}>{d.conta}</b></span> })()}
                {d.arquivo_path && (
                  <button className="btn btn-ghost" onClick={() => verArquivo(d.arquivo_path)}
                    style={{ fontSize: 11, padding: '3px 8px', color: theme.green, borderColor: theme.green }}
                    title={d.arquivo || 'Ver o arquivo importado'}>
                    <i className="ti ti-eye" /> ver arquivo</button>
                )}
              </span>
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
                <i className="ti ti-pencil" title="Editar nome / conta / tipo" onClick={() => abrirEdicao(i)} style={{ color: theme.sub, fontSize: 16, marginLeft: 2, cursor: 'pointer' }} />
                <i className="ti ti-trash" title="Excluir" onClick={() => remover(i)} style={{ color: theme.sub, fontSize: 16, cursor: 'pointer' }} />
              </>
            )}
          </div>
        )})}
      </div>

    </Wrapper>
  )
}

// Documentos do fechamento anterior mais recente (nome + de-para tipo/conta, sem a situação).
async function herdarLista(empresaId, ano, mes) {
  const { data } = await supabase.from('competencias').select('ano, mes, documentos').eq('cliente_id', empresaId)
  const anteriores = (data || [])
    .filter(c => (c.ano < ano || (c.ano === ano && c.mes < mes)) && Array.isArray(c.documentos) && c.documentos.length)
    .sort((a, b) => (b.ano - a.ano) || (b.mes - a.mes))
  return anteriores[0] ? normaliza(anteriores[0].documentos).map(x => ({ name: x.name, tipo: x.tipo, conta: x.conta })) : []
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
