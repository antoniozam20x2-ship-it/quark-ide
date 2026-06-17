import { Router } from 'express'
import { callAI } from '../lib/aiRouter.js'

const router = Router()

// ── HTML sanitizer ────────────────────────────────────────────────────────────

function sanitizeDesignerHtml(raw: string): string {
  let html = raw.trim()
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = html.indexOf('<!DOCTYPE')
  const end   = html.lastIndexOf('</html>')
  if (start !== -1 && end !== -1) {
    html = html.slice(start, end + '</html>'.length)
  }
  return html
}

// ── System prompts ────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  architect: `Eres un director creativo y arquitecto de producto senior. Dado un brief de producto,
clasifica el tipo de proyecto y define una dirección de diseño concreta y específica
a ESTE brief — nunca un default genérico que usarías para cualquier brief similar.

Devuelve en este formato exacto, máximo 12 líneas:
TIPO: [marketing-site | functional-tool | dashboard | game-2d | media-app]
PALETA: 4-6 colores hex con nombre (ej: "Terracota cálido #C76B4A")
TIPOGRAFÍA: una fuente de display + una de texto, nombres reales de Google Fonts
LAYOUT: una frase describiendo la estructura visual
ELEMENTO FIRMA: el único elemento memorable que distingue esta pieza
ARQUITECTURA: máximo 3 archivos/componentes con responsabilidad, props y estado clave

Reglas:
- Evita por defecto estos tres looks (solo úsalos si el brief los pide explícitamente):
  fondo crema con serif y acento terracota; fondo negro con acento ácido único;
  diseño tipo periódico con reglas finas y columnas densas.
- La paleta y tipografía deben nacer del tema real del brief.
- Sé específico y concreto, sin explicaciones largas.
- Si el brief describe un negocio de experiencia (restaurante, hotel, spa, tienda, café),
  añade al final del output esta línea exacta:
  ELEMENTOS REQUERIDOS: video-hero, menu-con-fotos, seccion-reserva-o-contacto, footer-completo`,

  designer: `Eres un diseñador UI/UX y desarrollador frontend senior de clase mundial. Dado un BRIEF y una DIRECCIÓN CREATIVA, genera un HTML completo, profesional y de alta fidelidad.

Devuelve ÚNICAMENTE el HTML — empieza con <!DOCTYPE html> y termina con </html>. Sin explicaciones, sin markdown.

Usa tu criterio profesional para decidir qué tan complejo debe ser según el brief. Un restaurante merece navbar, hero animado, menú interactivo, reservaciones, galería con lightbox y footer completo. Un juego merece canvas y game loop. Una tienda merece carrito y productos. Sé ambicioso.`,

  qa: `Eres un crítico de diseño senior. Recibes el BRIEF, la DIRECCIÓN CREATIVA y el HTML
generado por el Designer. Evalúa con honestidad:
1. ¿Sigue exactamente la paleta y tipografía indicadas?
2. ¿Tiene jerarquía visual real o se ve genérico/plantilla/todo centrado?
3. ¿El contenido es específico al brief o es relleno genérico?
4. ¿Hay algún bug visible (HTML roto, bloques de markdown sin limpiar, texto sin estilo)?

Si todo está bien, responde EXACTAMENTE: APROBADO
Si algo falla, responde con máximo 4 líneas de instrucciones de revisión específicas
y accionables, empezando con: REVISAR:`,

  engineer: `Eres un engineer senior especialista en React y TypeScript. Recibes el BRIEF, la
DIRECCIÓN CREATIVA, y el HTML aprobado del Designer — es la referencia visual exacta
a replicar, no a reinventar.

Adapta el enfoque según el TIPO de proyecto:
- marketing-site / dashboard / functional-tool → componentes React funcionales,
  useState/useEffect
- game-2d → usa <canvas> y requestAnimationFrame con loop de juego explícito
- media-app → usa Web Audio API o <audio>/<video> según corresponda

FORMATO DE SALIDA — devuelve SOLO esto, sin explicaciones:
"Crea un proyecto React + TypeScript llamado [Nombre].
Replica fielmente este diseño de referencia (no lo reinterpretes): [resumen
estructural del HTML aprobado: secciones, layout, jerarquía].
Paleta exacta: [hex de la dirección creativa].
Tipografía: [fuentes].
Componentes: [nombres exactos, props, estado].
Funcionalidad: [features e interacciones específicas].
Usa inline styles o styled-components, React.useState, React.useEffect.
Sin librerías de UI externas salvo que el TIPO de proyecto lo requiera (canvas API
para juegos, Web Audio API para apps de música).
Completamente funcional e interactivo, fiel al HTML de referencia."`,
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  try {
    const { brief, role, architectResult, designerResult } = req.body as {
      brief: string
      role: string
      architectResult?: string
      designerResult?: string
    }

    if (!brief || !role) return res.status(400).json({ error: 'brief y role requeridos' })

    const systemPrompt = SYSTEM_PROMPTS[role]
    if (!systemPrompt) return res.status(400).json({ error: 'role inválido' })

    // ── Critic (qa): evaluate + optional 1 revision round ─────────────────────
    if (role === 'qa') {
      const criticPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML DEL DESIGNER:\n${designerResult ?? ''}`
      const criticText = await callAI('analyze', criticPrompt, systemPrompt)

      if (criticText.trim().startsWith('REVISAR:')) {
        const revisionPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML ORIGINAL (referencia base, mejóralo sin partir de cero):\n${designerResult ?? ''}\n\nNOTAS DE REVISIÓN (correcciones obligatorias):\n${criticText}`
        const revisedRaw  = await callAI('html', revisionPrompt, SYSTEM_PROMPTS['designer'])
        const revisedHtml = sanitizeDesignerHtml(revisedRaw)
        const useRevised  = revisedHtml.length > (designerResult ?? '').length * 0.5
        return res.json({ result: criticText, role, revisedHtml: useRevised ? revisedHtml : designerResult })
      }

      return res.json({ result: criticText, role })
    }

    // ── All other roles ────────────────────────────────────────────────────────
    let userPrompt: string
    let task: 'html' | 'analyze'

    if (role === 'designer') {
      userPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}`
      task = 'html'
    } else if (role === 'engineer') {
      userPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML APROBADO DEL DESIGNER:\n${designerResult ?? ''}`
      task = 'analyze'
    } else {
      userPrompt = `BRIEF: ${brief}`
      task = 'analyze'
    }

    const raw    = await callAI(task, userPrompt, systemPrompt)
    const result = role === 'designer' ? sanitizeDesignerHtml(raw) : raw
    res.json({ result, role })
  } catch (err) {
    console.error('studio/analyze error:', err)
    res.status(500).json({ error: 'Error en análisis' })
  }
})

export default router
