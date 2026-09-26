export const openaiAgentsConfig = {
  port: Number(process.env.PORT || 3200),
  defaultModel: process.env.OPENAI_AGENTS_MODEL || 'gpt-5.6-luna',
};

export function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}
