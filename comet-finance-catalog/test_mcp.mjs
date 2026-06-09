import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function test() {
  console.log("Conectando ao servidor: http://localhost:3001/sse");
  const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    console.log("✅ Conectado com sucesso!");

    console.log("Executando ferramenta: calculate_realtime_cmv (200g massa, 100g molho)...");
    const result = await client.callTool({
      name: "calculate_realtime_cmv",
      arguments: {
        dishName: "Porção Teste (200g Massa + 100g Molho)",
        pastaWeightGrams: 200,
        sauceWeightGrams: 100,
        packagingCost: 0.35, // Custo médio de embalagem
        sellingPrice: 8.90 // Preço de venda simulado
      }
    });
    
    console.log("📊 Resultado retornado pelo MCP:");
    console.log(result.content[0].text);
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro na execução:", err);
    process.exit(1);
  }
}

test();
