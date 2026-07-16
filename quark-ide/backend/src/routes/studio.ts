import { Router } from 'express'
import { callAI } from '../lib/aiRouter.js'
import pool from '../services/db.js'
import { readFileSync } from 'fs'

const router = Router()

// ── Design rules (from ui-ux-pro-max-skill CSVs) ─────────────────────────────

interface DesignRule {
  tipo: string
  keywords: string[]
  patron: string
  paleta_ejemplo: string[]
  anti_patrones: string[]
}

const designRules: DesignRule[] = JSON.parse(
  readFileSync(new URL('../lib/designRules.json', import.meta.url), 'utf-8')
)

// Fix 1: Spanish→English domain dictionary (covers ~90% of real briefs)
const ES_EN: Record<string, string[]> = {
  restaurante: ['restaurant'], comida: ['food'], menú: ['menu'], menu: ['menu'],
  reserva: ['reservation', 'booking'], reservación: ['reservation', 'booking'],
  cocina: ['food', 'kitchen'], chef: ['chef'], carta: ['menu'],
  tienda: ['shop', 'store', 'ecommerce'], negocio: ['business'],
  empresa: ['business', 'corporate'], corporativo: ['corporate'],
  hotel: ['hotel'], hospedaje: ['hotel', 'lodging'], alojamiento: ['hotel', 'lodging'],
  salud: ['health', 'medical'], médico: ['medical', 'health'], clínica: ['medical', 'clinic'],
  hospital: ['hospital', 'medical'], bienestar: ['wellness', 'health'],
  entrenamiento: ['fitness', 'training'], gimnasio: ['fitness', 'gym'],
  ejercicio: ['fitness', 'exercise'], deporte: ['sports'],
  educación: ['education', 'learning'], curso: ['course', 'learning'],
  formación: ['training', 'education'], escuela: ['education', 'school'],
  música: ['music'], sonido: ['audio', 'music'], podcast: ['podcast'],
  fotografía: ['photography'], foto: ['photography', 'photo'],
  viaje: ['travel'], turismo: ['travel', 'tourism'], vuelo: ['travel', 'flight'],
  moda: ['fashion'], ropa: ['clothing', 'fashion'], vestimenta: ['clothing'],
  tecnología: ['technology', 'tech'], software: ['software', 'saas'],
  aplicación: ['app'], aplicacion: ['app'],
  finanzas: ['finance', 'financial'], banco: ['banking', 'finance'],
  inversión: ['investment', 'finance'], inversion: ['investment', 'finance'],
  inmobiliaria: ['real-estate'], propiedad: ['real-estate', 'property'],
  boda: ['wedding'], evento: ['event'], conferencia: ['conference'],
  portfolio: ['portfolio'], portafolio: ['portfolio'],
  arte: ['art', 'creative'], diseño: ['design', 'creative'], creativo: ['creative'],
  juego: ['game', 'gaming'], videojuego: ['gaming', 'game'],
  italiano: ['restaurant', 'food', 'dining'], mexicano: ['restaurant', 'food', 'dining'],
  japonés: ['restaurant', 'food', 'dining'], sushi: ['restaurant', 'food', 'dining'],
  trattoria: ['restaurant', 'dining', 'cuisine'], bistro: ['restaurant', 'dining'],
  brasserie: ['restaurant', 'dining'], taberna: ['restaurant', 'dining'],
  cafetería: ['restaurant', 'food'], panadería: ['bakery', 'food'],
  pastelería: ['bakery', 'food'], cantina: ['restaurant', 'food'],
  lujo: ['luxury'], premium: ['luxury', 'premium'],
  delivery: ['delivery', 'food'], pedido: ['order', 'delivery'],
  dashboard: ['dashboard'], inventario: ['inventory'],
  gestión: ['management', 'saas'], administración: ['admin', 'management'],
}

