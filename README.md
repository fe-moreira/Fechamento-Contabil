# Contabilidade by Attentive

Plataforma web para padronizar o fechamento contábil mensal dos clientes do escritório.
Stack: **React + Vite + Supabase**. Deploy: **Vercel**.

> Contexto completo do produto em [`CONTEXT.md`](./CONTEXT.md). Instruções para o assistente
> em [`CLAUDE.md`](./CLAUDE.md). Protótipo de referência (UX/regras) em `prototipo/` e
> publicado em `/prototipo.html`.

## O que já funciona

- Login (Supabase Auth).
- **Cadastro de Clientes** ponta a ponta (lista, cria, edita, exclui — gravando no Supabase).
- Dashboard com contagem real de clientes.

## Próximas ondas

Importação do razão (Excel do Domínio) → balancete → conciliação com farol →
comparativo → contabilizar → relatórios. A UX dessas telas está no protótipo.

## Como rodar

1. Crie as tabelas: rode `supabase/schema.sql` no SQL Editor do Supabase.
2. Crie um usuário em **Authentication → Users** (não há cadastro aberto).
3. Configure o ambiente:
   ```bash
   npm install
   cp .env.example .env.local      # preencha VITE_SUPABASE_ANON_KEY
   npm run dev
   ```
4. Acesse http://localhost:5173 e entre com o usuário criado.

## Deploy na Vercel

- Framework: **Vite**. Build: `npm run build`. Output: `dist`.
- Variáveis de ambiente na Vercel: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
- **Nunca** colocar a chave `service_role` em variável de front nem no Git.

## Segurança

`.env.local`, `.env`, `.vercel` estão no `.gitignore`. Só a chave `anon`/publishable é usada
no front. RLS está habilitado: por enquanto, qualquer usuário autenticado acessa (refinar por
papel depois).
