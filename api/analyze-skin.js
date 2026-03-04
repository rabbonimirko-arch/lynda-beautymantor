// /api/analyze-skin.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { image_data_url, lang } = req.body || {};
    if (!image_data_url || typeof image_data_url !== "string") {
      return res.status(400).json({ error: "Missing image_data_url" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "missing_env: OPENAI_API_KEY" });

    const system = `
Sei Beauty Mentor: consulente cosmetico professionale.
Analizza il selfie solo in ottica estetica/cosmetica (NON medica).
Non fare diagnosi, non prescrivere farmaci.
Se noti qualcosa di potenzialmente clinico, consiglia visita dermatologo.

Rispondi SOLO con JSON valido in questa struttura:
{
  "beauty_score": 0-100,
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

    const user = `
Analizza il selfie e genera:
- tipo pelle probabile + motivazione breve
- aspetti: pori/rossori/lucidità/disidratazione/imperfezioni/texture
- beauty_score 0-100 (uniformità, luminosità, aspetto curato)
- routine mattina/sera (3-5 step, NO brand)
- 3 tip makeup coerenti
- 2-3 tip capelli/cute se deducibile, altrimenti generici e sicuri
    `.trim();

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "text", text: system }] },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              { type: "input_image", image_url: image_data_url }
            ]
          }
        ],
        max_output_tokens: 700
      })
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(500).send(errTxt);
    }

    const data = await r.json();

    // L'API Responses ritorna testo in output_text (consigliato) :contentReference[oaicite:2]{index=2}
    const outText =
      data.output_text ||
      (Array.isArray(data.output)
        ? data.output.map(o => (o.content || []).map(c => c.text || "").join("")).join("")
        : "");

    const cleaned = (outText || "").trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const payload = JSON.parse(cleaned);

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}