import { useEffect, useState } from 'react'
import JSZip from 'jszip'
import { supabase } from '../lib/supabase'
import { montarBalancete, composicaoAbertura, difConciliacao } from '../lib/balancete'
import { itensAbertosConta } from '../lib/aberturaArrasto'
import { comentariosPorConta } from '../lib/comentarios'
import { gerarExcelTimbrado } from '../lib/excel'
import { theme, money } from '../lib/theme'

const num = v => Number(v) || 0
const baixa = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// Contas cuja composição é por TÍTULO (cliente/fornecedor) — as demais amarram pelo saldo/documento.
const ehEntidade = nome => /client|fornecedor|duplicat|adiantament|contas? a pagar|a receber/.test(baixa(nome))
const dataBR = d => { const s = String(d || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s === 'abertura' ? 'abertura' : s) }
const dataBRhora = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const fmtCnpj = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 14 ? `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12)}` : (c || '—') }

// Situação da amarração de uma conta patrimonial.
function statusConta(c) {
  if (c.dif != null && Math.abs(c.dif) < 0.05 && c.documento_path) return { txt: 'Conciliado — documento', cor: theme.green }
  if (c.conciliada && c.justificativa) return { txt: 'Conciliado — justificativa', cor: theme.green }
  if (c.dif != null && Math.abs(c.dif) >= 0.05) return { txt: 'Diferença a resolver', cor: theme.red }
  return { txt: 'Sem documento', cor: theme.yellow }
}

