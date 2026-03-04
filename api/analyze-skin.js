// /api/analyze-skin.js
// Vercel Serverless Function (Node) — Robust selfie analysis with OpenAI Responses API
// - Accepts: { image_data_url: "data:image/jpeg;base64,...", lang: "it|fr|en" }
// - Returns: JSON { beauty_score, summary, routine, makeup, hair }

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
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
  // 1) Prefer the convenience field (if present)
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

    const systemText = `
Sei Beauty Mentor: consulente cosmetico professionale.
Analizza il selfie solo in ottica estetica/cosmetica (NON medica).
Non fare diagnosi, non prescrivere farmaci.
Se noti qualcosa di potenzialmente clinico, consiglia visita dermatologo.

Rispondi SOLO con JSON valido e SOLO JSON con questa struttura:
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
Lingua output: ${lang || "it"}.
`.trim();

    const userText = `
Analizza il selfie e genera:
- tipo pelle probabile + motivazione breve
- aspetti: pori/rossori/lucidità/disidratazione/imperfezioni/texture
- beauty_score 0-100 (uniformità, luminosità, aspetto curato)
- routine mattina/sera (3-5 step, NO brand)
- 3 tip makeup coerenti
- 2-3 tip capelli/cute (se deducibile, altrimenti generici e sicuri)
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
      max_output_tokens: 900
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
    } catch (e) {
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
