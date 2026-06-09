import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
// ==========================================
// Configuração de Variáveis de Ambiente
// ==========================================
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SHIPDAY_API_KEY = process.env.SHIPDAY_API_KEY || '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Aviso: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.");
}
if (!SHIPDAY_API_KEY) {
    console.warn("Aviso: SHIPDAY_API_KEY não configurada.");
}
// ==========================================
// Clientes Externos (Supabase e ShipDay)
// ==========================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const shipdayApi = axios.create({
    baseURL: 'https://api.shipday.com',
    headers: {
        'Authorization': `Basic ${SHIPDAY_API_KEY}`,
        'Content-Type': 'application/json'
    }
});
// ==========================================
// Inicialização do Servidor MCP
// ==========================================
const server = new McpServer({
    name: 'comet-ops-logistics',
    version: '1.0.0'
});
// ==========================================
// Ferramentas do Servidor (Tools)
// ==========================================
// 1. fetch_active_kanban_states
server.tool('fetch_active_kanban_states', 'Lê o estado atual do painel do Supabase, identificando pedidos em preparação e aguardando entrega.', {}, async () => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .in('status', ['Em Preparação', 'Esperando Entrega']);
        if (error)
            throw error;
        return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao buscar kanban states: ${error.message}` }],
            isError: true,
        };
    }
});
// 2. query_fleet_gps_telemetry
server.tool('query_fleet_gps_telemetry', 'Chama via Axios o endpoint GET https://api.shipday.com/carriers para obter a telemetria GPS da frota ativa.', {}, async () => {
    try {
        const response = await shipdayApi.get('/carriers');
        return {
            content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao consultar frota ShipDay: ${error.message}` }],
            isError: true,
        };
    }
});
// 3. assign_shipday_driver
server.tool('assign_shipday_driver', 'Envia um POST para o endpoint /on-demand/assign do ShipDay para atribuir um entregador a um pedido.', {
    orderId: z.string().describe('ID do pedido no ShipDay (orderId)'),
    carrierId: z.number().describe('ID do entregador/carrier no ShipDay')
}, async ({ orderId, carrierId }) => {
    try {
        const response = await shipdayApi.post(`/on-demand/assign/${orderId}/${carrierId}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao atribuir motorista no ShipDay: ${error?.response?.data?.message || error.message}` }],
            isError: true,
        };
    }
});
// 4. update_delivery_eta
server.tool('update_delivery_eta', 'Atualiza a tabela orders no Supabase para recalibrar o ETA do Live Tracking do cliente.', {
    orderId: z.string().describe('UUID do pedido no Supabase'),
    etaMinutes: z.number().describe('Novo tempo estimado de entrega em minutos adicionais ou absolutos')
}, async ({ orderId, etaMinutes }) => {
    try {
        // Cria uma data futura baseada nos minutos adicionais informados
        const newEtaDate = new Date(Date.now() + etaMinutes * 60000).toISOString();
        const { data, error } = await supabase
            .from('orders')
            .update({ eta: newEtaDate })
            .eq('id', orderId)
            .select();
        if (error)
            throw error;
        return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao atualizar ETA no Supabase: ${error.message}` }],
            isError: true,
        };
    }
});
// 5. predict_oven_queue (Extra - Previsto na documentação técnica)
server.tool('predict_oven_queue', 'Previsor de estrangulamento dos fornos de velocidade, com base no número de itens em fila e fornos ativos.', {
    items_queue: z.number().describe('Número total de itens atualmente na fila de preparação'),
    active_ovens: z.number().describe('Número de fornos atualmente operacionais e ativos')
}, async ({ items_queue, active_ovens }) => {
    try {
        // O ciclo híbrido dura cerca de 3 minutos por tabuleiro/forno
        const cicloMinutos = 3;
        const turnosNecessarios = Math.ceil(items_queue / active_ovens);
        const tempoEsperaAcumulado = turnosNecessarios * cicloMinutos;
        const bottleneckAlerta = tempoEsperaAcumulado > 15;
        const resultado = {
            items_queue,
            active_ovens,
            tempo_estimado_fila_minutos: tempoEsperaAcumulado,
            alerta_gargalo: bottleneckAlerta,
            recomendacao: bottleneckAlerta
                ? "Saturação de fornos detectada. Recomendado suspender pedidos imediatos e ativar agendamento obrigatório."
                : "Fila térmica sob controle."
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }]
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: `Erro ao prever fila de fornos: ${error.message}` }],
            isError: true,
        };
    }
});
// ==========================================
// Configuração do Servidor Express e SSE
// ==========================================
const app = express();
// Instância de transporte global para Server-Sent Events (SSE)
let transport;
// Endpoint para inicializar a conexão SSE do cliente MCP
app.get('/sse', async (req, res) => {
    try {
        transport = new SSEServerTransport('/message', res);
        await server.connect(transport);
        console.log("Novo cliente MCP conectado via SSE");
    }
    catch (err) {
        console.error("Erro ao conectar transporte SSE:", err);
        res.status(500).end();
    }
});
// Endpoint para recebimento de mensagens JSON-RPC 2.0 (POST)
app.post('/message', express.json(), async (req, res) => {
    if (!transport) {
        return res.status(500).send('Transporte SSE não inicializado. Conecte-se em /sse primeiro.');
    }
    try {
        await transport.handlePostMessage(req, res);
    }
    catch (err) {
        console.error("Erro ao processar mensagem POST:", err);
        res.status(500).end();
    }
});
// Health check para o Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'comet-ops-logistics' });
});
// Inicialização
app.listen(PORT, () => {
    console.log(`[comet-ops-logistics] MCP Server ativo na porta ${PORT}`);
    console.log(`- SSE Endpoint disponível em: http://localhost:${PORT}/sse`);
    console.log(`- POST Endpoint disponível em: http://localhost:${PORT}/message`);
});
