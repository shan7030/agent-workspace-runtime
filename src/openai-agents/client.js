import OpenAI from 'openai';
import { hasOpenAIKey } from './config.js';

let client;

export class OpenAIAgentsConfigError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set. Export it before calling the OpenAI Agents API.');
    this.name = 'OpenAIAgentsConfigError';
    this.status = 503;
  }
}

export function getOpenAIClient() {
  if (!hasOpenAIKey()) {
    throw new OpenAIAgentsConfigError();
  }

  if (!client) {
    client = new OpenAI();
  }

  return client;
}

export async function pageToArray(pagePromise) {
  const page = await pagePromise;

  if (Array.isArray(page?.data)) {
    return {
      data: page.data,
      first_id: page.first_id,
      last_id: page.last_id,
      has_more: page.has_more,
    };
  }

  const data = [];
  for await (const item of page) {
    data.push(item);
  }

  return { data };
}

