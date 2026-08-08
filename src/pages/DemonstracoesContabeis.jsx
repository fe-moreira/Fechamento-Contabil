import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { lerTudo } from '../lib/lerTudo'
import { montarBalancete } from '../lib/balancete'
import { mesesDoPeriodo, montarDadosDemonstracoes, abrirDemonstracoesContabeis } from '../lib/demonstracoes'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'
import InfoTela from '../components/InfoTela'

const g1 = c => String(c || '')[0]
const ULT = (a, m) => new Date(a, m, 0).getDate()
const diaBR = (a, m) => `${String(ULT(a, m)).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}`
const priBR = (a, m) => `01/${String(m).padStart(2, '0')}/${a}`

// Blocos que o usuário pode marcar (na ordem do modelo).
const BLOCOS = [
  { id: 'cockpit', label: 'Cockpit', desc: 'todas as informações do painel' },
  { id: 'dre', label: 'DRE', desc: 'demonstração do resultado (Domínio)' },
  { id: 'balancete', label: 'Balancete', desc: 'completo (Domínio)' },
  { id: 'balanco', label: 'Balanço Patrimonial', desc: 'posição no fim do período' },
  { id: 'dfc', label: 'DFC', desc: 'fluxo de caixa (método indireto)' },
  { id: 'comparativo', label: 'Comparativo de Movimento', desc: 'contas de resultado · paisagem' },
]

const TIPOS = [
  { id: 'mes', label: 'Mês' }, { id: 'tri', label: 'Trimestre' }, { id: 'sem', label: 'Semestre' },
  { id: 'ano', label: 'Anual' }, { id: 'custom', label: 'Personalizado' },
]

