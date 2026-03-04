// /api/analyze-skin.js
// Vercel Serverless Function (Node) — Beauty Mentor PRO (Sephora-like Beauty Score)
//
// Input:  { image_data_url: "data:image/jpeg;base64,...", lang: "it|fr|en" }
// Output: { beauty_score, summary, routine, makeup, hair, metrics? }
//
// NOTE: We compute a stable, realistic Beauty Score server-side from component metrics.

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
  // 1) Prefer convenience field
  let outText = (data?.output_text || "").trim();
  if (outText) return outText;

  // 2) Fallback: scan output[] -> content[]
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
  return (text || "")
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

/**
 * Sephora-like score:
 * - component metrics 0..10 (higher is better)
 * - weighted average -> 0..100
 * - multiplied by photo_quality factor (0.35..1.0)
 */
function computeBeautyScore(metrics) {
  if (!metrics || typeof metrics !== "object") return null;

  // Weights sum = 100
  const weights = {
    uniformity: 20,
    brightness: 15,
    texture: 15,
    hydration: 10,
    pores: 10,        // higher = better (pores less visible)
    redness: 10,      // higher = better (less redness)
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

  // 0..10
  const avg10 = sum / Math.max(1, wsum);

  // Photo quality factor: 0.35..1.0 (penalize if face obstructed / too dark / blurry)
  const pq = clamp(metrics.photo_quality_factor ?? metrics.photo_quality ?? 1, 0.35, 1.0);

  // Convert to 0..100
  const score = Math.round(avg10 * 10 * pq);

  return clamp(score, 0, 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

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

    // SYSTEM: strict JSON, cosmetic only
    const systemText = `
You are Beauty Mentor, a professional beauty consultant (cosmetic/aesthetic only).
You must NOT provide medical diagnosis and must NOT prescribe drugs.
If you detect anything potentially clinical or severe, advise: "Consult a dermatologist."

Return ONLY valid JSON and ONLY JSON in the exact structure below.
All strings must be written in: ${outLang}.

STRUCTURE (JSON only):
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

Rules:
- Metrics must be realistic; higher is better.
- "photo_quality_factor" must penalize if: face not visible, obstructed, too far, too dark, too blurry.
- The "beauty_score" you output is a preliminary score; server may recompute.
`.trim();

    // USER: asks for PRO metrics + cosmetic advice only
    const userText = `
Analyze the selfie and produce:
1 Cosmetic assessment (skin_type + concerns + notes)
2 A simple morning routine (3-5 steps) and night routine (3-5 steps), NO brands, NO medical claims
3 Makeup tips (2-4 concise tips)
4 Hair/scalp tips (2-4 concise tips; if not visible, safe general tips)

Sephora-like scoring:
- Fill the "metrics" fields (0-10 each) with best-effort.
- Provide a realistic "photo_quality_factor" (0.35..1.0) + short reason.

If the face is not clearly visible, set skin_type = non_determinata, add concern about photo validity, and set photo_quality_factor low.
Return JSON ONLY.
`.trim();

    const payloadReq = {
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: systemText }] },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            { type: "input_image", image_url: image_data_url }
          ]
        }
      ],
      max_output_tokens: 1200
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
      return res.status(500).json({ ok: false, error: "openai_error", details: errTxt });
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

    // ---- Sephora-like scoring override (stable & realistic) ----
    const computed = computeBeautyScore(result?.metrics);
    if (computed !== null) {
      result.beauty_score = computed;
    } else {
      // fallback if metrics missing
      result.beauty_score = clamp(result?.beauty_score ?? 0, 0, 100);
    }

    return res.status(200).json(result);

  } catch (e) {
    console.error("Function crash:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
