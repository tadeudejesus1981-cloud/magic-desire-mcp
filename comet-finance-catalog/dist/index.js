import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
// ==========================================
// Configuração de Variáveis de Ambiente
// ==========================================
const PORT = process.env.PORT || 3001; // Usando 3001 para não conflitar caso o outro esteja no 3000
// ==========================================
// Inicialização do Servidor MCP
// ==========================================
const server = new McpServer({
    name: 'comet-finance-catalog',
    version: '1.0.0'
});
// ==========================================
// Ferramentas do Servidor (Tools)
// ==========================================
// 1. calculate_realtime_cmv
server.tool('calculate_realtime_cmv', 'Calcula o Custo de Mercadorias Vendidas (CMV) exato e a margem bruta de um prato.', {
    dishName: z.string().describe('Nome do prato'),
    pastaWeightGrams: z.number().describe('Peso da massa em gramas'),
    sauceWeightGrams: z.number().describe('Peso do molho em gramas'),
    packagingCost: z.number().describe('Custo da tara da embalagem em euros'),
    sellingPrice: z.number().describe('Preço de Venda ao Público (PVP) em euros')
}, async ({ dishName, pastaWeightGrams, sauceWeightGrams, packagingCost, sellingPrice }) => {
    try {
        // Valores de referência hipotéticos para cálculo (custo por grama)
        const costPerGramPasta = 0.005; // Ex: 50 cêntimos por 100g
        const costPerGramSauce = 0.008; // Ex: 80 cêntimos por 100g
        const pastaCost = pastaWeightGrams * costPerGramPasta;
        const sauceCost = sauceWeightGrams * costPerGramSauce;
        const totalCmv = pastaCost + sauceCost + packagingCost;
        const grossMargin = sellingPrice - totalCmv;
        const grossMarginPercentage = (grossMargin / sellingPrice) * 100;
        const targetMarginMin = 71;
        const targetMarginMax = 74;
        const isOptimized = grossMarginPercentage >= targetMarginMin && grossMarginPercentage <= targetMarginMax;
        const result = {
            dishName,
            cmv_euros: Number(totalCmv.toFixed(2)),
            gross_margin_euros: Number(grossMargin.toFixed(2)),
            gross_margin_percentage: Number(grossMarginPercentage.toFixed(2)),
            status: isOptimized ? 'ALVO_ALCANCADO' : 'FORA_DA_META',
            observacao: isOptimized
                ? 'Margem dentro da janela algorítmica de 71% a 74%.'
                : 'Requer ajuste de preços no TPV Admin ou reavaliação de gramagem.'
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao calcular CMV: ${error.message}` }],
            isError: true,
        };
    }
});
// 2. audit_thermal_limits
server.tool('audit_thermal_limits', 'Audita a segurança alimentar e conformidade térmica da embalagem estucada de 360imprimir (Limite 100°C).', {
    order_id: z.string().describe('Identificador do pedido'),
    item_temperatures: z.array(z.number()).describe('Matriz de temperaturas alcançadas no forno de impacto em °C')
}, async ({ order_id, item_temperatures }) => {
    try {
        const maxTemp = Math.max(...item_temperatures, 0);
        const limitExceeded = maxTemp > 100;
        const result = {
            order_id,
            max_temperature_detected_celsius: maxTemp,
            limit_celsius: 100,
            thermal_compliance: !limitExceeded,
            action_required: limitExceeded
                ? 'CRÍTICO: Risco de derretimento da película de PE. OBRIGATÓRIO separar itens com temperatura excessiva para potes de Polipropileno (PP) de 3oz.'
                : 'Temperatura segura. Pode utilizar a embalagem primária de PE.'
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro na auditoria térmica: ${error.message}` }],
            isError: true,
        };
    }
});
// 3. audit_loss_leader_ratio
server.tool('audit_loss_leader_ratio', 'Analisa a proporção de vendas do Produto Âncora e avalia risco de erosão de lucros.', {
    timeframe_hours: z.number().describe('Período de avaliação em horas'),
    loss_leader_volume: z.number().describe('Quantidade de unidades do prato Produto Âncora vendidas'),
    total_volume: z.number().describe('Volume total de refeições vendidas no período')
}, async ({ timeframe_hours, loss_leader_volume, total_volume }) => {
    try {
        if (total_volume === 0) {
            throw new Error("Volume total não pode ser zero para a análise.");
        }
        const ratio = loss_leader_volume / total_volume;
        const isCannibalizing = ratio > 0.50; // Alerta se passar de 50%
        const result = {
            timeframe_hours,
            loss_leader_volume,
            total_volume,
            ratio_percentage: Number((ratio * 100).toFixed(2)),
            is_cannibalizing: isCannibalizing,
            recommendation: isCannibalizing
                ? 'ALERTA FINANCEIRO: Risco de rentabilidade global devido ao sobreconsumo de Produto Âncora. Sugestão: Esconder o Tamanho S na app D2C ou focar campanhas de remarketing nos tamanhos M/L.'
                : 'Rácio de canibalização sob controle. Lucratividade preservada.'
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro na auditoria de ratio: ${error.message}` }],
            isError: true,
        };
    }
});
// ==========================================
// Configuração do Servidor Express e SSE
// ==========================================
const app = express();
// Instância de transporte para o SSE
let transport;
// Rota SSE para conexão do cliente LLM
app.get('/sse', async (req, res) => {
    try {
        transport = new SSEServerTransport('/message', res);
        await server.connect(transport);
        console.log("Novo cliente conectado via SSE no Finance Catalog");
    }
    catch (err) {
        console.error("Erro ao iniciar transporte SSE:", err);
        res.status(500).end();
    }
});
// Rota POST para receber requisições JSON-RPC 2.0
app.post('/message', express.json(), async (req, res) => {
    if (!transport) {
        return res.status(500).send('Transporte não inicializado.');
    }
    try {
        await transport.handlePostMessage(req, res);
    }
    catch (err) {
        console.error("Erro ao processar mensagem POST:", err);
        res.status(500).end();
    }
});
// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'comet-finance-catalog' });
});
// Inicialização
app.listen(PORT, () => {
    console.log(`[comet-finance-catalog] MCP Server em execução na porta ${PORT}`);
    console.log(`- SSE Endpoint disponível em: http://localhost:${PORT}/sse`);
    console.log(`- POST Endpoint disponível em: http://localhost:${PORT}/message`);
});
