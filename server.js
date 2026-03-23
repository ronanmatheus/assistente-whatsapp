import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

const openai = hasOpenAIKey
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get("/", (req, res) => {
  res.send("Servidor rodando");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    const message = req.body?.text?.message;
    const phone = req.body?.phone;

    res.sendStatus(200);

    if (!message || !phone) return;

    let reply = "Recebi sua mensagem e vou te ajudar por aqui.";

    if (openai) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "Você é uma secretária médica extremamente educada, profissional e acolhedora. Responda de forma clara, humana e objetiva."
          },
          {
            role: "user",
            content: message
          }
        ]
      });

      reply = response.output_text || reply;
    } else {
      console.log("⚠️ OPENAI_API_KEY não configurada. Respondendo sem IA.");
    }

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
      {
        phone,
        message: reply
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN
        }
      }
    );
  } catch (error) {
    console.error("❌ ERRO NO WEBHOOK:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
