import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { getFileTree, commitMultipleFiles } from '../services/github.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

router.post('/generate', async (req, res) => {
  const { prompt, repo, branch = 'main', projectName } = req.body as {
    prompt?: string;
    repo?: string;
    branch?: string;
    projectName?: string;
  };

  if (!prompt || !repo) {
    res.status(400).json({ error: 'prompt and repo are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  try {
    // Step 1: file tree
    send('action', { text: '🔍 Leyendo estructura del repo...' });
    const tree = await getFileTree(repo, branch);
    const filePaths = tree
      .filter((f) => f.type === 'blob')
      .map((f) => f.path)
      .slice(0, 50)
      .join('\n');

    // Step 2: Gemini genera archivos
    send('action', { text: '🧠 Generando archivos con Gemini...' });

    const systemPrompt = `Eres un agente de código experto.
Tu tarea es generar archivos de código para un proyecto.

Repo activo: ${projectName ?? repo} (${repo})
Archivos existentes en el repo:
${filePaths}

INSTRUCCIONES CRÍTICAS:
- Responde SOLO con JSON válido, sin markdown, sin backticks
- El JSON debe tener este formato exacto:
{
  "files": [
    {"path": "src/components/App.tsx", "content": "código aquí"},
    {"path": "src/hooks/useData.ts", "content": "código aquí"}
  ],
  "commitMessage": "feat: descripción del cambio",
  "mainComponent": "src/components/App.tsx"
}
- mainComponent es el archivo TSX principal para el preview
- Genera código real y funcional, no placeholders
- Usa TypeScript, React, inline styles (no Tailwind)
- Sin imports de librerías externas (solo react)`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\nTAREA: ' + prompt }] }],
      config: { maxOutputTokens: 8192 },
    });

    const raw = (response.text ?? '').trim();

    console.log('[Agent] Raw length:', raw.length);
    console.log('[Agent] Raw preview:', raw.slice(0, 300));

    let parsed: { files: { path: string; content: string }[]; commitMessage: string; mainComponent: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Gemini no devolvió JSON válido');
      parsed = JSON.parse(match[0]);
    }

    console.log('[Agent] Parsed files count:', parsed?.files?.length);
    console.log('[Agent] Main content length:', parsed?.files?.[0]?.content?.length);

    const { files, commitMessage, mainComponent } = parsed;

    // Step 3: reportar archivos generados
    send('action', { text: `✏️ ${files.length} archivos generados:` });
    for (const f of files) {
      send('file', { path: f.path });
    }

    // Step 4: devolver resultado (sin commit aún)
    const mainFile =
      files.find((f) => f.path === mainComponent) ??
      files.find((f) => f.path.endsWith('.tsx')) ??
      files[0];

    send('done', {
      files,
      commitMessage,
      mainComponent: mainFile?.path,
      mainContent:   mainFile?.content,
      repo,
      branch,
    });

    res.end();
  } catch (err) {
    send('error', { text: err instanceof Error ? err.message : String(err) });
    res.end();
  }
});

export default router;
