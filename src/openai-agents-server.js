import { openaiAgentsConfig } from './openai-agents/config.js';
import createOpenAIAgentsApp from './openaiAgentsApp.js';

const app = createOpenAIAgentsApp();

app.listen(openaiAgentsConfig.port, () => {
  console.log(`OpenAI Agents API backend running on http://localhost:${openaiAgentsConfig.port}`);
  console.log(`Default model: ${openaiAgentsConfig.defaultModel}`);
});

