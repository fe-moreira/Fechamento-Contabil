import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { theme } from '../lib/theme'
import { normalizaCompetencia } from '../lib/balancete'

const vazio = {
  codigo_dominio: '', tipo: 'Matriz', codigo_matriz: '', razao_social: '',
  nome_fantasia: '', cnpj: '', regime_tributario: 'Simples', tipo_fechamento: '',
  competencia_inicio: '', sistema_financeiro: '', integracao_financeira: 'Não usa',
  analista: '', observacoes: '', prazo_entrega: '',
}

// Helpers da importação em lote (planilha-modelo: aba "Clientes", 15 colunas).
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const simNao = (v) => /^sim/i.test(String(v ?? '').trim())
// CNPJ só com dígitos — é a chave de duplicidade (amarra "12.345.678/0001-90" = "12345678000190").
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '')
// Formata/normaliza o CNPJ com 14 dígitos (repõe zero à esquerda que o Excel come
// ao guardar como número). Mantém o texto original se não parecer um CNPJ.
const formatarCnpj = (v) => {
  const d = soDigitos(v)
  if (d.length >= 11 && d.length <= 14) {
    const p = d.padStart(14, '0')
    return `${p.slice(0, 2)}.${p.slice(2, 5)}.${p.slice(5, 8)}/${p.slice(8, 12)}-${p.slice(12)}`
  }
  return String(v ?? '').trim()
}

// Campos obrigatórios do cadastro (todos, menos observações; código da matriz só p/ filial).
const OBRIG = [
  ['codigo_dominio', 'Código no Domínio'],
  ['razao_social', 'Razão social'],
  ['nome_fantasia', 'Nome fantasia'],
  ['cnpj', 'CNPJ'],
  ['regime_tributario', 'Regime tributário'],
  ['tipo_fechamento', 'Tipo de fechamento'],
  ['prazo_entrega', 'Prazo de entrega do balancete'],
  ['competencia_inicio', 'Competência de início'],
  ['integracao_financeira', 'Integração financeira'],
  ['analista', 'Analista'],
]
function camposFaltando(f) {
  const faltam = OBRIG.filter(([k]) => !String(f[k] ?? '').trim()).map(([, l]) => l)
  if (f.tipo === 'Filial' && !String(f.codigo_matriz ?? '').trim()) faltam.push('Código da matriz')
  // Sistema financeiro é obrigatório quando o cliente usa alguma integração.
  if (String(f.integracao_financeira || 'Não usa') !== 'Não usa' && !String(f.sistema_financeiro ?? '').trim()) faltam.push('Sistema financeiro')
  return faltam
}

// Rótulos p/ o resumo de divergências da importação.
const LABEL = {
  codigo_dominio: 'Código', tipo: 'Tipo', codigo_matriz: 'Cód. matriz', razao_social: 'Razão social',
  nome_fantasia: 'Nome fantasia', cnpj: 'CNPJ', regime_tributario: 'Regime', tipo_fechamento: 'Tipo fech.',
  prazo_entrega: 'Prazo', competencia_inicio: 'Comp. início', carga_saldos: 'Carga saldos',
  coleta_razao: 'Coleta razão', sistema_financeiro: 'Sist. financeiro', integracao_financeira: 'Integração',
  analista: 'Analista', observacoes: 'Observações',
}
// Valor comparável/legível de um campo (normaliza booleanos e nulos).
const val = (k, x) => (k === 'carga_saldos' || k === 'coleta_razao') ? (x ? 'Sim' : 'Não') : String(x ?? '').trim()

