import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import chatRouter from './routes/chat.js';
import warroomRouter from './routes/warroom.js';
import searchRouter from './routes/search.js';
import memoryRouter from './routes/memory.js';
import { getCosts } from './services/costTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

app.use('/api/chat', chatRouter);
app.use('/api/warroom', warroomRouter);
app.use('/api/warroom/search', searchRouter);
app.use('/api/memory', memoryRouter);

app.get('/api/costs', (_req, res) => {
  res.json(getCosts());
});

const distPath = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚛ QUARK backend running on port ${PORT}`);
});
