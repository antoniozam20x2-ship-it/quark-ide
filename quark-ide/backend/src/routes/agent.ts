import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { getFileTree } from '../services/github.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function callGeminiWithRetry(fn: () => Promise<any>, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is503 = err?.status === 503 || err?.message?.includes('503') || err?.message?.includes('UNAVAILABLE');
      if (is503 && attempt < maxRetries) {
        console.log(`Gemini 503 — reintento ${attempt}/${maxRetries} en ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

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

RESPONDE ÚNICAMENTE CON ESTE JSON (sin markdown, sin backticks, sin texto extra):
{
  "files": [
    {"path": "src/components/App.tsx", "content": "código TypeScript completo aquí"},
    {"path": "src/hooks/useData.ts", "content": "código TypeScript completo aquí"}
  ],
  "commitMessage": "feat: descripción del cambio",
  "mainComponent": "src/components/App.tsx"
}

REGLAS PARA files[].content:
- TypeScript completo y funcional
- Incluir todos los imports necesarios
- Inline styles (no Tailwind)
- Sin librerías externas (solo react)`;

    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\nTAREA: ' + prompt }] }],
      config: { maxOutputTokens: 8192 },
    }));

    const raw = (response.text ?? '').trim();

    console.log('[Agent] Raw length:', raw.length);
    console.log('[Agent] Raw preview:', raw.slice(0, 300));

    let parsed: {
      files: { path: string; content: string }[];
      commitMessage: string;
      mainComponent: string;
      previewCode?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Gemini no devolvió JSON válido');
      parsed = JSON.parse(match[0]);
    }

    console.log('[Agent] Parsed files count:', parsed?.files?.length);

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
      mainContent: mainFile?.content ?? '',
      repo,
      branch,
    });

    // Flush antes de cerrar — da tiempo al cliente de recibir 'done'
    await new Promise((resolve) => setTimeout(resolve, 100));
    res.end();
  } catch (err) {
    send('error', { text: err instanceof Error ? err.message : String(err) });
    res.end();
  }
});

const GENERATE_HTML_SYSTEM_PROMPT = `You are an elite UI engineer and visual designer. Your job is to generate a SINGLE complete HTML file with embedded CSS and JavaScript that implements the requested UI with exceptional visual quality.

STRICT RULES:
1. Return ONLY raw HTML. No markdown, no explanation, no code fences. Start with <!DOCTYPE html>.
2. All CSS must be inside a <style> tag in <head>.
3. All JavaScript must be inside a <script> tag before </body>.
4. No external CDN links. Use only vanilla HTML/CSS/JS.
5. Make it visually stunning. Use the exact colors, typography, and layout described in the brief.
6. Include real placeholder content: product names, prices, descriptions — all invented but coherent.
7. The design must be fully responsive and work inside an iframe at 390px width (mobile-first).
8. Implement ALL interactions described: hover effects, cart updates, modals, animations.
9. Color palette: respect what the brief specifies. If cyberpunk: use #0a0a0a background, neon green #00ff88 accents, monospace fonts.
10. DO NOT generate a skeleton. Generate a COMPLETE, production-quality UI.`;

function extractHtml(raw: string): string {
  const fenceMatch = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const trimmed = raw.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return trimmed;

  const doctypeStart = trimmed.indexOf('<!DOCTYPE');
  if (doctypeStart !== -1) return trimmed.slice(doctypeStart);

  const htmlTagStart = trimmed.indexOf('<html');
  if (htmlTagStart !== -1) return trimmed.slice(htmlTagStart);

  return trimmed;
}

router.post('/generate-html', async (req, res) => {
  const { prompt, projectName, code, files } = req.body as {
    prompt?: string;
    projectName?: string;
    code?: string;
    files?: { path: string; content: string }[];
  };

  // Path A: convierte TSX/código del Agent a HTML standalone con Gemini
  if (code) {
    try {
      const filesContext = files?.length
        ? `\n\nArchivos del proyecto:\n${JSON.stringify(files, null, 2)}`
        : '';

      const geminiPrompt = `Convierte este componente React/TSX a HTML puro standalone (sin imports, sin build step, usando CDN de React desde unpkg).${filesContext}\n\nComponente principal:\n${code}\n\nResponde SOLO con el HTML completo, sin markdown ni backticks. Empieza con <!DOCTYPE html>.`;

      const response = await callGeminiWithRetry(() => ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: geminiPrompt }] }],
        config: { maxOutputTokens: 8192 },
      }));

      const rawHtml = (response.text ?? '').trim();
      if (!rawHtml) throw new Error('Gemini no devolvió contenido');
      const cleanHtml = extractHtml(rawHtml);
      return res.json({ html: cleanHtml, success: true });
    } catch (err) {
      console.error('[generate-html/gemini] error:', err);
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Path B: genera HTML desde design prompt con Claude (OpenRouter)
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt o code requerido' });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://quark-ide.railway.app',
        'X-Title': 'QUARK IDE',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          { role: 'system', content: GENERATE_HTML_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await response.json() as any;
    if (!response.ok) throw new Error(data?.error?.message ?? `OpenRouter ${response.status}`);

    const rawHtml = data.choices?.[0]?.message?.content ?? '';
    if (!rawHtml) throw new Error('OpenRouter no devolvió contenido');
    const cleanHtml = extractHtml(rawHtml);

    res.json({ html: cleanHtml, success: true });
  } catch (err) {
    console.error('[generate-html] error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
