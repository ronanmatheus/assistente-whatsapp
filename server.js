import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* ===========================
   🔐 VALIDAÇÃO DE VARIÁVEIS
=========================== */

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ ERRO: OPENAI_API_KEY não definida!");
  process.exit(1);
}

if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_INSTANCE_TOKEN) {
  console.error("❌ ERRO: ZAPI não configurado!");
  process.exit(1);
}

/* ===========================
   🤖 OPENAI CONFIG
=========================== */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ===========================
   🌐 ROTAS
=========================== */

app.get("/", (req, res) => {
  res.send("Servidor rodando 🚀");
});

/* ===========================
   📩 WEBHOOK
=========================== */

app.post("/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    const message = req.body?.text?.message;
    const phone = req.body?.phone;

    if (!message || !phone) {
      return res.sendStatus(200);
    }

    /* ===========================
       🧠 IA (OPENAI)
    =========================== */

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Você é uma secretária médica extremamente educada e profissional. Responda de forma clara, acolhedora e objetiva.

Mensagem do paciente:
${message}`
    });

    const reply = response.output_text;

    console.log("🤖 Resposta IA:", reply);

    /* ===========================
       📤 ENVIO PARA WHATSAPP
    =========================== */

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
      {
        phone: phone,
        message: reply
      }
    );

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERRO NO WEBHOOK:", error.message);
    res.sendStatus(200);
  }
});

/* ===========================
   🚀 START SERVER
=========================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