function briefTokens(brief: string): Set<string> {
  // Tokenize brief into words, expand Spanish terms via dictionary
  const words = brief.toLowerCase().split(/[\s,.\-_/\\()[\]{}!?:;'"]+/).filter(w => w.length > 1)
  const expanded = new Set<string>(words)
  for (const word of words) {
    const mapped = ES_EN[word]
    if (mapped) mapped.forEach(t => expanded.add(t))
  }
  return expanded
}

function matchDesignRule(brief: string): DesignRule | null {
  // Fix 2: word-boundary matching via tokenization (no substring)
  const tokens = briefTokens(brief)
  let bestMatch: DesignRule | null = null
  let bestScore = 0
  let bestPct   = 0
  for (const rule of designRules) {
    const hits  = rule.keywords.filter(kw => tokens.has(kw)).length
    const pct   = rule.keywords.length > 0 ? hits / rule.keywords.length : 0
    // Fix 3: min 2 hits; tiebreak by % of rule's own keywords covered
    if (hits > bestScore || (hits === bestScore && hits >= 2 && pct > bestPct)) {
      bestScore = hits; bestPct = pct; bestMatch = rule
    }
  }
  return bestScore >= 2 ? bestMatch : null
}

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

// ── Pexels video resolver ─────────────────────────────────────────────────────

const videoCache = new Map<string, string>()

async function resolveVideoPlaceholders(html: string): Promise<string> {
  const key = process.env.PEXELS_API_KEY
  const slotRegex = /<div class="video-slot" data-query="([^"]+)"[^>]*><\/div>/g
  const matches = [...html.matchAll(slotRegex)]
  if (matches.length === 0) return html

  const uniqueQueries = [...new Set(matches.map(m => m[1]))]

  await Promise.all(uniqueQueries.map(async (query) => {
    const cached = videoCache.get(query)
    if (cached && cached.startsWith('http')) return
    if (!key) {
      videoCache.set(query, '')
      return
    }
    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape&size=medium`
      const r = await fetch(url, { headers: { Authorization: key } })
      const data = await r.json() as any
      const videoUrl = data?.videos?.[0]?.video_files?.find((f: any) =>
        f.quality === 'hd' || f.quality === 'sd'
      )?.link ?? ''
      videoCache.set(query, videoUrl)
    } catch (err) {
      console.warn('[Pexels] fallo en query:', query, err)
    }
  }))

  return html.replace(slotRegex, (_full, query) => {
    const videoUrl = videoCache.get(query)
    if (videoUrl && videoUrl.startsWith('http')) {
      return `<video autoplay muted loop playsinline style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;">
  <source src="${videoUrl}" type="video/mp4">
</video>`
    }
    return `<div style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e,#16213e);z-index:0;"></div>`
  })
}

// ── HTML compressor para edición eficiente ───────────────────────────────────

function compressHtmlForEditing(html: string): { compressed: string; styleBlock: string } {
  const styleMatch = html.match(/<style[\s\S]*?<\/style>/gi) ?? []
  const styleBlock = styleMatch.join('\n')

  const compressed = html
    .replace(/<style[\s\S]*?<\/style>/gi, '<style>/* CSS_PRESERVED */</style>')
    .replace(/background-image:url\('[^']+'\)/g, "background-image:url('IMG_URL')")
    .replace(/https:\/\/images\.unsplash\.com[^'")]+/g, 'UNSPLASH_URL')

  return { compressed, styleBlock }
}

function restoreHtmlAfterEditing(editedCompressed: string, original: string): string {
  const originalStyles = original.match(/<style[\s\S]*?<\/style>/gi) ?? []
  const unsplashUrls = [...original.matchAll(/https:\/\/images\.unsplash\.com[^'")]+/g)].map(m => m[0])

  let result = editedCompressed
  let styleIndex = 0
  let urlIndex = 0

  result = result.replace(/<style>\/\* CSS_PRESERVED \*\/<\/style>/gi, () => {
    return originalStyles[styleIndex++] ?? ''
  })

  result = result.replace(/background-image:url\('IMG_URL'\)/g, () => {
    const url = unsplashUrls[urlIndex++]
    return url ? `background-image:url('${url}')` : `background-image:url('IMG_URL')`
  })

  result = result.replace(/UNSPLASH_URL/g, () => unsplashUrls[urlIndex++] ?? '')

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

CRÍTICO — NAVEGACIÓN FUNCIONAL:
- Cada enlace del navbar debe tener href="#id-de-seccion"
- Cada sección debe tener el id correspondiente: <section id="hero">, <section id="menu">, <section id="galeria">, <section id="reserva">, <section id="contacto">
- NUNCA uses solo class sin id en secciones principales
- El scroll debe funcionar suavemente: agrega html { scroll-behavior: smooth; } en el CSS

CRÍTICO — VIDEO EN HERO:
Para páginas de negocio con experiencia visual (restaurante, hotel, spa, tienda, café, bar), el hero DEBE tener un video de fondo en loop. Usa este placeholder exacto:
<div class="video-slot" data-query="keyword1 keyword2" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>
El data-query debe tener 2-3 keywords en inglés específicas al negocio (ej: "italian restaurant food" para pizzería, "luxury hotel lobby" para hotel). El backend resuelve este placeholder con un video real de Pexels.

CRÍTICO — IMÁGENES:
Para cualquier imagen fotográfica usa este placeholder:
<div class="img-slot" data-query="keyword1,keyword2" style="width:100%;height:100%;background-size:cover;background-position:center;"></div>
El data-query debe tener 1-3 keywords en inglés específicas al contenido real. No inventes URLs ni uses <img> para fotos.

ESTRUCTURA DEL HERO CON VIDEO:
<section id="hero" style="position:relative;height:100vh;overflow:hidden;display:flex;align-items:center;justify-content:center;">
  <div class="video-slot" data-query="KEYWORDS_DEL_NEGOCIO" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>
  <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1;"></div>
  <div style="position:relative;z-index:2;text-align:center;color:white;">
    <!-- Título, subtítulo, CTA -->
  </div>
</section>`,

  qa: `Eres un crítico de diseño senior. Recibes el BRIEF, la DIRECCIÓN CREATIVA y el HTML
generado por el Designer. Evalúa con honestidad siguiendo este checklist:

CHECKLIST TÉCNICO (extraído de ux-guidelines reales — cualquier falla = REVISAR obligatorio):
☐ Contraste mínimo 4.5:1 para texto normal sobre fondo (WCAG AA)
☐ Transiciones hover/focus en 150-300ms — ni más lentas ni más rápidas
☐ prefers-reduced-motion respetado: animaciones decorativas solo cuando la media query lo permita
☐ Sin emojis como íconos funcionales — usar SVG con aria-label o texto
☐ cursor-pointer en TODOS los elementos interactivos (botones, links, cards clicables)
☐ Layout responsive verificado para 375px / 768px / 1024px / 1440px

CHECKLIST DE DISEÑO (evalúa calidad):
1. ¿Sigue exactamente la paleta y tipografía de la DIRECCIÓN CREATIVA?
2. ¿Tiene jerarquía visual real o se ve genérico/plantilla/todo centrado?
3. ¿El contenido es específico al brief o es relleno genérico?
4. ¿Hay bugs visibles (HTML roto, bloques de markdown sin limpiar, texto sin estilo)?

Si TODO el checklist pasa y el diseño es sólido, responde EXACTAMENTE: APROBADO
Si algo falla, responde con máximo 4 líneas de instrucciones específicas y accionables,
empezando con: REVISAR:`,

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
    const { brief, role, architectResult, designerResult, fastMode, improveMode } = req.body as {
      brief: string
      role: string
      architectResult?: string
      designerResult?: string
      fastMode?: boolean
      improveMode?: boolean
    }

    if (!brief || !role) return res.status(400).json({ error: 'brief y role requeridos' })

    const basePrompt = SYSTEM_PROMPTS[role]
    if (!basePrompt) return res.status(400).json({ error: 'role inválido' })
    let systemPrompt: string
    if (fastMode && role === 'designer') {
      systemPrompt = basePrompt + FAST_MODE_IMAGE_RULES
    } else if (improveMode && role === 'engineer') {
      systemPrompt = `IMPORTANTE: Estás en modo MEJORA de proyecto existente.\nEl HTML de referencia ya fue aprobado por el usuario — NO lo reinterpretes ni rediseñes.\nTu spec debe describir SOLO los cambios específicos solicitados, preservando todo lo demás.\n\n` + basePrompt
    } else {
      systemPrompt = basePrompt
    }

    // ── Critic (qa): evaluate + optional 1 revision round ─────────────────────
    if (role === 'qa') {
      const criticPrompt = improveMode
        ? `PROYECTO EXISTENTE (NO rediseñar — solo evaluar la mejora solicitada):\n${designerResult ?? ''}\n\nMEJORA SOLICITADA:\n${brief}\n\nEvalúa ÚNICAMENTE si la mejora solicitada se aplicó correctamente sin romper el diseño existente.\nNO evalúes la paleta, tipografía ni estructura general — esas ya fueron aprobadas por el usuario.\nSi la mejora está bien aplicada → responde EXACTAMENTE: APROBADO\nSi algo está roto o la mejora no se aplicó → responde REVISAR: [máximo 2 líneas específicas]`
        : `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML DEL DESIGNER:\n${designerResult ?? ''}`
      const criticText = await callAI('analyze', criticPrompt, systemPrompt)

      if (criticText.trim().startsWith('REVISAR:')) {
        const revisionPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${architectResult ?? ''}\n\nHTML ORIGINAL (referencia base, mejóralo sin partir de cero):\n${designerResult ?? ''}\n\nNOTAS DE REVISIÓN (correcciones obligatorias):\n${criticText}`
        const revisedRaw  = await callAI('html', revisionPrompt, SYSTEM_PROMPTS['designer'])
        const revisedHtml = await resolveVideoPlaceholders(await resolveImagePlaceholders(sanitizeDesignerHtml(revisedRaw)))
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
      const engineerArchitectContext = improveMode
        ? `MODO MEJORA — trabajando sobre proyecto existente.\nLa estructura, paleta y tipografía del proyecto existente deben preservarse intactas.\nSolo implementar la mejora específica solicitada en el brief.`
        : (architectResult ?? '')
      userPrompt = `BRIEF: ${brief}\n\nDIRECCIÓN CREATIVA:\n${engineerArchitectContext}\n\nHTML APROBADO DEL DESIGNER:\n${designerResult ?? ''}`
      task = 'analyze'
    } else {
      const matchedRule = matchDesignRule(brief)
      let refBlock = ''
      if (matchedRule) {
        // Fix 4: omit palette line when empty (39 entries have no parsed hex)
        const paletaLine = matchedRule.paleta_ejemplo.length > 0
          ? `\n- Paleta de referencia: ${matchedRule.paleta_ejemplo.join(', ')}`
          : ''
        refBlock = `\n\nREFERENCIA DE DISEÑO (tipo de proyecto detectado: ${matchedRule.tipo}):\n- Patrón recomendado: ${matchedRule.patron}${paletaLine}\n- Anti-patrones a evitar: ${matchedRule.anti_patrones.join('; ')}`
      }
      userPrompt = `BRIEF: ${brief}${refBlock}`
      task = 'analyze'
    }

    const raw    = await callAI(task, userPrompt, systemPrompt)
    const result = role === 'designer'
      ? await resolveVideoPlaceholders(await resolveImagePlaceholders(sanitizeDesignerHtml(raw)))
      : raw
    res.json({ result, role })
  } catch (err) {
    console.error('studio/analyze error:', err)
    res.status(500).json({ error: 'Error en análisis' })
  }
})

// ── Edit existing project HTML ────────────────────────────────────────────────

const EDITOR_SYSTEM_PROMPT = `Eres un editor HTML quirúrgico. Tu única tarea es aplicar cambios específicos a un HTML existente.

REGLAS ABSOLUTAS:
1. El HTML viene en <html_original>. ESE es tu documento base — no lo reinterpretes.
2. Los cambios vienen en <cambios_solicitados>. SOLO modifica lo indicado ahí.
3. NUNCA toques bloques marcados como /* CSS_PRESERVED */ — son CSS que se restaura automáticamente.
4. NUNCA cambies atributos marcados como UNSPLASH_URL ni IMG_URL — se restauran automáticamente.
5. NUNCA elimines secciones, navegación, formularios ni elementos no mencionados en los cambios.
6. Si el cambio requiere imágenes nuevas, usa: <div class="img-slot" data-query="keyword" style="width:100%;height:250px;background-size:cover;background-position:center;display:block;"></div>
7. Devuelve SOLO el HTML completo — empieza con <!DOCTYPE html>, termina con </html>.
8. Sin texto explicativo, sin markdown, sin bloques de código.`

router.post('/edit', async (req, res) => {
  try {
    const { projectId, changes, html: inlineHtml } = req.body as {
      projectId?: number
      changes: string
      html?: string
    }
    if (!changes) return res.status(400).json({ error: 'changes requerido' })

    let currentHtml = inlineHtml ?? ''
    if (!currentHtml && projectId) {
      const { rows } = await pool.query('SELECT html FROM studio_projects WHERE id = $1', [projectId])
      if (!rows.length) return res.status(404).json({ error: 'Proyecto no encontrado' })
      currentHtml = rows[0].html
    }
    if (!currentHtml) return res.status(400).json({ error: 'html o projectId requerido' })

    // ── Comprimir antes de mandar a Claude ──
    const { compressed } = compressHtmlForEditing(currentHtml)
    console.log(`[Studio/Edit] Original: ${currentHtml.length} chars → Comprimido: ${compressed.length} chars`)

    const userPrompt = `<html_original>
${compressed}
</html_original>

<cambios_solicitados>
${changes}
</cambios_solicitados>

Aplica ÚNICAMENTE los cambios descritos. No toques /* CSS_PRESERVED */ ni UNSPLASH_URL ni IMG_URL. Devuelve el HTML completo con los cambios aplicados. Sin explicaciones, sin markdown.`

    const raw = await callAI('edit', userPrompt, EDITOR_SYSTEM_PROMPT)
    const sanitized = sanitizeDesignerHtml(raw)

    // ── Restaurar CSS y URLs originales ──
    const restored = restoreHtmlAfterEditing(sanitized, currentHtml)

    // ── Resolver solo img-slot NUEVOS que Claude haya añadido ──
    const finalHtml = await resolveVideoPlaceholders(await resolveImagePlaceholders(restored))

    console.log(`[Studio/Edit] Restaurado: ${finalHtml.length} chars`)
    res.json({ html: finalHtml })

  } catch (err) {
    console.error('studio/edit error:', err)
    res.status(500).json({ error: 'Error al editar proyecto' })
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

router.get('/projects/search', async (req, res) => {
  const query = (req.query.name as string | undefined)?.trim()
  if (!query) {
    res.status(400).json({ error: 'name query param required' })
    return
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, folder, created_at 
       FROM studio_projects 
       WHERE name ILIKE $1 
       ORDER BY created_at DESC`,
      [`%${query}%`]
    )
    res.json({ projects: rows })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
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

router.put('/projects/:id', async (req, res) => {
  try {
    const { html } = req.body as { html: string }
    if (!html) return res.status(400).json({ error: 'html requerido' })
    const { rows } = await pool.query(
      'UPDATE studio_projects SET html = $1 WHERE id = $2 RETURNING id, name, folder, created_at',
      [html, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Proyecto no encontrado' })
    res.json(rows[0])
  } catch (err) {
    console.error('studio/projects PUT error:', err)
    res.status(500).json({ error: 'Error al actualizar proyecto' })
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
