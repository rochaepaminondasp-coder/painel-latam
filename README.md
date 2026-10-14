# Painel LATAM 📊

Painel diário de resultados para infoproduto rodando **native ads** (Taboola, MGID, Outbrain, Revcontent…) em vários países da América Latina.

Todo dia você lança o resultado de ontem **por plataforma e por país**: investimento, impressões, cliques, cliques no link, checkouts iniciados, vendas e faturamento. O painel monta o funil completo e calcula lucro, ROAS, CPA, CPC, CTR, CPM, EPC e conversões. Ele também mostra qual plataforma, país e anúncio estão dando mais lucro.

É **um único arquivo** (`index.html`), sem servidor e sem banco de dados.

🔗 **Painel no ar:** https://rochaepaminondasp-coder.github.io/painel-latam/

---

## Rotina diária

1. Abra o painel. Se o dia de ontem ainda não foi lançado, aparece um aviso com o botão **Lançar dd/mm**.
2. **Bloco 1 — Resultados por plataforma e país:** escolha a aba da plataforma (Taboola, MGID…). Preencha cada país; embaixo de cada linha já aparecem CPC, CTR, EPC, CPA e ROAS. Troque de aba e repita para a outra plataforma.
3. **Bloco 2 — Anúncios do dia (opcional):** nome ou ID do anúncio, plataforma, país, investimento, cliques, vendas e faturamento.
   - **Repetir anúncios do último dia** já traz os mesmos criativos; é só preencher os números.
   - Os anúncios são um detalhamento: servem para comparar criativos e **não somam** nos totais do dia.
4. **Bloco 3:** reembolsos, outros custos e observações.
5. **Salvar dia**.

Atalho: tecla **N** abre um novo lançamento.

### Preencher a partir de um print

Na aba da plataforma, arraste, cole (**Ctrl+V**) ou clique na área de print:

- **Relatório do native**: print do Taboola/MGID **quebrado por país**. Preenche investimento, impressões e cliques.
- **Relatório de vendas**: print da plataforma de vendas por país. Preenche vendas e faturamento.

A leitura roda no seu navegador (nada é enviado para servidor). **Sempre confira** os números destacados antes de salvar.

---

## O que o painel mostra

| Aba | Conteúdo |
|---|---|
| **Visão geral** | KPIs financeiros, **funil do native** (impressões → cliques → cliques no link → checkouts → vendas, com a taxa entre etapas e o custo de cada uma), métricas de tráfego (CTR, CPC, EPC, CPM, CTR da presell, taxa de checkout, conversão, custo por checkout), EPC × CPC, taxas do funil, lucro diário e acumulado, calendário de lucro/prejuízo e vendas por país |
| **Plataformas** | Card de cada plataforma com selo Escalar/Lucrativo/Revisar, **matriz Plataforma × País** (ROAS, lucro, CPA, EPC, CPC ou CTR), lucro diário por plataforma |
| **Anúncios** | 🏆 Melhor anúncio do período, alerta de anúncios queimando verba, ranking completo e ROAS por anúncio |
| **Países** | Sugestão de distribuição de verba, ranking de países e tendência |
| **Histórico** | Todos os dias, com detalhe por plataforma, país e anúncio; exportar CSV |

Filtros no topo: período (7d, 14d, 30d, mês, 90d, tudo, personalizado), **plataforma** e **país**.

---

## Fórmulas

```
Lucro = Faturamento − Investimento − (Faturamento × Taxa%) − Reembolsos − Outros custos
ROAS  = Faturamento ÷ Investimento        CPA  = Investimento ÷ Vendas
CTR   = Cliques ÷ Impressões              CPC  = Investimento ÷ Cliques
CPM   = Investimento ÷ Impressões × 1000  EPC  = Faturamento ÷ Cliques
CTR da presell     = Cliques no link ÷ Cliques
Taxa de checkout   = Checkouts iniciados ÷ Cliques no link
Conversão checkout = Vendas ÷ Checkouts iniciados
```

**EPC acima do CPC = cada clique está dando lucro.**

---

## Configurações

- **Moeda**: R$, US$ ou €. Lance os valores já convertidos.
- **Taxa da plataforma de vendas (%)**: descontada do faturamento.
- **Ticket padrão**: faturamento automático = vendas × ticket.
- **Meta de lucro diário**.
- **Métricas do funil**: ligue ou desligue impressões, cliques, cliques no link e checkouts.
- **Plataformas** e **países** que aparecem no lançamento.

---

## ⚠️ Onde ficam os dados

Os lançamentos ficam salvos **no navegador**, não no GitHub.

- **Exporte um backup** com frequência (ícone ⬇ no topo).
- Para usar em outro computador ou no celular, use **Importar backup** lá.
- Lançamentos feitos na versão anterior do painel continuam valendo. Eles aparecem com a plataforma "Não informada".

Para testar: *Configurações → Carregar dados de exemplo* e depois **Limpar exemplo**.

---

## Como atualizar no GitHub Pages

Substitua o `index.html` no repositório (Add file → Upload files) e faça o commit. Em 1–2 minutos a nova versão está no ar.
