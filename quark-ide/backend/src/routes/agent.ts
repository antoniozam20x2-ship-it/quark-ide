import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { getFileTree, getFileContent } from '../services/github.js';

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

async function repairWithClaude(rawResponse: string, originalPrompt: string): Promise<any> {
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
      max_tokens: 8192,
      messages: [
        {
          role: 'system',
          content: `Eres un agente de reparación de JSON.
Recibes una respuesta malformada de Gemini y debes devolver JSON válido.
REGLAS:
- Devuelve SOLO el JSON, sin markdown ni explicaciones
- El JSON debe tener exactamente: { "files": [{"path": string, "content": string}], "commitMessage": string, "mainComponent": string }
- En el campo content, escapa correctamente: comillas → \\" , saltos de línea → \\n, backticks → \`
- Si el contenido tiene SVG o HTML dentro del TSX, escápalo correctamente como string`,
        },
        {
          role: 'user',
          content: `Prompt original: ${originalPrompt}\n\nRespuesta rota de Gemini:\n${rawResponse.slice(0, 6000)}\n\nRepara el JSON y devuélvelo válido.`,
        },
      ],
    }),
  });
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content ?? '';
  return JSON.parse(text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
}

// ── Read intent detection ────────────────────────────────────────────────────
const READ_KEYWORDS  = /\b(lee|leer|muéstrame|muestra|busca|buscar|encuentra|ver|dime|qué tiene|qué hay|analiza|analizar|diagnóstico|diagnóstica|revisa|revisar|explica|explicar|describe|describir|inspecciona|inspeccionar|abre|abrir|lista|listar|qué hace|cómo está|cómo funciona|show me|read|find|look at)\b/i;
const GEN_KEYWORDS   = /\b(genera|generar|crea|crear|escribe|escribir|implementa|implementar|añade|añadir|agrega|agregar|cambia|cambiar|modifica|modificar|fix|arregla|arreglar|refactoriza|refactorizar|construye|construir|desarrolla|desarrollar|actualiza|actualizar|add|create|write|implement|modify|change|build)\b/i;

function detectReadIntent(prompt: string): boolean {
  const hasRead = READ_KEYWORDS.test(prompt);
  const hasGen  = GEN_KEYWORDS.test(prompt);
  // Read intent only if has read keywords AND no explicit generation keywords
  return hasRead && !hasGen;
}

// Ask Gemini to pick the most relevant file paths from the tree given the prompt
async function identifyFilesToRead(
  prompt: string,
  filePaths: string,
): Promise<string[]> {
  const identifyPrompt = `Dado este prompt del usuario y esta lista de archivos de un repo, devuelve un JSON array con los paths de los archivos más relevantes para responder al prompt. Máximo 5 archivos. Solo paths que existen en la lista.

PROMPT: ${prompt}

ARCHIVOS DISPONIBLES:
${filePaths}

Responde SOLO con un JSON array de strings, sin markdown ni explicaciones. Ejemplo: ["src/server.ts","src/db.ts"]`;

  const resp = await callGeminiWithRetry(() => ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: [{ role: 'user', parts: [{ text: identifyPrompt }] }],
    config: { maxOutputTokens: 512 },
  }));

  const raw = (resp.text ?? '').trim()
    .replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  try {
    const paths = JSON.parse(raw) as string[];
    return Array.isArray(paths) ? paths.slice(0, 5) : [];
  } catch {
    // Fallback: extract anything that looks like a file path
    const matches = raw.match(/"([^"]+\.[a-z]{1,5})"/g) ?? [];
    return matches.map((m: string) => m.replace(/"/g, '')).slice(0, 5);
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
    // Step 1: file tree (always needed)
    send('action', { text: '🔍 Leyendo estructura del repo...' });
    const tree = await getFileTree(repo, branch);
    const filePaths = tree
      .filter((f) => f.type === 'blob')
      .map((f) => f.path)
      .slice(0, 80)
      .join('\n');

    // ── READ PATH — no Gemini generation, just fetch real file content ────────
    if (detectReadIntent(prompt)) {
      send('action', { text: '📖 Modo lectura — identificando archivos relevantes...' });

      const pathsToRead = await identifyFilesToRead(prompt, filePaths);

      if (!pathsToRead.length) {
        send('action', { text: '⚠️ No se encontraron archivos relevantes para ese prompt.' });
        send('done', { files: [], commitMessage: '', mainComponent: '', mainContent: '', repo, branch });
        await new Promise((r) => setTimeout(r, 100));
        res.end();
        return;
      }

      send('action', { text: `📂 Leyendo ${pathsToRead.length} archivo(s) de GitHub...` });

      const readFiles: { path: string; content: string }[] = [];

      for (const filePath of pathsToRead) {
        try {
          send('file', { path: filePath });
          const content = await getFileContent(filePath, repo);
          readFiles.push({ path: filePath, content });
          console.log(`[Agent/Read] ✅ ${filePath} (${content.length} chars)`);
        } catch (e: any) {
          console.warn(`[Agent/Read] ⚠️ Could not read ${filePath}:`, e.message);
          send('action', { text: `⚠️ No se pudo leer: ${filePath}` });
        }
      }

      // done with real file content — no commitMessage (read-only)
      send('done', {
        files:         readFiles,
        commitMessage: '',
        mainComponent: readFiles[0]?.path ?? '',
        mainContent:   readFiles[0]?.content ?? '',
        repo,
        branch,
      });

      await new Promise((r) => setTimeout(r, 100));
      res.end();
      return;
    }

    // ── GENERATION PATH — Gemini generates new/modified files ────────────────
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
- Sin librerías externas (solo react)

CRÍTICO: El JSON debe usar SOLO comillas dobles.
NUNCA uses comillas simples en property names ni values.
NUNCA incluyas comentarios dentro del JSON.
El campo content de cada archivo debe ser un string JSON válido con caracteres escapados correctamente.`;

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
    };
    try {
      // Intento 1: JSON directo
      parsed = JSON.parse(raw);
    } catch {
      try {
        // Intento 2: limpiar backticks y markdown
        const cleaned = raw
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/gi, '')
          .trim();
        parsed = JSON.parse(cleaned);
      } catch {
        try {
          // Intento 3: extraer el primer objeto JSON que contenga "files"
          const match = raw.match(/\{[\s\S]*"files"[\s\S]*\}/);
          if (match) {
            parsed = JSON.parse(match[0]);
          } else {
            throw new Error('no match');
          }
        } catch {
          // Último recurso — Claude repara el JSON roto
          send('action', { text: '🔧 Reparando respuesta con Claude...' });
          parsed = await repairWithClaude(raw, prompt);
        }
      }
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
