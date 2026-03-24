import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get("/", (req, res) => {
  res.send("Servidor rodando");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    const mensagem = req.body?.text?.message;
    const telefone = req.body?.phone;
    const fromMe = req.body?.fromMe;
    const instanceId = req.body?.instanceId;

    res.sendStatus(200);

    if (!telefone || !mensagem || fromMe === true || !instanceId) {
      return;
    }

    let resposta = "Recebi sua mensagem e vou te ajudar por aqui.";

    if (openai) {
      const response = await openai.responses.create({
        model: "gpt-5.4-mini",
        input: [
          {
            role: "system",
            content:
              "Você é Carla, secretária virtual do Dr. Ronan Matheus, cirurgião bucomaxilofacial. Seja acolhedora, objetiva e humana. Nunca faça diagnóstico."
          },
          {
            role: "user",
            content: mensagem
          }
        ]
      });

      resposta = response.output_text?.trim() || resposta;
    } else {
      console.log("⚠️ OPENAI_API_KEY não configurada. Respondendo sem IA.");
    }

    const zapiUrl = `https://api.z-api.io/instances/${instanceId}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`;

    console.log("Enviando resposta para:", zapiUrl);

    await axios.post(
      zapiUrl,
      {
        phone: telefone,
        message: resposta
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN || ""
        }
      }
    );

    console.log("✅ Resposta enviada com sucesso");
  } catch (error) {
    console.error("ERRO NO WEBHOOK:");
    console.error(error.response?.data || error.message || error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
