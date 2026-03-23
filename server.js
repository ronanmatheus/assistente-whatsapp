import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const conversationMemory = new Map();

function getHistory(phone) {
  return conversationMemory.get(phone) || [];
}

function saveHistory(phone, role, content) {
  const history = conversationMemory.get(phone) || [];
  history.push({ role, content });

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  conversationMemory.set(phone, history);
}

const SYSTEM_PROMPT = `
Você é Carla, secretária virtual do Dr. Ronan Matheus, cirurgião bucomaxilofacial.

Seu papel é atender pacientes pelo WhatsApp com linguagem humana, acolhedora, segura e profissional.

Objetivos:
- entender o motivo do contato
- identificar se é nova consulta, retorno, pós-operatório, urgência ou dúvida administrativa
- conduzir a conversa de forma breve e organizada
- facilitar o agendamento
- encaminhar casos complexos para atendimento humano

Regras:
- nunca faça diagnóstico
- nunca prescreva medicamentos
- nunca minimize sinais de urgência
- em caso de dificuldade respiratória, sangramento importante, trauma facial importante, febre alta com piora ou edema progressivo, orientar atendimento imediato e avisar que a equipe deve ser acionada
- não usar linguagem robótica
- respostas curtas, claras e educadas
- fazer uma pergunta por vez
- coletar apenas o necessário
- quando perceber que o caso precisa de avaliação médica específica, dizer que vai encaminhar para a equipe
- quando o paciente quiser agendar, coletar:
  nome completo,
  motivo principal,
  se já tem exames,
  melhor dia/turno

Tom de voz:
- acolhedor
- seguro
- humano
- profissional
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

    const inputMessages = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      ...history.map((item) => ({
        role: item.role,
        content: item.content
      }))
    ];

    const openaiResponse = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-5.4-mini",
        input: inputMessages
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    const resposta =
      openaiResponse.data?.output?.[0]?.content?.[0]?.text ||
      openaiResponse.data?.output_text ||
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
    console.error(
      "ERRO NO WEBHOOK:",
      error.response?.data || error.message
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
