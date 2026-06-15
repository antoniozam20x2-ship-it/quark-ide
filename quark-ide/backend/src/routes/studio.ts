import { Router } from 'express'
import { GoogleGenAI } from '@google/genai'

const router = Router()
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

async function callGeminiWithRetry(fn: () => Promise<any>, maxRetries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const is503 = err?.status === 503 || err?.message?.includes('503') || err?.message?.includes('UNAVAILABLE')
      if (is503 && attempt < maxRetries) {
        console.log(`Gemini 503 — reintento ${attempt}/${maxRetries} en ${delayMs}ms`)
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw err
    }
  }
}

const SYSTEM_PROMPTS: Record<string, string> = {
  architect: `Eres un arquitecto de software senior. Dado un brief de producto, define en máximo 8 líneas:
- Estructura de archivos necesarios (máximo 3 archivos)
- Componentes principales y su responsabilidad
- Props y estado necesario
- Endpoints de API si aplica
Sé específico y conciso. Sin explicaciones largas.`,

  designer: `Eres un diseñador UI/UX senior. Dado un brief de producto, define en máximo 8 líneas:
- Paleta de colores exacta (hex codes)
- Tipografía (font-family, tamaños)
- Espaciado y layout (grid, padding)
- Estilo visual (dark/light, bordes, sombras)
- UX flow principal
Sé específico con valores exactos.`,

  engineer: `Eres un engineer senior especialista en React y JavaScript puro.
Dado un brief de producto con análisis de arquitectura y diseño, genera ÚNICAMENTE el siguiente texto — nada más, sin explicaciones:

Crea una función React llamada App en JavaScript puro (sin TypeScript, sin imports, sin export) que implemente: [descripción específica del componente].
Usa React.useState y React.useEffect. Inline styles con estos colores exactos: [colores del diseño].
El componente debe ser interactivo y funcional. Máximo 60 líneas.

Sustituye los corchetes con los detalles específicos del brief. Devuelve SOLO el prompt, una sola vez, sin repetir, sin encabezados, sin numeración.`,

  qa: `Eres un QA engineer senior. Dado un brief de producto, define en máximo 6 líneas:
- 3 criterios de éxito verificables
- 2 casos de error a manejar
- 1 edge case crítico
Sé específico y medible.`
}

router.post('/analyze', async (req, res) => {
  try {
    const { brief, role } = req.body
    if (!brief || !role) return res.status(400).json({ error: 'brief y role requeridos' })

    const systemPrompt = SYSTEM_PROMPTS[role]
    if (!systemPrompt) return res.status(400).json({ error: 'role inválido' })

    const result = await callGeminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-2.0-flash-lite',
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nBRIEF: ${brief}` }] }],
    }))
    const text = result.text ?? ''

    res.json({ result: text, role })
  } catch (err) {
    console.error('studio/analyze error:', err)
    res.status(500).json({ error: 'Error en análisis' })
  }
})

export default router
