// /api/analyze-skin.js  (Vercel Function robusta + formato Responses corretto)
async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
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
- beauty_score 0-100
- routine mattina/sera (3-5 step, NO brand)
- 3 tip makeup coerenti
- 2-3 tip capelli/cute (se deducibile, altrimenti generici)
`.trim();

    // ✅ Responses API: usare input_text / input_image
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
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
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
    const outText = (data.output_text || "").trim();

    if (!outText) {
      console.error("No output_text. Full response:", JSON.stringify(data).slice(0, 4000));
      return res.status(500).json({ ok: false, error: "no_output_text" });
    }

    const cleaned = outText
      .replace(/^```json/i, "")
      .replace(/```$/i, "")
      .trim();

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
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
