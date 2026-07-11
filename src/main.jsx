import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

// Ao publicar uma versão nova, os arquivos (chunks) ganham novo hash e os antigos
// somem do servidor. Uma aba já aberta que tenta carregar um chunk sob demanda
// (ex.: ExcelJS no export do Book) bate em "Failed to fetch dynamically imported
// module". Aqui recarregamos a página uma única vez para pegar a versão nova —
// o sessionStorage evita loop de reload caso o erro seja outro.
function recarregarSePreloadFalhou() {
  const CHAVE = 'reload-chunk-desatualizado'
  if (sessionStorage.getItem(CHAVE)) { sessionStorage.removeItem(CHAVE); return }
  sessionStorage.setItem(CHAVE, '1')
  window.location.reload()
}
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); recarregarSePreloadFalhou() })
// Rede/CDN às vezes rejeita o import sem disparar o vite:preloadError — cobrimos
// também o unhandledrejection cuja mensagem indica módulo dinâmico não carregado.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e?.reason?.message || e?.reason || '')
  if (/dynamically imported module|Importing a module script failed/i.test(msg)) recarregarSePreloadFalhou()
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
