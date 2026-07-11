import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../components/AuthProvider'
import { theme } from '../lib/theme'

// Biblioteca de modelos de relatório gerencial. Por enquanto o modelo é só um nome/rótulo;
// depois ele é vinculado ao cliente (no cadastro) e libera o card "Relatório Gerencial"
// em Relatórios. O conteúdo do modelo (arquivo/estrutura) vem numa próxima onda.
export default function ModRelatorioGerencial() {
  const { user } = useAuth()
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [nome, setNome] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')

  async function carregar() {
    setLoading(true)
    const { data, error } = await supabase.from('modelos_relatorio_gerencial')
      .select('id, nome, usuario, created_at').order('created_at', { ascending: true })
    if (error) setErro(error.message)
    setLista(data || [])
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  async function adicionar(e) {
    e.preventDefault()
    const n = nome.trim()
    if (!n) return
    setSalvando(true); setErro('')
    const { error } = await supabase.from('modelos_relatorio_gerencial').insert({ nome: n, usuario: user?.email })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setNome(''); carregar()
  }

  async function excluir(m) {
    if (!window.confirm(`Excluir o modelo "${m.nome}"? Os clientes vinculados ficam sem modelo.`)) return
    setErro('')
    const { error } = await supabase.from('modelos_relatorio_gerencial').delete().eq('id', m.id)
    if (error) { setErro(error.message); return }
    carregar()
  }

  const dataBR = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Mod. Relatório Gerencial</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Cadastre os modelos de relatório gerencial. Depois, vincule um modelo ao cliente (no cadastro) para liberar o Relatório Gerencial em Relatórios.
      </p>

      <form onSubmit={adicionar} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', maxWidth: 560, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', fontSize: 12.5, color: theme.sub, marginBottom: 4 }}>Nome do modelo</label>
          <input className="input" value={nome} onChange={e => setNome(e.target.value)} placeholder="Ex.: Gerencial Padrão · Indústria" />
        </div>
        <button className="btn" disabled={salvando || !nome.trim()}>{salvando ? 'Salvando…' : '＋ Adicionar'}</button>
      </form>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>Erro: {erro}</p>}

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden', maxWidth: 720 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              {['Modelo', 'Criado por', 'Data', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 20, color: theme.sub }}>Nenhum modelo cadastrado. Adicione o primeiro acima.</td></tr>
            ) : lista.map(m => (
              <tr key={m.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 500 }}><i className="ti ti-report-analytics" style={{ color: theme.accent, marginRight: 8 }} />{m.nome}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{m.usuario ? String(m.usuario).split('@')[0] : '—'}</td>
                <td style={{ padding: '11px 14px', fontSize: 13, color: theme.sub }}>{dataBR(m.created_at)}</td>
                <td style={{ padding: '11px 14px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(m)}>excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
