import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ==========================================
// Configuração de Variáveis de Ambiente
// ==========================================
const PORT = process.env.PORT || 3002; // Porta 3002 para o CRM Intelligence
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Aviso: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ==========================================
// Inicialização do Servidor MCP
// ==========================================
const server = new McpServer({
  name: 'comet-crm-intelligence',
  version: '1.0.0'
});

// ==========================================
// Ferramentas do Servidor (Tools)
// ==========================================

server.tool(
  'calculate_funnel_and_roi',
  'Calcula a taxa de conversão do funil de checkout e o ROI puro do Produto Âncora baseado nos event_logs.',
  {
    start_time: z.string().describe('Data de início em formato ISO'),
    end_time: z.string().describe('Data de término em formato ISO'),
    target_product_id: z.string().describe('ID do Produto Âncora (ex: fusilli-s-bolognese)')
  },
  async ({ start_time, end_time, target_product_id }) => {
    try {
      // 1. Cálculo da Fricção de Checkout (Funnel)
      // Como a SDK do Supabase não suporta agregação JSONB nativa avançada diretamente na API REST padrão,
      // buscamos os logs do período para cálculo em memória. Numa base escalável, usaria-se supabase.rpc().
      const { data: funnelData, error: funnelError } = await supabase
        .from('event_logs')
        .select('session_id, event_action')
        .in('event_action', ['add_to_cart', 'payment_success'])
        .gte('timestamp', start_time)
        .lte('timestamp', end_time);

      if (funnelError) throw funnelError;

      const sessionsWithCart = new Set();
      const sessionsWithPayment = new Set();

      funnelData?.forEach(log => {
        if (log.event_action === 'add_to_cart') sessionsWithCart.add(log.session_id);
        if (log.event_action === 'payment_success') sessionsWithPayment.add(log.session_id);
      });

      const uniqueCarts = sessionsWithCart.size;
      const uniquePayments = sessionsWithPayment.size;
      const conversionRate = uniqueCarts > 0 ? (uniquePayments / uniqueCarts) * 100 : 0;

      // 2. Cálculo do ROI puro do Produto Âncora
      const { data: roiData, error: roiError } = await supabase
        .from('event_logs')
        .select('metadata')
        .eq('event_action', 'payment_success')
        .gte('timestamp', start_time)
        .lte('timestamp', end_time);

      if (roiError) throw roiError;

      let targetProductSales = 0;
      let totalRoi = 0;

      roiData?.forEach(log => {
        const metadata = log.metadata as Record<string, any>;
        // Acessa os dados JSONB
        if (metadata && metadata.product_id === target_product_id) {
          targetProductSales++;
          const basePrice = Number(metadata.base_price) || 0;
          const dynamicCmv = Number(metadata.dynamic_cmv) || 0;
          totalRoi += (basePrice - dynamicCmv);
        }
      });

      const result = {
        funnel_metrics: {
          period: { start_time, end_time },
          unique_visitors_add_to_cart: uniqueCarts,
          successful_checkouts: uniquePayments,
          cart_to_checkout_conversion_rate: `${conversionRate.toFixed(2)}%`
        },
        roi_metrics: {
          target_product_id,
          units_sold: targetProductSales,
          gross_profit_roi_euros: Number(totalRoi.toFixed(2))
        },
        recommendation: conversionRate < 45 
          ? "Taxa de conversão sub-ótima. Analisar fricção na página de pagamento."
          : "Conversão saudável. Otimizar tráfego do topo do funil."
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Erro na análise do CRM Intelligence: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ==========================================
// Configuração do Servidor Express e SSE
// ==========================================
const app = express();
let transport: SSEServerTransport;

app.get('/sse', async (req, res) => {
  try {
    transport = new SSEServerTransport('/message', res);
    await server.connect(transport);
    console.log("Novo cliente LLM conectado via SSE no CRM Intelligence");
  } catch (err) {
    console.error("Erro ao iniciar transporte SSE:", err);
    res.status(500).end();
  }
});

app.post('/message', express.json(), async (req, res) => {
  if (!transport) {
    return res.status(500).send('Transporte não inicializado.');
  }
  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("Erro no processamento da mensagem JSON-RPC:", err);
    res.status(500).end();
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'comet-crm-intelligence' });
});

// Inicialização
app.listen(PORT, () => {
  console.log(`[comet-crm-intelligence] MCP Server em execução na porta ${PORT}`);
  console.log(`- SSE Endpoint disponível em: http://localhost:${PORT}/sse`);
  console.log(`- POST Endpoint disponível em: http://localhost:${PORT}/message`);
});
