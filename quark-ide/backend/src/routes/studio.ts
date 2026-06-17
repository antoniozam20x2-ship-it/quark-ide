import { Router } from 'express'
import { callAI } from '../lib/aiRouter.js'
import pool from '../services/db.js'

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

// ── Unsplash image resolver ────────────────────────────────────────────────────

const imageCache = new Map<string, string>()

async function resolveImagePlaceholders(html: string): Promise<string> {
  const key = process.env.UNSPLASH_ACCESS_KEY
  const slotRegex = /<div class="img-slot" data-query="([^"]+)"([^>]*)><\/div>/g
  const matches = [...html.matchAll(slotRegex)]
  if (matches.length === 0) return html

  const uniqueQueries = [...new Set(matches.map(m => m[1]))]

  await Promise.all(uniqueQueries.map(async (query) => {
    if (imageCache.has(query)) return
    if (!key) {
      imageCache.set(query, '')
      return
    }
    try {
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&content_filter=high`
      const r = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } })
      const data = await r.json() as any
      const photoUrl = data?.results?.[0]?.urls?.regular ?? ''
      imageCache.set(query, photoUrl)
    } catch (err) {
      console.warn('[Unsplash] fallo en query:', query, err)
      imageCache.set(query, '')
    }
  }))

  let result = html.replace(slotRegex, (_full, query, _extraAttrs) => {
    const photoUrl = imageCache.get(query)
    if (photoUrl) {
      return `<div class="img-slot" style="width:100%;height:250px;background-image:url('${photoUrl}');background-size:cover;background-position:center;background-repeat:no-repeat;display:block;"></div>`
    }
    return `<div class="img-slot" style="width:100%;height:250px;background:linear-gradient(135deg,#7C3AED33,#06B6D433);display:block;"></div>`
  })

  const styleInject = `<style>
    .img-slot { width: 100% !important; height: 250px !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; display: block !important; }
  </style>`

  result = result.replace('</head>', styleInject + '</head>')

  return result
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

Usa tu criterio profesional para decidir qué tan complejo debe ser según el brief. Un restaurante merece navbar, hero animado, menú interactivo, reservaciones, galería con lightbox y footer completo. Un juego merece canvas y game loop. Una tienda merece carrito y productos. Sé ambicioso.

CRÍTICO — IMÁGENES: Para cualquier imagen fotográfica que el diseño necesite (comida, productos, personas, lugares, etc.), usa este placeholder exacto en vez de <img>:
<div class="img-slot" data-query="keyword1,keyword2" style="width:100%;height:100%;background-size:cover;background-position:center;"></div>
El atributo data-query debe tener 1-3 keywords en inglés específicas al contenido real (ej: data-query="croissant,bakery" para una panadería, data-query="sneakers,product" para zapatillas). No inventes URLs de imágenes ni uses la etiqueta <img> para fotos — el backend resuelve estos placeholders después. Para iconografía decorativa simple (no fotos) puedes seguir usando SVG inline.`,

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

// ── Fast Mode system prompt suffix ────────────────────────────────────────────

const FAST_MODE_IMAGE_RULES = `

REGLA ABSOLUTA DE IMÁGENES - SIN EXCEPCIONES:
Antes de escribir cualquier card, sección o item, SIEMPRE escribe primero este div exacto:
<div class="img-slot" data-query="KEYWORD_ESPECIFICA" style="width:100%;height:250px;background-size:cover;background-position:center;display:block;"></div>

Ejemplos obligatorios:
- Rainbow Roll → data-query="rainbow roll sushi"
- Hero section → data-query="japanese restaurant interior"
- Salmon Nigiri → data-query="salmon nigiri sushi"

Si generas un card SIN este div primero = ERROR CRÍTICO.
NUNCA uses background-color como reemplazo de imágenes.`

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  try {
    const { brief, role, architectResult, designerResult, fastMode } = req.body as {
      brief: string
      role: string
      architectResult?: string
      designerResult?: string
      fastMode?: boolean
    }

    if (!brief || !role) return res.status(400).json({ error: 'brief y role requeridos' })

    const basePrompt = SYSTEM_PROMPTS[role]
    if (!basePrompt) return res.status(400).json({ error: 'role inválido' })
    const systemPrompt = (fastMode && role === 'designer')
      ? basePrompt + FAST_MODE_IMAGE_RULES
      : basePrompt

    // ── Critic (qa): evaluate + optional 1 revision round ─────────────────────
    if (role === 'qa') {
      const criticPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML DEL DESIGNER:\n${designerResult ?? ''}`
      const criticText = await callAI('analyze', criticPrompt, systemPrompt)

      if (criticText.trim().startsWith('REVISAR:')) {
        const revisionPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML ORIGINAL (referencia base, mejóralo sin partir de cero):\n${designerResult ?? ''}\n\nNOTAS DE REVISIÓN (correcciones obligatorias):\n${criticText}`
        const revisedRaw  = await callAI('html', revisionPrompt, SYSTEM_PROMPTS['designer'])
        const revisedHtml = await resolveImagePlaceholders(sanitizeDesignerHtml(revisedRaw))
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
    const result = role === 'designer' ? await resolveImagePlaceholders(sanitizeDesignerHtml(raw)) : raw
    res.json({ result, role })
  } catch (err) {
    console.error('studio/analyze error:', err)
    res.status(500).json({ error: 'Error en análisis' })
  }
})

// ── Studio Projects CRUD ──────────────────────────────────────────────────────

router.get('/projects', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, folder, created_at FROM studio_projects ORDER BY folder, created_at DESC'
    )
    res.json(rows)
  } catch (err) {
    console.error('studio/projects GET error:', err)
    res.status(500).json({ error: 'Error al obtener proyectos' })
  }
})

router.post('/projects', async (req, res) => {
  try {
    const { name, folder, html } = req.body as { name: string; folder: string; html: string }
    if (!name || !html) return res.status(400).json({ error: 'name y html requeridos' })
    const folderVal = (folder ?? '').trim() || 'Sin carpeta'
    const { rows } = await pool.query(
      'INSERT INTO studio_projects (name, folder, html) VALUES ($1, $2, $3) RETURNING id, name, folder, created_at',
      [name.trim(), folderVal, html]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('studio/projects POST error:', err)
    res.status(500).json({ error: 'Error al guardar proyecto' })
  }
})

router.delete('/projects/:id', async (req, res) => {
  try {
    const { id } = req.params
    await pool.query('DELETE FROM studio_projects WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (err) {
    console.error('studio/projects DELETE error:', err)
    res.status(500).json({ error: 'Error al eliminar proyecto' })
  }
})

router.get('/projects/:id/html', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT html FROM studio_projects WHERE id = $1', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Proyecto no encontrado' })
    res.json({ html: rows[0].html })
  } catch (err) {
    console.error('studio/projects/:id/html error:', err)
    res.status(500).json({ error: 'Error al obtener HTML' })
  }
})

export default router