export default function BookComposicoes({ empresaId, empresaNome, competencia, cnpj }) {
  const [carregando, setCarregando] = useState(false)
  const [semComp, setSemComp] = useState(false)
  const [contas, setContas] = useState(null)
  const [exportando, setExportando] = useState('') // '' | 'zip'

  useEffect(() => {
    setContas(null); setSemComp(false)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setSemComp(true); return }

        const [{ linhas }, { data: conc }, { data: lancs }, coments] = await Promise.all([
          montarBalancete(empresaId, comp.id),
          supabase.from('conciliacao_conta').select('conta, saldo_documento, documento, documento_path, conciliada, justificativa').eq('competencia_id', comp.id),
          supabase.from('lancamentos').select('conta_debito, conta_credito, valor').eq('competencia_id', comp.id),
          comentariosPorConta(empresaId),
        ])
        if (!vivo) return
        const conf = {}; for (const r of (conc || [])) conf[String(r.conta)] = r
        const aj = {}
        for (const l of (lancs || [])) {
          const v = num(l.valor)
          if (l.conta_debito) aj[String(l.conta_debito)] = (aj[String(l.conta_debito)] || 0) + v
          if (l.conta_credito) aj[String(l.conta_credito)] = (aj[String(l.conta_credito)] || 0) - v
        }

        // Só contas patrimoniais analíticas (Ativo 1 / Passivo+PL 2) com saldo.
        const patr = linhas.filter(l => !l.sintetica
          && ['1', '2'].includes(String(l.classifRaw || '')[0])
          && Math.abs(num(l.saldo_final)) > 0.005)

        const out = []
        for (const l of patr) {
          const cod = String(l.reduzido || '')
          const reg = conf[cod] || null
          const saldoEf = num(l.saldo_final) + (aj[cod] || 0)
          const dif = reg && reg.saldo_documento != null ? difConciliacao(saldoEf, reg.saldo_documento) : null
          let composicao = []
          if (ehEntidade(l.nome)) {
            try {
              const abertura = await composicaoAbertura(empresaId, comp.id, cod, l.classifRaw, l.nome)
              composicao = await itensAbertosConta(comp.id, cod, l.nome, l.classifRaw, abertura)
            } catch { composicao = [] }
          }
          out.push({
            conta: cod, nome: l.nome || '', classifRaw: l.classifRaw, grupo: String(l.classifRaw)[0] === '1' ? 'Ativo' : 'Passivo + PL',
            saldo_final: num(l.saldo_final), natureza: num(l.saldo_final) >= 0 ? 'D' : 'C',
            saldo_documento: reg?.saldo_documento ?? null, documento: reg?.documento || null, documento_path: reg?.documento_path || null,
            conciliada: !!reg?.conciliada, justificativa: reg?.justificativa || '', dif, composicao,
            comentarios: coments[cod] || [],
          })
        }
        if (vivo) setContas(out)
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  async function abrirDoc(path, nome) {
    try {
      const { data, error } = await supabase.storage.from('extratos').createSignedUrl(path, 300, nome ? { download: nome } : undefined)
      if (error) throw error
      window.open(data.signedUrl, '_blank')
    } catch (e) { alert('Não consegui abrir o documento: ' + (e?.message || e)) }
  }

  // Gera um .zip com a planilha timbrada + a pasta anexos/ com os PDFs originais.
  // A planilha traz um link relativo por conta ("anexos/<conta>_<doc>.pdf"): ao
  // descompactar, clicar na célula abre o documento — offline e sem expirar.
  async function exportar() {
    if (!contas || exportando) return
    setExportando('zip')
    try {
      const zip = new JSZip()
      const pasta = zip.folder('anexos')
      const linkDe = {}
      for (const c of contas) {
        if (!c.documento_path) continue
        try {
          const { data, error } = await supabase.storage.from('extratos').download(c.documento_path)
          if (error || !data) continue
          const ext = (c.documento_path.match(/\.[a-z0-9]+$/i)?.[0]) || (c.documento?.match(/\.[a-z0-9]+$/i)?.[0]) || '.pdf'
          const base = String(c.documento || 'documento').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
          const fname = `${c.conta}_${base}${ext}`
          pasta.file(fname, await data.arrayBuffer())
          linkDe[c.conta] = `anexos/${fname}`
        } catch { /* pula anexo com erro, segue os demais */ }
      }

      const totSaldo = contas.reduce((s, c) => s + c.saldo_final, 0)
      const sub = `${empresaNome} · CNPJ ${fmtCnpj(cnpj)} · competência ${competencia} · ${contas.length} contas patrimoniais`
      const colunas = [
        { nome: 'Conta / item', largura: 16 },
        { nome: 'Nome / histórico', largura: 44, wrap: true },
        { nome: 'Saldo / valor', alinhar: 'right', moeda: true },
        { nome: 'Documento', alinhar: 'right', moeda: true },
        { nome: 'Diferença', alinhar: 'right', moeda: true },
        { nome: 'Situação / anexo', largura: 26 },
      ]
      const secoes = [{
        titulo: 'Amarração geral — contas patrimoniais',
        linhas: contas.map(c => [
          c.conta, c.nome, num(c.saldo_final),
          c.saldo_documento == null ? '' : num(c.saldo_documento),
          c.dif == null ? '' : num(c.dif),
          linkDe[c.conta] ? { text: 'Abrir PDF', hyperlink: linkDe[c.conta] } : statusConta(c).txt,
        ]),
        totais: ['', 'Total patrimonial', num(totSaldo), '', '', ''],
      }]
      // Uma folha por conta patrimonial — TODAS, espelhando a tela: composição (quando
      // houver), amarração (saldo × documento × diferença × situação) e documento-suporte
      // (nome do arquivo ou justificativa). Contas sem composição vêm só com o saldo.
      for (const c of contas) {
        const anexo = linkDe[c.conta] ? { text: 'Abrir PDF', hyperlink: linkDe[c.conta] } : (c.documento_path ? '(anexo indisponível)' : '')
        const st = statusConta(c)
        const linhasSec = []
        if (c.composicao.length) {
          for (const i of c.composicao) linhasSec.push([dataBR(i.data), i.historico, num(i.debito) - num(i.credito), '', '', ''])
          linhasSec.push(['', 'Saldo da conta (composição)', num(c.saldo_final), '', '', ''])
        }
        linhasSec.push(['Amarração', `saldo × documento × diferença · ${st.txt}`, num(c.saldo_final),
          c.saldo_documento == null ? '' : num(c.saldo_documento), c.dif == null ? '' : num(c.dif), anexo])
        const sup = c.documento ? `Documento: ${c.documento}`
          : (c.justificativa ? `Justificativa: ${c.justificativa}` : 'Sem documento nem justificativa anexados')
        linhasSec.push(['Documento-suporte', sup, '', '', '', anexo])
        for (const m of (c.comentarios || [])) {
          const quem = m.usuario ? ` · ${String(m.usuario).split('@')[0]}` : ''
          linhasSec.push(['Comentário', `${m.texto}  (${dataBRhora(m.created_at)}${quem})`, '', '', '', ''])
        }
        secoes.push({
          titulo: `${c.conta} · ${c.nome} — ${c.grupo} (natureza ${c.natureza})`,
          linhas: linhasSec,
        })
      }
      const buf = await gerarExcelTimbrado({ titulo: 'Book de Composições — contas patrimoniais', sub, colunas, secoes, aba: 'Book', retornarBuffer: true })
      const nomeBase = `book_composicoes_${(empresaNome || 'cliente').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}_${competencia.replace('/', '-')}`
      zip.file(`${nomeBase}.xlsx`, buf)

      const blob = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${nomeBase}.zip`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    } catch (e) {
      alert('Não consegui gerar o pacote: ' + (e?.message || e))
    } finally {
      setExportando('')
    }
  }

  if (semComp) return <Aviso icon="ti-file-import" texto="Importe o razão desta competência primeiro." />
  if (carregando || contas === null) return <p style={{ color: theme.sub, fontSize: 13 }}>Montando o book de composições…</p>
  if (!contas.length) return <Aviso icon="ti-database-off" texto="Nenhuma conta patrimonial com saldo nesta competência." />

  const totSaldo = contas.reduce((s, c) => s + c.saldo_final, 0)
  const pendentes = contas.filter(c => statusConta(c).cor !== theme.green).length
  const grupos = ['Ativo', 'Passivo + PL']

  return (
    <div>
      {/* Cabeçalho + ações */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: 0 }}>
          <b style={{ color: theme.text }}>{empresaNome}</b> · CNPJ {fmtCnpj(cnpj)} · competência <b style={{ color: theme.text }}>{competencia}</b><br />
          {contas.length} conta(s) patrimonial(is) · {pendentes === 0
            ? <span style={{ color: theme.green }}>amarração completa ✓</span>
            : <span style={{ color: theme.yellow }}>{pendentes} conta(s) sem documento/amarração</span>}
        </p>
        <div className="no-print" style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportar} disabled={!!exportando}
            title="Baixa um .zip com a planilha timbrada + os PDFs originais (pasta anexos/)"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: exportando ? .6 : 1 }}>
            <i className={`ti ${exportando ? 'ti-loader-2' : 'ti-file-zip'}`} /> {exportando ? 'Gerando ZIP…' : 'Excel + PDFs (.zip)'}
          </button>
          <button className="btn-ghost" onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-type-pdf" /> PDF</button>
        </div>
      </div>

      {/* Amarração geral */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', marginBottom: 22 }}>
        <div style={{ padding: '11px 14px', borderBottom: `1px solid ${theme.border}`, fontSize: 13, fontWeight: 600 }}>
          Amarração geral — saldo contábil × documento × diferença
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Conta</th><th style={th}>Nome</th>
              <th style={thNum}>Saldo contábil</th><th style={thNum}>Documento</th><th style={thNum}>Diferença</th><th style={th}>Situação</th>
            </tr>
          </thead>
          <tbody>
            {contas.map((c, i) => {
              const st = statusConta(c)
              return (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={td}>{c.conta}</td>
                  <td style={td}>{c.nome || '—'}</td>
                  <td style={tdNum}>{money(c.saldo_final)}</td>
                  <td style={tdNum}>{c.saldo_documento == null ? '—' : money(c.saldo_documento)}</td>
                  <td style={{ ...tdNum, color: c.dif == null ? theme.sub : Math.abs(c.dif) < 0.05 ? theme.green : theme.red }}>{c.dif == null ? '—' : money(c.dif)}</td>
                  <td style={{ ...td, color: st.cor }}>{st.txt}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
              <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total patrimonial</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{money(totSaldo)}</td>
              <td style={tdNum}></td><td style={tdNum}></td><td style={td}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Folhas por conta */}
      {grupos.map(g => {
        const doGrupo = contas.filter(c => c.grupo === g)
        if (!doGrupo.length) return null
        return (
          <div key={g} style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: .5, color: theme.sub, margin: '10px 0' }}>{g}</h3>
            {doGrupo.map((c, i) => <Folha key={i} c={c} onAbrir={abrirDoc} />)}
          </div>
        )
      })}
    </div>
  )
}

function Folha({ c, onAbrir }) {
  const st = statusConta(c)
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 14, overflow: 'hidden', marginBottom: 14, breakInside: 'avoid' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${theme.border}`, background: theme.input }}>
        <div>
          <div style={{ fontSize: 11, color: theme.sub, fontWeight: 700 }}>{c.conta} · {c.grupo}</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{c.nome || 'Conta sem nome no plano'}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: .5, color: theme.sub, fontWeight: 700 }}>Saldo contábil</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -.4 }}>{money(c.saldo_final)}</div>
          <div style={{ fontSize: 11, color: theme.sub }}>natureza {c.natureza === 'D' ? 'Devedora (D)' : 'Credora (C)'}</div>
        </div>
      </div>
      <div style={{ padding: 18 }}>
        {/* Composição */}
        {c.composicao.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <div style={blkT}>Composição — títulos em aberto</div>
            <div style={{ border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: theme.input }}><th style={th}>Data</th><th style={th}>Histórico</th><th style={thNum}>Valor</th></tr></thead>
                <tbody>
                  {c.composicao.map((it, j) => (
                    <tr key={j} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dataBR(it.data)}</td>
                      <td style={{ ...td, whiteSpace: 'normal', maxWidth: 460 }}>{it.historico}</td>
                      <td style={tdNum}>{money(num(it.debito) - num(it.credito))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Saldo da conta</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(c.saldo_final)}</td>
                </tr></tfoot>
              </table>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: theme.sub, marginBottom: 16 }}>
            Conta amarrada pelo saldo × documento (composição por título não se aplica a esta conta).
          </p>
        )}

        {/* Amarração */}
        <div style={{ marginBottom: 16 }}>
          <div style={blkT}>Amarração</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 1, background: theme.border, border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <Cel l="Saldo contábil" v={money(c.saldo_final)} />
            <Cel l="Documento" v={c.saldo_documento == null ? '—' : money(c.saldo_documento)} />
            <Cel l="Diferença" v={c.dif == null ? '—' : money(c.dif)} cor={c.dif == null ? undefined : Math.abs(c.dif) < 0.05 ? theme.green : theme.red} />
            <Cel l="Situação" v={st.txt} cor={st.cor} small />
          </div>
        </div>

        {/* Documento-suporte */}
        <div>
          <div style={blkT}>Documento-suporte</div>
          {c.documento_path ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: `1px solid ${theme.border}`, borderRadius: 9 }}>
              <span style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(229,72,77,.16)', color: theme.red, fontWeight: 800, fontSize: 11 }}>DOC</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.documento || 'documento anexado'}</div>
                <div style={{ fontSize: 11, color: theme.sub }}>arquivo original anexado à conciliação</div>
              </div>
              <button className="btn-ghost no-print" onClick={() => onAbrir(c.documento_path, c.documento)} style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 11px' }}>Abrir ↗</button>
            </div>
          ) : c.justificativa ? (
            <p style={{ fontSize: 12.5, color: theme.text, padding: '9px 12px', border: `1px solid ${theme.border}`, borderRadius: 9, margin: 0 }}>
              <b style={{ color: theme.sub }}>Justificativa:</b> {c.justificativa}
            </p>
          ) : (
            <p style={{ fontSize: 12.5, color: theme.yellow, margin: 0 }}><i className="ti ti-alert-triangle" /> Sem documento anexado nem justificativa.</p>
          )}
        </div>

        {/* Comentários da conta (histórico que acompanha a conta em todos os meses) */}
        {c.comentarios && c.comentarios.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ ...blkT, color: theme.accent }}><i className="ti ti-message-2" style={{ marginRight: 5 }} />Comentários da conta</div>
            <div style={{ border: `1px solid rgba(74,124,255,.28)`, borderLeft: `3px solid ${theme.accent}`, background: 'rgba(74,124,255,.06)', borderRadius: 9, overflow: 'hidden' }}>
              {c.comentarios.map((m, j) => (
                <div key={j} style={{ padding: '9px 12px', borderTop: j ? `1px solid rgba(74,124,255,.18)` : 'none' }}>
                  <div style={{ fontSize: 12.5, color: theme.text, whiteSpace: 'pre-wrap' }}>{m.texto}</div>
                  <div style={{ fontSize: 11, color: theme.sub, marginTop: 3 }}>{dataBRhora(m.created_at)}{m.usuario ? ` · ${String(m.usuario).split('@')[0]}` : ''}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Cel({ l, v, cor, small }) {
  return (
    <div style={{ background: theme.card, padding: '10px 13px' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: .5, color: theme.sub, fontWeight: 700 }}>{l}</div>
      <div style={{ fontSize: small ? 12.5 : 15, fontWeight: small ? 600 : 800, marginTop: 3, color: cor || theme.text }}>{v}</div>
    </div>
  )
}
function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}

const blkT = { fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5, color: theme.sub, marginBottom: 9 }
const th = { textAlign: 'left', padding: '9px 13px', fontSize: 10.5, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '8px 13px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
