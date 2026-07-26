# Observabilidade RevOps — Branddi

Dashboard de saúde do processo de enriquecimento (**Lead Generator → Lia → Enrique**).
Front estático no **Vercel**, dados atualizados **todo dia** por uma **GitHub Action** que roda o coletor e commita o `public/data.json`.

```
06:00 BRT (09:00 UTC)  →  GitHub Action dispara scripts/collect.mjs
                       →  puxa Pipedrive + Supabase Lia + API OPEC Enrique
                       →  grava public/data.json + git push
                       →  Vercel re-deploya automático → dashboard atualizado
```

Correções de integridade já embutidas no coletor:
- **Company Score conta cards únicos** (`distinct deal_id`) — a tabela é insert-only e re-pontua.
- **"Hoje" usa fuso `America/Sao_Paulo`** (BRT), não UTC.

---

## Como publicar (uma vez)

### 1. Criar o repositório no GitHub
```bash
cd revops-observability
git init && git add . && git commit -m "feat: dashboard de observabilidade RevOps"
gh repo create branddi/revops-observability --private --source=. --push
# (ou crie o repo pela UI e faça git remote add origin ... && git push -u origin main)
```

### 2. Adicionar os Secrets no GitHub
Repositório → **Settings → Secrets and variables → Actions → New repository secret**. Adicione:

| Secret | Onde achar |
|---|---|
| `PIPEDRIVE_API_TOKEN` | token brandmonitor (mesmo do `branddi-lead-generator/.env.local`) |
| `SUPABASE_URL` | Supabase da Lia (`Lia/.env` → `SUPABASE_URL`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase da Lia (`Lia/.env`) |
| `ENRIQUE_OPEC_KEY` | `Lia/.env` → `ENRIQUE_OPEC_KEY` |
| `ENRIQUE_SUPABASE_URL` *(opcional)* | `https://quhgmjvvwaezeampgaln.supabase.co` |
| `ENRIQUE_SERVICE_ROLE_KEY` *(opcional)* | painel Supabase do Enrique → destrava providers/áreas do garimpo |

> Sem os dois últimos, o dashboard funciona — só a seção de **providers do Enrique** fica pendente.

### 3. Conectar ao Vercel
- [vercel.com](https://vercel.com) → **Add New → Project** → importe o repo.
- Framework: **Other** · Build Command: *(vazio)* · Output Directory: **public**.
- Deploy. Pronto — a cada push (inclusive os da Action) o Vercel re-deploya.

### 4. Rodar a Action a primeira vez
GitHub → aba **Actions** → *Coletor diário RevOps* → **Run workflow**. Isso gera o primeiro `data.json` real. Depois roda sozinho às 06:00 BRT.

---

## Rodar local (teste)
```bash
# defina as variáveis de ambiente (ou use um .env + dotenv) e:
npm run collect      # gera public/data.json
npm run dev          # serve em http://localhost:4000
```

## Estrutura
```
scripts/collect.mjs        # coletor (Pipedrive + Supabase + OPEC) → public/data.json
public/index.html          # dashboard (lê data.json, seletor Hoje/7/15/30, claro+escuro)
public/data.json           # gerado pelo coletor (não editar à mão)
.github/workflows/daily.yml# cron diário 06:00 BRT
vercel.json                # deploy estático (outputDirectory: public)
```

## Ainda pendente de fonte (aparecem como "1 query" no painel)
- **Providers/áreas do Enrique** (garimpo.*) → precisa da `ENRIQUE_SERVICE_ROLE_KEY`.
- **Conversão por etapa / tempo médio** → precisa materializar o `/deals/flow` do Pipedrive.
- **Triagem e reaberturas do Lead Generator** → precisa das creds do Supabase do Lead Generator.