export default function Clientes() {
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState(vazio)
  const [salvando, setSalvando] = useState(false)
  const [editId, setEditId] = useState(null)
  const [aberto, setAberto] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [preview, setPreview] = useState(null)   // resumo da importação p/ confirmação
  const [aplicando, setAplicando] = useState(false)
  const fileRef = useRef(null)

  async function carregar() {
    setLoading(true); setErro('')
    const { data, error } = await supabase
      .from('clientes').select('*').order('razao_social', { ascending: true })
    if (error) setErro(error.message)
    else setLista(data || [])
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  // Lê a planilha e monta um RESUMO (novos, divergências, inválidos) para confirmação.
  // Nada é gravado aqui — só depois que o usuário confirma em "Aplicar importação".
  async function analisarPlanilha(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setErro(''); setImportMsg('Lendo planilha…'); setPreview(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const aba = wb.SheetNames.find(n => n.toLowerCase().includes('client')) || wb.SheetNames[wb.SheetNames.length - 1]
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: '' })
      if (linhas.length < 2) { setImportMsg(''); setErro('A aba de clientes está vazia.'); return }

      // Acha a linha do cabeçalho — ela pode não ser a primeira (o modelo tem
      // logo e título acima). Procura a linha que tem "Razão Social" e "CNPJ".
      const hIdx = linhas.findIndex(r => {
        const hs = r.map(norm)
        return hs.some(h => h.includes('razao')) && hs.some(h => h.includes('cnpj'))
      })
      if (hIdx < 0) { setImportMsg(''); setErro('Não encontrei o cabeçalho da planilha (a linha com "Razão Social" e "CNPJ"). Use o modelo de importação.'); return }

      const H = linhas[hIdx].map(norm)
      const col = {
        codigo_dominio: H.findIndex(h => h.includes('codigo') && h.includes('dominio')),
        tipo: H.findIndex(h => h === 'tipo'),
        codigo_matriz: H.findIndex(h => h.includes('codigo') && h.includes('matriz')),
        razao_social: H.findIndex(h => h.includes('razao')),
        nome_fantasia: H.findIndex(h => h.includes('fantasia')),
        cnpj: H.findIndex(h => h.includes('cnpj')),
        regime_tributario: H.findIndex(h => h.includes('regime')),
        tipo_fechamento: H.findIndex(h => h.includes('tipo') && h.includes('fechamento')),
        prazo_entrega: H.findIndex(h => h.includes('prazo')),
        competencia_inicio: H.findIndex(h => h.includes('competencia')),
        carga_saldos: H.findIndex(h => h.includes('carga')),
        coleta_razao: H.findIndex(h => h.includes('coleta')),
        sistema_financeiro: H.findIndex(h => h.includes('sistema')),
        integracao_financeira: H.findIndex(h => h.includes('integracao')),
        analista: H.findIndex(h => h.includes('analista')),
        observacoes: H.findIndex(h => h.includes('observ')),
      }
      const raw = (row, k) => (col[k] >= 0 ? String(row[col[k]] ?? '').trim() : '')

      // Monta os campos preenchidos de cada linha (célula vazia não entra).
      const registros = []
      for (const row of linhas.slice(hIdx + 1)) {
        const cod = raw(row, 'codigo_dominio')
        const razao = raw(row, 'razao_social')
        const cnpjTxt = raw(row, 'cnpj')
        if (!cod && !razao && !cnpjTxt) continue

        const campos = {}
        if (cod) campos.codigo_dominio = cod
        if (razao) campos.razao_social = razao
        const tipoRaw = raw(row, 'tipo')
        if (tipoRaw) campos.tipo = tipoRaw.toLowerCase().startsWith('fil') ? 'Filial' : 'Matriz'
        const cm = raw(row, 'codigo_matriz'); if (cm) campos.codigo_matriz = cm
        for (const k of ['nome_fantasia', 'regime_tributario', 'tipo_fechamento', 'sistema_financeiro', 'integracao_financeira', 'analista', 'observacoes']) {
          const v = raw(row, k); if (v) campos[k] = v
        }
        // CNPJ normalizado/formatado: o Excel guarda como número e come o zero à
        // esquerda; repõe os 14 dígitos para a chave de duplicidade ficar estável.
        const cnpjFmt = formatarCnpj(cnpjTxt)
        if (cnpjFmt) campos.cnpj = cnpjFmt
        const ci = normalizaCompetencia(raw(row, 'competencia_inicio')); if (ci) campos.competencia_inicio = ci
        const cs = raw(row, 'carga_saldos'); if (cs) campos.carga_saldos = simNao(cs)
        const cr = raw(row, 'coleta_razao'); if (cr) campos.coleta_razao = simNao(cr)
        const pz = parseInt(String(raw(row, 'prazo_entrega')).replace(/\D/g, ''), 10)
        if ([5, 10, 15, 20, 25, 30].includes(pz)) campos.prazo_entrega = pz

        registros.push({ cnpjNorm: soDigitos(cnpjFmt), campos })
      }
      if (!registros.length) { setImportMsg(''); setErro('Nenhuma linha de cliente encontrada na planilha.'); return }

      // Estado atual do banco: amarra por CNPJ (chave) e por código (que também é único).
      const { data: existentes } = await supabase.from('clientes').select('*')
      const porCnpj = new Map((existentes || []).filter(c => soDigitos(c.cnpj)).map(c => [soDigitos(formatarCnpj(c.cnpj)), c]))
      const codigosUsados = new Map((existentes || []).map(c => [c.codigo_dominio, c]))

      const novos = [], conflitos = [], invalidos = [], inalterados = []
      const vistosCnpj = new Set()
      for (const { cnpjNorm, campos } of registros) {
        const nome = campos.razao_social || campos.codigo_dominio || '(sem nome)'
        if (!cnpjNorm) { invalidos.push({ nome, motivo: 'sem CNPJ (o CNPJ é obrigatório)' }); continue }
        if (vistosCnpj.has(cnpjNorm)) { invalidos.push({ nome, motivo: 'CNPJ repetido na própria planilha' }); continue }
        vistosCnpj.add(cnpjNorm)

        const existente = porCnpj.get(cnpjNorm)
        if (existente) {
          // Cliente já existe → só marca as divergências (nada muda sem confirmar).
          const diffs = []
          for (const k of Object.keys(campos)) {
            if (k === 'cnpj') continue
            if (val(k, campos[k]) !== val(k, existente[k])) diffs.push({ campo: k, de: val(k, existente[k]), para: val(k, campos[k]) })
          }
          if (diffs.length) conflitos.push({ id: existente.id, nome: existente.razao_social || nome, campos, diffs, aplicar: true })
          else inalterados.push({ nome: existente.razao_social || nome })
        } else {
          // Cliente novo → exige cadastro completo (todos os campos obrigatórios).
          const merged = { tipo: 'Matriz', ...campos }
          const faltam = camposFaltando(merged)
          const codConflito = merged.codigo_dominio && codigosUsados.has(merged.codigo_dominio)
          if (codConflito) invalidos.push({ nome, motivo: `código "${merged.codigo_dominio}" já usado por ${codigosUsados.get(merged.codigo_dominio).razao_social}` })
          else if (faltam.length) invalidos.push({ nome, motivo: 'faltam: ' + faltam.join(', ') })
          else novos.push({ nome, campos: merged })
        }
      }

      setImportMsg('')
      setPreview({ novos, conflitos, invalidos, inalterados })
    } catch (err) {
      setImportMsg(''); setErro('Erro ao ler a planilha: ' + err.message)
    }
  }

  // Grava o que foi confirmado: insere os novos e atualiza só as divergências marcadas.
  async function aplicarImport() {
    if (!preview) return
    setAplicando(true); setErro('')
    try {
      let inseridos = 0, atualizados = 0
      if (preview.novos.length) {
        const rows = preview.novos.map(n => ({ integracao_financeira: 'Não usa', ...n.campos }))
        const { error } = await supabase.from('clientes').insert(rows)
        if (error) throw error
        inseridos = rows.length
      }
      for (const c of preview.conflitos) {
        if (!c.aplicar) continue
        const patch = { ...c.campos }
        delete patch.cnpj // a chave (CNPJ) não muda
        if (Object.keys(patch).length) {
          const { error } = await supabase.from('clientes').update(patch).eq('id', c.id)
          if (error) throw error
        }
        atualizados++
      }
      const mantidos = preview.conflitos.filter(c => !c.aplicar).length
      setImportMsg(`${inseridos} novo(s) · ${atualizados} atualizado(s)${mantidos ? ` · ${mantidos} divergência(s) mantida(s) sem alteração` : ''}. Nada foi apagado.`)
      setPreview(null)
      carregar()
    } catch (err) {
      setErro('Erro ao aplicar: ' + traduzErro(err.message))
    } finally {
      setAplicando(false)
    }
  }

  function abrirNovo() { setForm(vazio); setEditId(null); setErro(''); setAberto(true) }
  function abrirEdit(c) { setForm({ ...vazio, ...c }); setEditId(c.id); setErro(''); setAberto(true) }

  async function salvar(e) {
    e.preventDefault(); setErro('')
    // 1) cadastro completo obrigatório
    const faltam = camposFaltando(form)
    if (faltam.length) { setErro('Preencha todos os campos obrigatórios: ' + faltam.join(', ') + '.'); return }
    // 2) duplicidade amarrada pelo CNPJ (compara com 14 dígitos)
    const cnpjN = soDigitos(formatarCnpj(form.cnpj))
    const dup = lista.find(c => soDigitos(formatarCnpj(c.cnpj)) === cnpjN && c.id !== editId)
    if (dup) { setErro(`Já existe um cliente com esse CNPJ: ${dup.razao_social} (código ${dup.codigo_dominio}). Edite o cliente existente em vez de cadastrar outro.`); return }

    setSalvando(true)
    const payload = { ...form }
    if (payload.tipo === 'Matriz') payload.codigo_matriz = null
    payload.cnpj = formatarCnpj(payload.cnpj)
    payload.competencia_inicio = normalizaCompetencia(payload.competencia_inicio) || payload.competencia_inicio
    payload.prazo_entrega = payload.prazo_entrega ? Number(payload.prazo_entrega) : null
    let res
    if (editId) res = await supabase.from('clientes').update(payload).eq('id', editId)
    else res = await supabase.from('clientes').insert(payload)
    setSalvando(false)
    if (res.error) { setErro(traduzErro(res.error.message)); return }
    setAberto(false); carregar()
  }

  async function excluir(c) {
    if (!confirm(`Excluir ${c.razao_social}?`)) return
    const { error } = await supabase.from('clientes').delete().eq('id', c.id)
    if (error) setErro(error.message); else carregar()
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const toggleConflito = (i) => setPreview(p => ({ ...p, conflitos: p.conflitos.map((c, j) => j === i ? { ...c, aplicar: !c.aplicar } : c) }))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>Clientes</h1>
          <p style={{ color: theme.sub, fontSize: 13, marginTop: 2 }}>{lista.length} cadastrado(s)</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a className="btn btn-ghost" href="/modelo-importacao-clientes.xlsx" download
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-file-spreadsheet" /> Baixar modelo
          </a>
          <button className="btn btn-ghost" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => fileRef.current?.click()}>
            <i className="ti ti-file-import" /> Importar planilha
          </button>
          <button className="btn" onClick={abrirNovo}>+ Novo cliente</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={analisarPlanilha} />
        </div>
      </div>

      {importMsg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 14 }}><i className="ti ti-circle-check" /> {importMsg}</p>}
      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>Erro: {erro}</p>}

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr style={{ background: theme.input }}>
              {['Código', 'Razão social', 'Regime', 'Integração fin.', 'Analista', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 20, color: theme.sub }}>Nenhum cliente. Clique em “+ Novo cliente”.</td></tr>
            ) : lista.map(c => (
              <tr key={c.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.codigo_dominio}{c.tipo === 'Filial' ? ' (filial)' : ''}</td>
                <td style={{ padding: '11px 14px', fontSize: 13 }}>{c.razao_social}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.regime_tributario}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.integracao_financeira}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{c.analista}</td>
                <td style={{ padding: '11px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12, marginRight: 6 }} onClick={() => abrirEdit(c)}>editar</button>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(c)}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberto && (
        <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <form onClick={e => e.stopPropagation()} onSubmit={salvar} style={{ width: 560, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>{editId ? 'Editar cliente' : 'Novo cliente'}</h2>
            <p style={{ color: theme.sub, fontSize: 12, marginBottom: 16 }}>Todos os campos marcados com <span style={{ color: theme.red }}>*</span> são obrigatórios.</p>
            {erro && <p style={{ color: theme.red, fontSize: 12.5, marginBottom: 12 }}>{erro}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Campo label="Código no Domínio" req><input className="input" value={form.codigo_dominio} onChange={set('codigo_dominio')} required /></Campo>
              <Campo label="Tipo" req>
                <select className="input" value={form.tipo} onChange={set('tipo')}>
                  <option>Matriz</option><option>Filial</option>
                </select>
              </Campo>
              {form.tipo === 'Filial' && (
                <Campo label="Código da matriz" req><input className="input" value={form.codigo_matriz || ''} onChange={set('codigo_matriz')} required /></Campo>
              )}
              <Campo label="Razão social" req full={form.tipo !== 'Filial'}><input className="input" value={form.razao_social} onChange={set('razao_social')} required /></Campo>
              <Campo label="Nome fantasia" req><input className="input" value={form.nome_fantasia || ''} onChange={set('nome_fantasia')} required /></Campo>
              <Campo label="CNPJ" req><input className="input" value={form.cnpj || ''} onChange={set('cnpj')} placeholder="00.000.000/0000-00" required /></Campo>
              <Campo label="Regime tributário" req>
                <select className="input" value={form.regime_tributario} onChange={set('regime_tributario')}>
                  <option>Simples</option><option>Presumido</option><option>Real</option>
                </select>
              </Campo>
              <Campo label="Tipo de fechamento" req><input className="input" value={form.tipo_fechamento || ''} onChange={set('tipo_fechamento')} required /></Campo>
              <Campo label="Prazo de entrega do balancete" req>
                <select className="input" value={form.prazo_entrega ?? ''} onChange={set('prazo_entrega')} required>
                  <option value="">—</option>
                  {[5, 10, 15, 20, 25, 30].map(d => <option key={d} value={d}>Dia {d}</option>)}
                </select>
              </Campo>
              <Campo label="Competência de início (MM/AAAA)" req><input className="input" value={form.competencia_inicio || ''} onChange={set('competencia_inicio')} placeholder="01/2026" required /></Campo>
              <Campo label="Integração financeira" req>
                <select className="input" value={form.integracao_financeira} onChange={set('integracao_financeira')}>
                  <option>Não usa</option><option>Sistema</option><option>Excel</option>
                </select>
              </Campo>
              <Campo label="Sistema financeiro" req={form.integracao_financeira !== 'Não usa'}>
                <input className="input" value={form.sistema_financeiro || ''} onChange={set('sistema_financeiro')} placeholder="Ex.: Conta Azul"
                  required={form.integracao_financeira !== 'Não usa'} disabled={form.integracao_financeira === 'Não usa'} />
              </Campo>
              <Campo label="Analista" req><input className="input" value={form.analista || ''} onChange={set('analista')} required /></Campo>
              <Campo label="Observações" full><textarea className="input" rows={2} value={form.observacoes || ''} onChange={set('observacoes')} /></Campo>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(false)}>Cancelar</button>
              <button className="btn" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}

      {preview && (
        <div onClick={() => !aplicando && setPreview(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 720, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>Confirmar importação</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>
              Amarração pelo CNPJ. Clientes já existentes só são alterados nas divergências que você mantiver marcadas.
            </p>
            {erro && <p style={{ color: theme.red, fontSize: 12.5, marginBottom: 12 }}>{erro}</p>}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <Tag c={theme.green} n={preview.novos.length} t="novo(s)" />
              <Tag c={theme.yellow} n={preview.conflitos.length} t="com divergência" />
              <Tag c={theme.sub} n={preview.inalterados.length} t="sem mudança" />
              <Tag c={theme.red} n={preview.invalidos.length} t="não importado(s)" />
            </div>

            {preview.conflitos.length > 0 && (
              <Bloco titulo="Divergências — confirme o que alterar">
                {preview.conflitos.map((c, i) => (
                  <div key={c.id} style={{ border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: c.aplicar ? 8 : 0 }}>
                      <input type="checkbox" checked={c.aplicar} onChange={() => toggleConflito(i)} />
                      <b style={{ fontSize: 14 }}>{c.nome}</b>
                      <span style={{ fontSize: 12, color: c.aplicar ? theme.yellow : theme.sub }}>{c.aplicar ? 'atualizar' : 'manter como está'}</span>
                    </label>
                    {c.aplicar && (
                      <div style={{ display: 'grid', gap: 4, paddingLeft: 28 }}>
                        {c.diffs.map(df => (
                          <div key={df.campo} style={{ fontSize: 12.5, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ color: theme.sub, minWidth: 96 }}>{LABEL[df.campo] || df.campo}</span>
                            <span style={{ color: theme.red, textDecoration: 'line-through' }}>{df.de || '—'}</span>
                            <span style={{ color: theme.sub }}>→</span>
                            <span style={{ color: theme.green }}>{df.para || '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </Bloco>
            )}

            {preview.novos.length > 0 && (
              <Bloco titulo={`Novos clientes (${preview.novos.length})`}>
                {preview.novos.map((n, i) => (
                  <div key={i} style={{ fontSize: 13, padding: '5px 0', color: theme.text }}>
                    <i className="ti ti-plus" style={{ color: theme.green, fontSize: 13, marginRight: 6 }} />{n.nome}
                    <span style={{ color: theme.sub }}> · {n.campos.cnpj}</span>
                  </div>
                ))}
              </Bloco>
            )}

            {preview.invalidos.length > 0 && (
              <Bloco titulo={`Não importados (${preview.invalidos.length})`}>
                {preview.invalidos.map((n, i) => (
                  <div key={i} style={{ fontSize: 12.5, padding: '5px 0', color: theme.sub }}>
                    <i className="ti ti-alert-triangle" style={{ color: theme.red, fontSize: 13, marginRight: 6 }} />
                    <b style={{ color: theme.text }}>{n.nome}</b> — {n.motivo}
                  </div>
                ))}
              </Bloco>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)} disabled={aplicando}>Cancelar</button>
              <button className="btn" onClick={aplicarImport} disabled={aplicando || (!preview.novos.length && !preview.conflitos.some(c => c.aplicar))}>
                {aplicando ? 'Aplicando…' : 'Aplicar importação'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Mensagens de erro do banco em linguagem do usuário (violação de unicidade).
function traduzErro(msg) {
  if (/cnpj/i.test(msg) && /(unique|duplicate|23505)/i.test(msg)) return 'Já existe um cliente com esse CNPJ.'
  if (/codigo_dominio/i.test(msg) && /(unique|duplicate|23505)/i.test(msg)) return 'Já existe um cliente com esse código do Domínio.'
  return msg
}

function Campo({ label, children, full, req }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label>{label}{req && <span style={{ color: theme.red }}> *</span>}</label>
      {children}
    </div>
  )
}

function Tag({ c, n, t }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.text }}>
      <b style={{ color: c, fontSize: 15 }}>{n}</b> {t}
    </span>
  )
}

function Bloco({ titulo, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: .4, color: theme.sub, margin: '0 0 8px' }}>{titulo}</p>
      {children}
    </div>
  )
}