export default function DemonstracoesContabeis() {
  const { empresaId, empresaNome, empresas, competencia } = useAppData()
  const empresa = empresas.find(e => e.id === empresaId)
  // Defaults do período a partir da competência atual (MM/AAAA).
  const [cMes, cAno] = String(competencia || '').split('/').map(Number)
  const anoAtual = cAno || 2026, mesAtual = cMes || 1

  const [tipo, setTipo] = useState('mes')
  const [ref, setRef] = useState({
    ano: anoAtual, mes: mesAtual, tri: Math.ceil(mesAtual / 3), sem: mesAtual <= 6 ? 1 : 2,
    de: `${anoAtual}-01`, ate: `${anoAtual}-${String(mesAtual).padStart(2, '0')}`,
  })
  const setR = (k, v) => setRef(o => ({ ...o, [k]: v }))
  const [marcados, setMarcados] = useState(new Set(BLOCOS.map(b => b.id)))
  const toggle = id => setMarcados(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const [gerando, setGerando] = useState(false)
  const [msg, setMsg] = useState('')

  async function gerar() {
    if (!empresaId) { setMsg('Selecione uma empresa no menu à esquerda.'); return }
    if (!marcados.size) { setMsg('Marque ao menos um bloco para incluir no relatório.'); return }
    setGerando(true); setMsg('')
    try {
      const { lista, label } = mesesDoPeriodo(tipo, ref)
      if (!lista.length) { setMsg('Período inválido. Confira as datas.'); return }

      // Competências do cliente que existem dentro do período (só as importadas).
      const { data: comps, error } = await supabase.from('competencias')
        .select('id, ano, mes').eq('cliente_id', empresaId)
      if (error) { setMsg('Erro ao ler competências: ' + error.message); return }
      const querAnoMes = new Set(lista.map(x => `${x.ano}-${x.mes}`))
      const doPeriodo = (comps || []).filter(c => querAnoMes.has(`${c.ano}-${c.mes}`))
        .sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes))
      if (!doPeriodo.length) { setMsg('Nenhuma competência importada dentro desse período.'); return }

      // Para o GRÁFICO do Cockpit e o "acumulado do ano": meses do ano jan→mês final do período
      // (igual à prévia/Cockpit, que mostram a evolução do ano). O resto do relatório usa só o período.
      const ult0 = doPeriodo[doPeriodo.length - 1]
      const doAno = (comps || []).filter(c => c.ano === ult0.ano && c.mes <= ult0.mes)
        .sort((a, b) => a.mes - b.mes)

      // Balancete vivo (razão + lançamentos confirmados) mês a mês — carrega a UNIÃO uma vez só.
      const uniao = [...new Map([...doPeriodo, ...doAno].map(c => [c.id, c])).values()]
      const balCache = {}
      for (const c of uniao) {
        const { linhas } = await montarBalancete(empresaId, c.id, 0, { comLancamentos: true })
        balCache[c.id] = linhas || []
      }
      const perMonth = doPeriodo.map(c => ({ ano: c.ano, mes: c.mes, linhas: balCache[c.id] }))
      const anoPerMonth = doAno.map(c => ({ ano: c.ano, mes: c.mes, linhas: balCache[c.id] }))

      // Razão das contas de receita (grupo 3) p/ principais clientes — só se o Cockpit foi marcado.
      let razaoReceita = []
      if (marcados.has('cockpit')) {
        const cods = [...new Set(perMonth.flatMap(m => m.linhas)
          .filter(l => !l.sintetica && g1(l.classifRaw || l.classif) === '3').map(l => String(l.reduzido)))]
        if (cods.length) {
          for (const c of doPeriodo) {
            const rz = await lerTudo(() => supabase.from('razao')
              .select('conta, historico, debito, credito').eq('competencia_id', c.id).in('conta', cods))
            razaoReceita = razaoReceita.concat(rz || [])
          }
        }
      }

      const dados = montarDadosDemonstracoes(perMonth, razaoReceita, anoPerMonth)
      const pri = doPeriodo[0], ult = doPeriodo[doPeriodo.length - 1]
      const ok = abrirDemonstracoesContabeis({
        empresa: empresaNome, cnpj: empresa?.cnpj || '',
        periodoLabel: label, periodoIni: priBR(pri.ano, pri.mes), periodoFim: diaBR(ult.ano, ult.mes),
        blocos: marcados, dados,
      })
      if (ok) setMsg(`Relatório gerado com ${doPeriodo.length} competência(s) — abriu a janela de impressão (salvar como PDF).`)
    } catch (e) {
      setMsg('Erro ao gerar: ' + (e?.message || e))
    } finally { setGerando(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Demonstrações Contábeis</h1>
        <InfoTela titulo="Demonstrações Contábeis">Monta o relatório do cliente <b>na hora</b>: você escolhe o <b>período</b> (mês, trimestre, semestre, anual ou personalizado) e <b>o que incluir</b> (Cockpit, DRE, Balancete, Balanço, DFC, Comparativo). Sai por folhas, no estilo do relatório da CEMIG, com os relatórios modelo Domínio (DRE, Balancete, Comparativo) intocados. Reaproveita o <b>razão vivo</b> — mesma base da Conciliação e do Cockpit.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        {empresaId
          ? <>Relatório de <b style={{ color: theme.text }}>{empresaNome}</b> — escolha o período e os blocos e gere o PDF.</>
          : <>Selecione uma empresa no menu à esquerda.</>}
      </p>

      {/* Período */}
      <div style={card}>
        <div style={secTit}>Período</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {TIPOS.map(t => (
            <button key={t.id} onClick={() => setTipo(t.id)} className="btn btn-ghost"
              style={{ padding: '7px 14px', fontSize: 13, ...(tipo === t.id ? { background: theme.accent, color: '#fff', borderColor: theme.accent } : {}) }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          {tipo !== 'custom' && (
            <Campo label="Ano"><input className="input" type="number" value={ref.ano} onChange={e => setR('ano', Number(e.target.value))} style={{ width: 110 }} /></Campo>
          )}
          {tipo === 'mes' && (
            <Campo label="Mês"><select className="input" value={ref.mes} onChange={e => setR('mes', Number(e.target.value))}>
              {MESNOMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}</select></Campo>
          )}
          {tipo === 'tri' && (
            <Campo label="Trimestre"><select className="input" value={ref.tri} onChange={e => setR('tri', Number(e.target.value))}>
              {[1, 2, 3, 4].map(t => <option key={t} value={t}>{t}º trimestre</option>)}</select></Campo>
          )}
          {tipo === 'sem' && (
            <Campo label="Semestre"><select className="input" value={ref.sem} onChange={e => setR('sem', Number(e.target.value))}>
              {[1, 2].map(s => <option key={s} value={s}>{s}º semestre</option>)}</select></Campo>
          )}
          {tipo === 'custom' && (<>
            <Campo label="De (mês)"><input className="input" type="month" value={ref.de} onChange={e => setR('de', e.target.value)} /></Campo>
            <Campo label="Até (mês)"><input className="input" type="month" value={ref.ate} onChange={e => setR('ate', e.target.value)} /></Campo>
          </>)}
        </div>
      </div>

      {/* Blocos */}
      <div style={card}>
        <div style={secTit}>O que incluir no relatório</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
          {BLOCOS.map(b => {
            const on = marcados.has(b.id)
            return (
              <button key={b.id} onClick={() => toggle(b.id)}
                style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start',
                  border: `1px solid ${on ? theme.accent : theme.cb}`, background: on ? 'rgba(74,124,255,.08)' : theme.card,
                  borderRadius: 10, padding: '11px 13px' }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, marginTop: 1, flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: on ? theme.accent : 'transparent', border: `1.5px solid ${on ? theme.accent : theme.sub}`, color: '#fff', fontSize: 12 }}>
                  {on ? '✓' : ''}
                </span>
                <span>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: theme.text }}>{b.label}</span>
                  <span style={{ fontSize: 11.5, color: theme.sub }}>{b.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
        <p style={{ fontSize: 11.5, color: theme.sub, margin: '10px 2px 0' }}>
          O relatório segue a sequência: Capa/desempenho → Cockpit → DRE → Balancete → Balanço → DFC → Comparativo (paisagem).
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={gerar} disabled={gerando || !empresaId}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <i className={`ti ${gerando ? 'ti-loader-2' : 'ti-file-type-pdf'}`} /> {gerando ? 'Gerando…' : 'Gerar PDF'}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('Erro') || msg.includes('Nenhuma') || msg.includes('inválido') ? theme.red : theme.sub }}>
          <i className="ti ti-info-circle" style={{ marginRight: 5 }} />{msg}</span>}
      </div>
    </div>
  )
}

const MESNOMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const card = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 16 }
const secTit = { fontSize: 11, textTransform: 'uppercase', letterSpacing: .6, color: theme.sub, fontWeight: 700, marginBottom: 10 }
function Campo({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: theme.sub, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}
