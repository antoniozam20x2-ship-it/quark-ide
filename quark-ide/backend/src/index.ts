import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import chatRouter from './routes/chat.js';
import warroomRouter from './routes/warroom.js';
import searchRouter from './routes/search.js';
import memoryRouter from './routes/memory.js';
import { getCosts } from './services/costTracker.js';
import { initDb } from './services/db.js';
import { seedOnce } from './services/rufloMemory.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'quark-ide-backend',
  });
});

app.use('/api/chat', chatRouter);
app.use('/api/warroom', warroomRouter);
app.use('/api/warroom/search', searchRouter);
app.use('/api/memory', memoryRouter);

app.get('/api/costs', (_req, res) => {
  res.json(getCosts());
});


if (process.env.DATABASE_URL) {
  initDb()
    .then(() => seedOnce())
    .catch((err) => console.error('⚠ DB init failed:', err));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚛ QUARK backend running on port ${PORT}`);
});
