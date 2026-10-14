# Painel LATAM 📊

Painel diário de resultados para infoproduto rodando em vários países da América Latina.
Você lança, todo dia, o resultado de ontem (investimento em tráfego, vendas e faturamento por país). O painel calcula lucro, ROAS, CPA, ticket médio e margem, e mostra quais dias deram lucro ou prejuízo e para qual país vale mandar mais verba.

É **um único arquivo** (`index.html`), sem servidor, sem build e sem banco de dados.

---

## Como publicar no GitHub Pages

1. Crie um repositório novo no GitHub (ex.: `painel-latam`). Pode ser **privado** se seu plano permitir Pages privado; senão, público (os dados **não** ficam no repositório, ficam no seu navegador).
2. Envie os arquivos `index.html` e `README.md`:
   - Pelo site: **Add file → Upload files** → arraste os dois → **Commit changes**.
   - Ou pelo terminal:
     ```bash
     git init
     git add index.html README.md
     git commit -m "Painel LATAM"
     git branch -M main
     git remote add origin https://github.com/SEU-USUARIO/painel-latam.git
     git push -u origin main
     ```
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
4. Em 1–2 minutos o painel fica no ar em `https://SEU-USUARIO.github.io/painel-latam/`.

Também funciona abrindo o `index.html` direto no navegador (duplo clique).

---

## Rotina diária (1 minuto)

1. Abra o painel. Se o dia de ontem ainda não foi lançado, aparece um aviso amarelo com o botão **Lançar dd/mm**.
2. Para cada país, preencha **Investimento**, **Vendas** e **Faturamento**. O resumo no rodapé já mostra o lucro do dia antes de salvar.
3. (Opcional) Reembolsos, outros custos e uma observação ("subi criativo novo no Chile").
4. **Salvar dia**.

Se ficar alguns dias sem lançar, o aviso mostra quantos faltam e abre o mais antigo primeiro.
Atalho: tecla **N** abre um novo lançamento.

### Preencher a partir de um print

No formulário há a área **Preencher a partir de um print**: arraste a imagem, cole com **Ctrl+V** ou clique para escolher.

- **Relatório de vendas**: use um print do relatório da plataforma (Hotmart, Kiwify, Eduzz, etc.) **agrupado por país**. O painel lê o nome do país e os números da mesma linha e preenche *Vendas* e *Faturamento*.
- **Gasto em anúncios**: use um print do gerenciador de anúncios quebrado por país. O painel preenche *Investimento*.

A leitura (OCR) roda no seu navegador. Nada é enviado para servidor. Na primeira vez ele baixa o leitor (~10 MB). **Sempre confira os números** destacados antes de salvar; prints com fonte pequena ou colunas desalinhadas podem ser lidos errado.

---

## O que o painel mostra

**Visão geral**
- KPIs com variação vs. período anterior: lucro líquido, faturamento, investimento, ROAS, vendas, CPA, ticket médio, margem.
- Gráfico combinado de faturamento × investimento × lucro por dia (a linha fica vermelha nos dias de prejuízo).
- Lucro diário (verde/vermelho) e lucro acumulado.
- Calendário de resultados: cada quadradinho é um dia; tracejado = não lançado. Clique para lançar ou editar.
- Resumo do período: dias no lucro × prejuízo, melhor e pior dia, melhor país, sequência de dias no lucro e progresso da meta.

**Países**
- Ranking por lucro com selo **Escalar / Lucrativo / Revisar**.
- **Onde colocar a verba**: distribuição sugerida proporcional ao lucro de cada país vs. quanto ele recebe hoje.
- ROAS por país (com linha de corte em 1,0x) e tendência de faturamento por país.

**Histórico**: tabela de todos os dias (clique para ver o detalhe por país), editar/excluir e exportar CSV.

**Filtros**: 7d, 14d, 30d, mês, 90d, tudo ou período personalizado, e filtro por país.

---

## Configurações e cálculos

| Configuração | Para que serve |
|---|---|
| Moeda de exibição | R$, US$ ou €. Lance os valores **já convertidos** para essa moeda. |
| Taxas da plataforma (%) | Descontadas do faturamento (gateway, impostos, câmbio). |
| Ticket padrão | Se você só informar o nº de vendas, o faturamento é calculado como vendas × ticket. |
| Meta de lucro diário | Mostra a barra de progresso e quantos dias bateram a meta. |
| Países | Quais países já aparecem prontos no formulário. |

```
Lucro = Faturamento − Investimento − (Faturamento × Taxa%) − Reembolsos − Outros custos
ROAS  = Faturamento ÷ Investimento
CPA   = Investimento ÷ Vendas
Ticket médio = Faturamento ÷ Vendas
```

Na visão por país, o lucro considera faturamento, investimento e taxas. Reembolsos e outros custos são lançados no total do dia.

---

## ⚠️ Onde ficam os dados

Os lançamentos ficam salvos **no navegador** (localStorage), não no GitHub. Isso significa:

- Se você limpar os dados do navegador ou usar outro computador, eles não estarão lá.
- **Exporte um backup** com frequência (ícone ⬇ no topo ou *Configurações → Exportar backup*). É um arquivo `.json`.
- Para usar em outro computador ou celular: abra o painel lá e use **Importar backup**.

Para testar sem bagunçar nada: *Configurações → Carregar dados de exemplo*. Depois clique em **Limpar exemplo**.

---

## Tecnologias

HTML + CSS + JavaScript puro, [Chart.js](https://www.chartjs.org/) para os gráficos, [Tesseract.js](https://tesseract.projectnaptha.com/) para ler prints, bandeiras do [flagcdn](https://flagcdn.com). Tema claro/escuro e layout responsivo (celular, tablet e desktop).
