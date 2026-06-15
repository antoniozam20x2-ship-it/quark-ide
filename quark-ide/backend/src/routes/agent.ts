import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { getFileTree } from '../services/github.js';

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

RESPONDE ÚNICAMENTE CON ESTE JSON (sin markdown, sin backticks, sin texto extra):
{
  "files": [
    {"path": "src/components/App.tsx", "content": "código TypeScript completo aquí"},
    {"path": "src/hooks/useData.ts", "content": "código TypeScript completo aquí"}
  ],
  "commitMessage": "feat: descripción del cambio",
  "mainComponent": "src/components/App.tsx",
  "previewCode": "función React en JavaScript puro aquí, sin imports, sin tipos TypeScript, sin export, usando React.useState en lugar de useState"
}

REGLAS PARA files[].content:
- TypeScript completo y funcional
- Incluir todos los imports necesarios
- Inline styles (no Tailwind)
- Sin librerías externas (solo react)

REGLAS PARA previewCode (MUY IMPORTANTE):
- Sin imports de ningún tipo
- Sin tipos TypeScript (:string, :number, :boolean, React.FC, etc.)
- Sin generics (<string>, <number>, etc.)
- Sin export default ni export const
- Usar React.useState() no useState()
- Usar React.useEffect() no useEffect()
- Solo JSX y JavaScript puro
- La función principal debe llamarse App
- Ejemplo válido: function App() { const [x, setX] = React.useState(0); return <div>{x}</div>; }`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\nTAREA: ' + prompt }] }],
      config: { maxOutputTokens: 8192 },
    });

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
    console.log('[Agent] previewCode length:', parsed?.previewCode?.length);

    const { files, commitMessage, mainComponent, previewCode } = parsed;

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
      // previewCode = JS puro listo para react-live
      // fallback al .tsx si Gemini no generó previewCode
      mainContent: previewCode ?? mainFile?.content,
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

export default router;
