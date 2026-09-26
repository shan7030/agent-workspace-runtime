import cors from 'cors';
import express from 'express';
import controlPlaneRouter from './routes/controlPlane.js';
import openaiAgentsRouter from './routes/openaiAgents.js';

export default function createOpenAIAgentsApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/', (req, res) => {
    res.json({
      message: 'OpenAI Agents API experiment backend',
      routes: {
        status: '/api/status',
        agents: '/api/agents',
        sessions: '/api/sessions',
        controlPlane: '/api/control-plane',
      },
    });
  });

  app.use('/api/control-plane', controlPlaneRouter);
  app.use('/api', openaiAgentsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || err.statusCode || 500).json({
      error: err.message || 'Internal server error',
      details: err.error || err.body,
    });
  });

  return app;
}
