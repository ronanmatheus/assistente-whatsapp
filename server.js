import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

    res.sendStatus(200);

    if (!telefone || !mensagem || fromMe === true) {
      return;
    }

    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      input: [
        {
          role: "system",
          content:
            "Você é Carla, secretária virtual do Dr. Ronan Matheus, cirurgião bucomaxilofacial. Seja acolhedora, objetiva e humana. Nunca faça diagnóstico. Em caso de urgência, como falta de ar, sangramento importante, trauma facial importante ou edema progressivo, oriente contato imediato com a equipe."
        },
        {
          role: "user",
          content: mensagem
        }
      ]
    });

    const resposta =
      response.output_text?.trim() ||
      "Recebi sua mensagem e vou te ajudar por aqui.";

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
      {
        phone: telefone,
        message: resposta
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN
        }
      }
    );
  } catch (error) {
    console.error("ERRO NO WEBHOOK:");
    console.error(error.response?.data || error.message || error);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
