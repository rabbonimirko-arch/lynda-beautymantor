// /api/analyze-skin.js
// Vercel Serverless Function (Node) — Beauty Mentor PRO selfie analysis (14 params) with OpenAI Responses API
// Input:  { image_data_url: "data:image/jpeg;base64,...", lang: "it|fr|en" }
// Output: { beauty_score, summary, routine, makeup, hair }

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
  // 1) Prefer convenience field if present
  let outText = (data?.output_text || "").trim();
  if (outText) return outText;

  // 2) Fallback: scan output[] -> content[] for output_text/summary_text
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

    // SYSTEM: strict JSON, cosmetic only, multilingual
    const systemText = `
You are Beauty Mentor, a professional beauty consultant (cosmetic/aesthetic only).
You must NOT provide medical diagnosis and must NOT prescribe drugs.
If you detect anything potentially clinical or severe, advise: "Consult a dermatologist."

Return ONLY valid JSON and ONLY JSON in the exact structure:
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
  "hair": { "tips": [string] }
}

Language of the JSON strings must be: ${lang || "it"}.
`.trim();

    // USER: PRO 14-parameter evaluation + scoring rules
    const userText = `
Analyze the selfie and generate a professional beauty report.

Evaluate these parameters (best-effort, if visible):
1 skin texture
2 skin brightness
3 skin hydration
4 pores visibility
5 redness
6 skin uniformity
7 facial symmetry
8 eye openness
9 lip definition
10 eyebrow balance
11 overall harmony
12 hair framing
13 skin vitality
14 makeup presence

Then return JSON only in the required structure.

Beauty score (0-100) must consider:
- skin uniformity
- skin brightness
- symmetry
- overall facial harmony
- skin vitality
- photo quality (if face is not visible or obstructed, lower score and set skin_type to non_determinata)

Routine rules:
- morning/night routines must be 3-5 steps each
- NO brands, NO medical claims, NO prescriptions
- include SPF in morning routine when appropriate
- keep advice gentle and practical

Makeup tips: 2-4 concise tips consistent with what is visible and with skin type.
Hair tips: 2-4 concise tips; if hair/scalp not visible, give safe general tips.
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
      max_output_tokens: 1100
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
        hint: "OpenAI response had no output_text and no output[].content[].text.",
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

    return res.status(200).json(result);
  } catch (e) {
    console.error("Function crash:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
