import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Aviso claro em dev caso o .env.local não esteja preenchido.
  console.warn('Supabase: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.local')
}

// Segurança: a sessão fica em sessionStorage (não localStorage). Assim, ao
// FECHAR a página/aba, a sessão é descartada e o usuário precisa logar de novo.
export const supabase = createClient(url, anonKey, {
  auth: {
    storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
  },
})
