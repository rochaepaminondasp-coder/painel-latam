# Painel LATAM 📊

Painel diário de resultados para infoproduto rodando **native ads** (MGID, Taboola, Outbrain…) em vários países da América Latina.

🔗 **Link do painel:** https://rochaepaminondasp-coder.github.io/painel-latam/

**Quem abre o link vê os mesmos dados.** Os lançamentos ficam salvos no arquivo `data.json` deste repositório. Só quem conectar o GitHub (o dono) consegue lançar e editar; o resto só visualiza.

---

## Primeira vez (só o dono, uma vez por navegador)

1. Abra o link → **Configurações → Compartilhar e editar**.
2. Crie um token em https://github.com/settings/personal-access-tokens/new:
   - **Token name:** `painel-latam`
   - **Expiration:** ex.: 1 ano
   - **Repository access:** *Only select repositories* → `painel-latam`
   - **Permissions → Repository permissions → Contents:** *Read and write*
3. Gere o token, cole no painel e clique em **Conectar**.

O token fica salvo só naquele navegador. Para lançar de outro computador ou do celular, repita o passo no outro aparelho.

---

## Rotina diária

1. **Lançar dia** (ou tecla **N**).
2. **Bloco 1 — Tráfego:** arraste o **CSV exportado da MGID** na área de importação.
   - O painel reconhece as colunas e puxa **investimento, impressões, cliques, Page View e Initiate Checkout**.
   - **Receita e ROAS da planilha nunca são importados.** O faturamento vem das vendas que você lança e o ROAS é calculado pelo painel.
   - A coluna de **Compras (pixel)** também fica de fora por padrão (você lança as vendas), mas dá para ligar.
   - **Campanhas → país:** se a planilha não tiver coluna de país, o painel detecta pelo nome da campanha:
     - `AR - …` ou `[CL] …` vira o país;
     - campanha sem país no nome vira **🌎 Vários países**;
     - você pode corrigir, e o painel lembra nos próximos dias.
   - **Moeda:** se a MGID estiver em dólar, escolha USD e informe a cotação. O painel converte.
   - As campanhas também entram no ranking da aba **Anúncios**.
   - Também dá para usar **print** (Ctrl+V) ou **digitar**.
3. **Bloco 2 — Vendas:** vendas e faturamento de **front** e de **upsell** por país.
4. **Salvar dia** → em segundos aparece para todo mundo no link.

---

## O que o painel mostra

| Aba | Conteúdo |
|---|---|
| **Visão geral** | Lucro, faturamento (front + upsell), investimento, ROAS, CPA, ticket; **funil** impressões → cliques → page view → initiate checkout → vendas, com taxas e custo de cada etapa; CTR, CPC, CPM, EPC, taxa de chegada, custo por page view, custo por checkout, taxa de upsell; gráficos e calendário de lucro/prejuízo |
| **Plataformas** | MGID × Taboola e matriz **Plataforma × País** |
| **Anúncios** | Melhor campanha/anúncio, alertas e ranking |
| **Países** | Ranking e sugestão de distribuição de verba ("Vários países" fica de fora da sugestão) |
| **Histórico** | Todos os dias, com detalhe e exportação CSV |

## Fórmulas

```
Faturamento total = faturamento front + faturamento upsell
Lucro = Faturamento total − Investimento − Taxa% − Reembolsos − Outros custos
ROAS = Faturamento total ÷ Investimento     CPA = Investimento ÷ Vendas front
CTR = Cliques ÷ Impressões                  CPC = Investimento ÷ Cliques
EPC = Faturamento total ÷ Cliques           Taxa de chegada = Page views ÷ Cliques
Page view → checkout = Initiate checkout ÷ Page views
Conversão do checkout = Vendas front ÷ Initiate checkout
Taxa de upsell = Vendas upsell ÷ Vendas front
```

---

## 🤖 Vendas automáticas (Ratoeira Ads)

O robô `.github/workflows/ratoeira.yml` roda **a cada 3 horas**:
1. Busca na Ratoeira Ads (via MCP) as vendas dos últimos 3 dias, sem contar hoje.
2. Separa **front** (SALE), **upsell** (UPSELL) e **reembolsos** por **ID da campanha da MGID**.
3. Grava em `data.json`. O painel converte de USD para real pela cotação comercial do dia, ou pela cotação fixa definida em Configurações.

Cada venda entra na campanha certa pelo **ID**, que vem da coluna `id` do CSV da MGID, e no país em que a campanha está no painel. As campanhas "Latam", por exemplo, ficam em 🌎 Vários países. Quando um dia tem vendas da Ratoeira, o bloco de vendas da MGID no lançamento fica travado, porque não precisa digitar.

**Configuração (uma vez):** em *Settings → Secrets and variables → Actions → New repository secret*:
- Name: `RATOEIRA_MCP_URL`
- Secret: a URL do MCP da Ratoeira, com `?token=…`

**Rodar na hora:** aba *Actions → Vendas da Ratoeira → Run workflow*.

Os logs do robô mostram só contagens, nunca dados de clientes.

---

## Privacidade

O repositório é **público** (o GitHub Pages gratuito exige isso). Ou seja, os números do `data.json` podem ser vistos por qualquer pessoa que encontre o repositório, não só por quem tem o link. Se um dia quiser fechar, dá para tornar o repositório privado com o plano GitHub Pro ou migrar os dados para outro serviço.

O **modo exemplo** (Configurações → Carregar dados de exemplo) fica só no seu navegador e nunca vai para o link.
