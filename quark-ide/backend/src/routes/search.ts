import { Router, Request, Response } from 'express';
import { generateContent } from '../services/gemini.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { query } = req.body as { query: string };

  const systemPrompt = `You are a technical research assistant. The user is searching for development-related information. Provide a comprehensive, well-structured answer with code examples where relevant. Cite best practices and include practical implementation tips. Format your response with clear sections and code blocks where appropriate.`;

  try {
    const result = await generateContent(query, systemPrompt, 2048);
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

export default router;
