// /api/analyze-skin.js
// Beauty Mentor API
// Analisi selfie cosmetica con output JSON pulito, senza markdown e senza asterischi

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function extractOutTextFromResponses(data) {
  let outText = (data?.output_text || "").trim();
  if (outText) return outText;

  if (Array.isArray(data?.output)) {
    const chunks = [];
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c?.type === "output_text" || c?.type === "summary_text") {
          if (typeof c.text === "string") chunks.push(c.text);
        }
        if (c?.type === "refusal" && typeof c.refusal === "string") {
          chunks.push(c.refusal);
        }
      }
    }
    outText = chunks.join("\n").trim();
    if (outText) return outText;
  }

  return "";
}

function cleanJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function to10(x) {
  return clamp(x, 0, 10);
}

function sanitizeText(str) {
  return String(str || "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#+/g, "")
    .replace(/[_`~]/g, "")
    .replace(/[•▪◦●]/g, "-")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function deepCleanObject(obj) {
  if (typeof obj === "string") return sanitizeText(obj);
  if (Array.isArray(obj)) return obj.map(deepCleanObject);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj) out[k] = deepCleanObject(obj[k]);
    return out;
  }
  return obj;
}

/**
 * Beauty Score stabile
 * metriche 0..10, pesate, con penalità qualità foto
 */
function computeBeautyScore(metrics) {
  if (!metrics || typeof metrics !== "object") return null;

  const weights = {
    uniformity: 20,
    brightness: 15,
    texture: 15,
    hydration: 10,
    pores: 10,
    redness: 10,
    vitality: 10,
    symmetry: 5,
    harmony: 5
  };

  const m = {
    uniformity: to10(metrics.uniformity),
    brightness: to10(metrics.brightness),
    texture: to10(metrics.texture),
    hydration: to10(metrics.hydration),
    pores: to10(metrics.pores),
    redness: to10(metrics.redness),
    vitality: to10(metrics.vitality),
    symmetry: to10(metrics.symmetry),
    harmony: to10(metrics.harmony)
  };

  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(weights)) {
    sum += m[k] * weights[k];
    wsum += weights[k];
  }

  const avg10 = sum / Math.max(1, wsum);
  const pq = clamp(metrics.photo_quality_factor ?? metrics.photo_quality ?? 1, 0.35, 1.0);
  const score = Math.round(avg10 * 10 * pq);

  return clamp(score, 0, 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = await readJson(req);
    const { image_data_url, lang } = body || {};

    if (!image_data_url || typeof image_data_url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing image_data_url" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "missing_env: OPENAI_API_KEY" });
    }

    const outLang = (lang || "it").toLowerCase();

    const systemText = `
You are Beauty Mentor, a professional beauty consultant focused only on cosmetic and aesthetic analysis.

You must not provide medical diagnosis.
You must not prescribe drugs.
If something appears potentially clinical or severe, advise the user to consult a dermatologist.

Return only valid JSON and only JSON in the exact structure below.
All strings must be written in ${outLang}.

Do not use markdown.
Do not use asterisks.
Do not use double asterisks.
Do not use bullet symbols.
Do not use hashtags.
Do not use emphasis.
Do not wrap words in bold.
Return plain text only inside JSON string values.

JSON structure:
{
  "beauty_score": number,
  "summary": {
    "skin_type": "secca|grassa|mista|sensibile|acneica|matura|non_determinata",
    "concerns": [string],
    "notes": string
  },
  "routine": {
    "morning": [string],
    "night": [string],
    "notes": string
  },
  "makeup": { "tips": [string] },
  "hair": { "tips": [string] },
  "metrics": {
    "uniformity": 0-10,
    "brightness": 0-10,
    "texture": 0-10,
    "hydration": 0-10,
    "pores": 0-10,
    "redness": 0-10,
    "vitality": 0-10,
    "symmetry": 0-10,
    "harmony": 0-10,
    "photo_quality_factor": 0.35-1.0,
    "why_photo_quality": string
  }
}
`.trim();

    const userText = `
Analyze the selfie and produce:
1. Cosmetic assessment with skin type, concerns and notes
2. Morning routine with 3 to 5 steps
3. Night routine with 3 to 5 steps
4. Makeup tips with 2 to 4 concise suggestions
5. Hair and scalp tips with 2 to 4 concise suggestions

Rules:
- No brands
- No medical claims
- No prescriptions
- All output must be plain text
- No markdown
- No bold
- No asterisks
- No double asterisks
- No bullet symbols

Scoring:
- Fill metrics from 0 to 10
- Use photo_quality_factor from 0.35 to 1.0
- If face is not visible, obstructed, too dark, too blurry or too far:
  set skin_type to non_determinata
  mention that the photo quality limits the analysis
  reduce photo_quality_factor

Return JSON only.
`.trim();

    const payloadReq = {
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemText }]
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            { type: "input_image", image_url: image_data_url }
          ]
        }
      ],
      max_output_tokens: 1400
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payloadReq)
    });

    if (!r.ok) {
      const errTxt = await r.text();
      console.error("OpenAI error:", errTxt);
      return res.status(500).json({
        ok: false,
        error: "openai_error",
        details: errTxt
      });
    }

    const data = await r.json();
    const outText = extractOutTextFromResponses(data);

    if (!outText) {
      return res.status(500).json({
        ok: false,
        error: "no_output_text",
        debug_output_keys: Object.keys(data || {}),
        debug_output_preview: JSON.stringify(data?.output || []).slice(0, 1200)
      });
    }

    const cleaned = cleanJsonFence(outText);

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      console.error("JSON parse failed. Raw output:", cleaned.slice(0, 2000));
      return res.status(500).json({
        ok: false,
        error: "json_parse_failed",
        raw_output: cleaned.slice(0, 2000)
      });
    }

    // pulizia completa di tutto il JSON
    result = deepCleanObject(result);

    // Beauty score stabile ricalcolato lato server
    const computed = computeBeautyScore(result?.metrics);
    if (computed !== null) {
      result.beauty_score = computed;
    } else {
      result.beauty_score = clamp(result?.beauty_score ?? 0, 0, 100);
    }

    // ulteriore pulizia finale
    result = deepCleanObject(result);

    return res.status(200).json(result);

  } catch (e) {
    console.error("Function crash:", e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
}
