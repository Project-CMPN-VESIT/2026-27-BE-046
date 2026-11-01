import { app } from './app';
import { connectDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './utils/logger';
import { isLlmConfigured } from './services/llm/llmService';

async function start(): Promise<void> {
  await connectDatabase();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'JasmineGPT API started');
    logger.info('RAG sidecar expected at: %s', env.RAG_SIDECAR_URL);
    if (!isLlmConfigured()) {
      logger.warn({ provider: env.LLM_PROVIDER }, 'Configured LLM API key not set — LLM synthesis disabled. Raw evidence facts will be returned.');
    }
  });
}

start().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exitCode = 1;
});
