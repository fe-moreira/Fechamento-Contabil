import { useEffect, useState } from 'react'
import { theme } from '../lib/theme'

// Caminho do bundle principal que ESTA aba carregou (o <script> do index.html atual).
function bundleCarregado() {
  const s = document.querySelector('script[type="module"][src*="/assets/index-"]')
  try { return s ? new URL(s.src, location.origin).pathname : null } catch { return null }
}
// Caminho do bundle principal do index.html PUBLICADO agora (sem cache). Além de `no-store`,
// coloca um parâmetro único na URL — alguns proxies/CDN ignoram o no-store e devolvem o
// index.html velho; o ?t=... fura esse cache e garante que a gente veja a versão publicada.
async function bundlePublicado() {
  try {
    const html = await fetch(`/index.html?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.text())
    const m = html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)
    return m ? m[1] : null
  } catch { return null }
}

// Aviso de NOVA VERSÃO: uma aba já aberta continua rodando o código antigo até
// recarregar. Aqui detectamos um deploy novo (o index.html passa a apontar para outro
// bundle) e mostramos um aviso para atualizar — sem recarregar sozinho no meio de um
// preenchimento. Assim todo mundo fica na mesma versão sem depender de F5 manual.
export default function AvisoNovaVersao() {
  const [novo, setNovo] = useState(false)
  useEffect(() => {
    const carregado = bundleCarregado()
    if (!carregado) return // dev (sem /assets/index-*) — nada a checar
    let parado = false
    const checar = async () => {
      if (parado) return
      const pub = await bundlePublicado()
      if (pub && pub !== carregado) { setNovo(true); parado = true }
    }
    checar()
    const id = setInterval(checar, 60 * 1000)     // a cada 1 min (antes 3 min) — nota mais rápido
    const onFocus = () => checar()                // quando volta o foco da janela
    const onVis = () => { if (document.visibilityState === 'visible') checar() } // e quando a ABA reaparece
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  if (!novo) return null
  return (
    // No TOPO (não embaixo): a barra de seleção/"Conectar (baixar)" da Conciliação também fica
    // fixa embaixo-centro — se este aviso ficasse embaixo, cobria o botão de baixar e dava a
    // impressão de que "não dá para baixar". Aqui em cima, nunca sobrepõe uma ação.
    <div style={{ position: 'fixed', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', alignItems: 'center', gap: 12, background: theme.card, border: `1px solid ${theme.accent}`, borderRadius: 12, padding: '10px 16px', boxShadow: '0 8px 30px rgba(0,0,0,0.45)', maxWidth: '94vw' }}>
      <i className="ti ti-rocket" style={{ color: theme.accent, fontSize: 18, flexShrink: 0 }} />
      <span style={{ color: theme.text, fontSize: 13 }}>Saiu uma <b>versão nova</b> do sistema. Atualize para pegar as últimas melhorias.</span>
      <button className="btn" style={{ fontSize: 12.5, padding: '5px 12px', flexShrink: 0 }} onClick={() => window.location.reload()}><i className="ti ti-refresh" /> Atualizar agora</button>
    </div>
  )
}
