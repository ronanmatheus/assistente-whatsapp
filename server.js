import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const memory = new Map();

function getHistory(phone) {
  return memory.get(phone) || [];
}

function saveHistory(phone, role, content) {
  const history = memory.get(phone) || [];
  history.push({ role, content });

  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }

  memory.set(phone, history);
}

const SYSTEM_PROMPT = `
Você é Carla, secretária virtual do Dr. Ronan Matheus, cirurgião bucomaxilofacial.

Regras:
- Seja acolhedora, objetiva e humana.
- Responda de forma curta e clara.
- Ajude com nova consulta, retorno, pós-operatório e dúvidas administrativas.
- Nunca faça diagnóstico.
- Nunca prescreva medicamento.
- Em caso de urgência, como falta de ar, sangramento importante, trauma facial relevante, febre alta com piora ou edema progressivo, oriente contato imediato com a equipe ou avaliação presencial.
- Faça uma pergunta por vez.
- Quando o paciente quiser agendar, peça nome completo, motivo principal e se já possui exames.
`;

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

    saveHistory(telefone, "user", mensagem);

    const history = getHistory(telefone);

    const input = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      ...history.map(item => ({
        role: item.role,
        content: item.content
      }))
    ];

    const response = await client.responses.create({
      model: "gpt-5.4-mini",
      input
    });

    const resposta =
      response.output_text?.trim() ||
      "Recebi sua mensagem e vou te ajudar por aqui.";

    saveHistory(telefone, "assistant", resposta);

    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`,
      {
        phone: telefone,
        message: resposta
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": ZAPI_CLIENT_TOKEN
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
