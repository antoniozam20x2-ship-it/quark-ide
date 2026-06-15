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

  designer: `Eres un diseñador UI/UX senior. Dado un brief de producto, genera ÚNICAMENTE un HTML completo y funcional que sea un prototipo visual de alta fidelidad de la interfaz.

REGLAS ESTRICTAS:
- Devuelve SOLO el HTML — sin explicaciones, sin texto antes ni después
- Empieza con <!DOCTYPE html> y termina con </html>
- Inline styles en todo — sin CSS externo, sin clases Tailwind
- Fondo oscuro por defecto (#0A0A0F o similar)
- Tipografía: system-ui o monospace
- Debe verse como un producto real, no un wireframe
- Incluye datos de ejemplo realistas (nombres, precios, imágenes placeholder con background-color)
- Máximo 150 líneas
- Interactividad básica con JavaScript inline si aplica (hover states, clicks)
- Sin frameworks externos — solo HTML + CSS inline + JS vanilla`,

  engineer: `Eres un engineer senior especialista en React y TypeScript.
Dado un brief de producto con análisis de arquitectura y diseño, genera ÚNICAMENTE un prompt técnico detallado para un agente de código.

El prompt debe especificar:
1. Qué componentes crear con nombres exactos
2. Colores exactos en hex del diseño (extráelos del brief del designer)
3. Estructura de datos y estado necesario
4. Interacciones y animaciones específicas
5. Que use inline styles, solo React, sin librerías externas

FORMATO DE SALIDA — devuelve SOLO esto, sin explicaciones:
"Crea un componente React TypeScript llamado [Nombre] que implemente [descripción detallada].
Colores: fondo [hex], texto [hex], acentos [hex].
Debe incluir: [lista de features específicas].
Usa inline styles, React.useState, React.useEffect.
Sin librerías externas. Completamente funcional e interactivo."

Sustituye los corchetes con detalles específicos del brief. Una sola vez, sin repetir.`,

  qa: `Eres un QA engineer senior. Dado un brief de producto, define en máximo 6 líneas:
- 3 criterios de éxito verificables
- 2 casos de error a manejar
- 1 edge case crítico
Sé específico y medible.`
}

router.post('/analyze', async (req, res) => {
  try {
    const { brief, role, architectResult, designerResult } = req.body
    if (!brief || !role) return res.status(400).json({ error: 'brief y role requeridos' })

    const systemPrompt = SYSTEM_PROMPTS[role]
    if (!systemPrompt) return res.status(400).json({ error: 'role inválido' })

    // Engineer usa Claude via OpenRouter — entiende mejor el contexto visual y genera prompts más precisos
    if (role === 'engineer') {
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
          max_tokens: 500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `BRIEF: ${brief}\n\nARQUITECTURA: ${architectResult ?? ''}\n\nDISEÑO: ${designerResult ?? ''}` },
          ],
        }),
      })
      const data = await response.json() as any
      if (!response.ok) throw new Error(data?.error?.message ?? `OpenRouter ${response.status}`)
      const text = data.choices?.[0]?.message?.content ?? ''
      return res.json({ result: text, role })
    }

    // Resto de roles usan Gemini
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
