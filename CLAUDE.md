# CLAUDE.md

**Leia `CONTEXT.md` no início de cada sessão.** É o contexto-mestre do produto
"Contabilidade by Attentive" (visão, módulos, regras do Domínio/LALUR/banco×resultado,
layout dos arquivos, ordem de construção).

## Como este repositório está organizado

- **App funcional (React + Vite + Supabase):** raiz do projeto (`src/`, `index.html`, `package.json`).
  - Já funcional: autenticação (Supabase Auth) e **Cadastro de Clientes** ponta a ponta
    (lê e grava na tabela `clientes`).
  - Esqueleto pronto para as próximas ondas: Fechamentos (razão, balancete, conciliação).
- **Schema do banco:** `supabase/schema.sql` (rodar no SQL Editor do Supabase).
- **Protótipo de referência (UX/regras):** `prototipo/prototipo-plataforma-contabil.html`
  e servido em `/prototipo.html`. É **referência visual** — não é o código de produção.

## Regras de trabalho

1. Construir por ondas, começando pelo **núcleo**: clientes → import do razão → balancete → conciliação.
2. Preservar histórico por **vigência** nas tabelas de cadastro (nunca sobrescrever).
3. Toda justificativa/correção registra **usuário e data** (tabela `auditoria`).
4. **Segurança:** a chave `service_role` do Supabase **nunca** vai ao front nem ao Git.
   Só a `anon`/publishable, via `VITE_SUPABASE_ANON_KEY` no `.env.local` (que está no `.gitignore`).
5. Pare e peça confirmação antes de: criar repositório, push, deploy de produção, e antes
   de criar/alterar tabelas no Supabase.
6. **Manual sempre atualizado:** o Manual do Time (`src/pages/Manual.jsx`, acessível pelo
   menu **Ajuda**) é documentação viva. Todo PR que cria/altera/remove uma funcionalidade,
   tela ou regra **deve atualizar a seção correspondente do manual no mesmo PR** — nunca
   deixar o manual desatualizado em relação ao produto.

## Rodar localmente

```bash
npm install
cp .env.example .env.local   # preencha VITE_SUPABASE_ANON_KEY
npm run dev
```

Antes do primeiro login, rode `supabase/schema.sql` no Supabase e crie um usuário em
Authentication → Users.
