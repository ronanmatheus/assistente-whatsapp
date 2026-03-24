import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "";
const DR_RONAN_PHONE = process.env.DR_RONAN_PHONE || "";
const ENABLE_OPENAI = Boolean(OPENAI_API_KEY);

const openai = ENABLE_OPENAI
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* ===============================
   MEMÓRIA / CONTROLE DE SESSÃO
================================= */

const conversationMemory = new Map();
const processedMessages = new Map();

function getHistory(phone) {
  return conversationMemory.get(phone) || [];
}

function saveHistory(phone, role, content) {
  const history = conversationMemory.get(phone) || [];
  history.push({ role, content });

  if (history.length > 14) {
    history.splice(0, history.length - 14);
  }

  conversationMemory.set(phone, history);
}

function alreadyProcessed(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  const existing = processedMessages.get(messageId);

  if (existing && now - existing < 1000 * 60 * 30) {
    return true;
  }

  processedMessages.set(messageId, now);

  if (processedMessages.size > 1000) {
    for (const [key, value] of processedMessages.entries()) {
      if (now - value > 1000 * 60 * 60) {
        processedMessages.delete(key);
      }
    }
  }

  return false;
}

/* ===============================
   PROMPTS
================================= */

const SECRETARY_SYSTEM_PROMPT = `
Você é Carla, secretária virtual premium do Dr. Ronan Matheus, cirurgião bucomaxilofacial.

Contexto profissional:
- Atende pacientes pelo WhatsApp do consultório.
- Seu tom é humano, acolhedor, elegante, seguro e profissional.
- Você representa um consultório cirúrgico de alto padrão.
- Sua função é acolher, organizar a conversa, qualificar a demanda e facilitar o encaminhamento correto.

Objetivos:
- entender o motivo do contato
- identificar se é nova consulta, retorno, pós-operatório, urgência, dúvida administrativa ou pedido de orientação profissional
- conduzir a conversa com naturalidade, sem parecer robô
- gerar confiança
- facilitar agendamento
- reconhecer quando parar a automação e encaminhar ao Dr. Ronan

Regras fundamentais:
- nunca faça diagnóstico
- nunca prescreva medicamentos
- nunca substitua avaliação médica
- nunca invente informação
- não use linguagem fria ou engessada
- use respostas curtas a moderadas
- faça uma pergunta por vez quando estiver coletando dados
- não faça questionários longos
- não fale que é IA, chatbot ou modelo
- se não tiver certeza, diga que vai encaminhar para a equipe
- se a pessoa for colega médico ou mencionar sobreaviso, CHN, plantão, parecer, interconsulta, discussão de caso, avaliação hospitalar, CTI, enfermaria, trauma de face, emergência hospitalar, sobreaviso bucomaxilo ou algo semelhante, NÃO siga fluxo de secretária: interrompa imediatamente e diga que está encaminhando a mensagem diretamente ao Dr. Ronan
- se houver sinais de urgência clínica, também interrompa a triagem longa e oriente atenção imediata / encaminhamento rápido

Sinais de urgência para interromper fluxo e priorizar encaminhamento:
- dificuldade para respirar
- sangramento importante
- edema progressivo importante
- febre alta com piora do quadro
- trauma facial importante
- rebaixamento, confusão, intensa piora clínica
- pós-operatório com sinais relevantes de gravidade

Quando for paciente e não houver urgência:
- acolha
- entenda a demanda
- identifique o tipo de atendimento
- colete apenas o necessário para avançar:
  nome completo,
  motivo principal do contato,
  se possui exames,
  melhor dia/turno ou se deseja que a equipe continue o atendimento

Estilo:
- natural
- humano
- cordial
- premium
- seguro
- sem excesso de emoji
- no máximo 1 emoji se fizer sentido

Exemplos de postura:
- "Bom dia! Vou te ajudar por aqui. Me conta por favor qual é o motivo principal do seu contato."
- "Entendi. Para eu te direcionar da melhor forma, me informe por favor seu nome completo."
- "Pelo que você me relatou, vou priorizar esse encaminhamento para a equipe agora."
- "Essa mensagem será encaminhada diretamente ao Dr. Ronan neste momento."
`;

const CLASSIFIER_SYSTEM_PROMPT = `
Classifique a mensagem em uma única categoria, respondendo APENAS com uma destas palavras:

PATIENT
DOCTOR
URGENT
ADMIN

Use:
- DOCTOR = colega médico, dentista, equipe hospitalar, sobreaviso, CHN, plantão, parecer, interconsulta, hospital, CTI, enfermaria, centro cirúrgico, trauma de face hospitalar, avaliação especializada
- URGENT = sinais de gravidade ou prioridade clínica
- ADMIN = dúvidas puramente administrativas simples
- PATIENT = paciente geral, nova consulta, retorno, pós-operatório sem gravidade, dor, exame, agenda, convênio
`;

/* ===============================
   UTILITÁRIOS
================================= */

function normalizeText(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "");
}

function looksLikeDoctorOrHospital(text) {
  const t = normalizeText(text);

  const terms = [
    "dr ",
    "dra ",
    "doutor",
    "doutora",
    "colega medico",
    "colega medica",
    "medico",
    "cirurgiao",
    "bucomaxilo",
    "sobreaviso",
    "chn",
    "plantao",
    "parecer",
    "interconsulta",
    "avaliacao hospitalar",
    "cti",
    "uti",
    "enfermaria",
    "hospital",
    "pronto socorro",
    "ps",
    "trauma de face",
    "fratura de face",
    "equipe medica"
  ];

  return terms.some(term => t.includes(term));
}

function looksUrgent(text) {
  const t = normalizeText(text);

  const terms = [
    "falta de ar",
    "dificuldade para respirar",
    "nao consigo respirar",
    "muito sangramento",
    "sangramento intenso",
    "sangrando muito",
    "inchaco aumentando",
    "edema progressivo",
    "febre alta",
    "trauma",
    "acidente",
    "batida",
    "queda",
    "muito inchado",
    "dor insuportavel",
    "nao consigo abrir a boca",
    "pus",
    "secrecao",
    "desmaiou",
    "confusao"
  ];

  return terms.some(term => t.includes(term));
}

async function classifyMessage(message) {
  if (!ENABLE_OPENAI) {
    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      input: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: message }
      ]
    });

    const result = (response.output_text || "").trim().toUpperCase();

    if (["PATIENT", "DOCTOR", "URGENT", "ADMIN"].includes(result)) {
      return result;
    }

    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  } catch (error) {
    console.error("Erro ao classificar mensagem:", error.response?.data || error.message);
    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  }
}

async function sendWhatsAppMessage(instanceId, phone, message) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw new Error(`Telefone inválido para envio: ${phone}`);
  }

  const url = `https://api.z-api.io/instances/${instanceId}/token/${ZAPI_INSTANCE_TOKEN}/send-text`;

  const headers = {
    "Content-Type": "application/json"
  };

  if (ZAPI_CLIENT_TOKEN) {
    headers["Client-Token"] = ZAPI_CLIENT_TOKEN;
  }

  console.log("Enviando resposta para:", url);

  const result = await axios.post(
    url,
    {
      phone: normalizedPhone,
      message
    },
    { headers }
  );

  console.log("✅ Resposta enviada com sucesso");
  return result.data;
}

async function notifyDrRonan(instanceId, originalPhone, senderName, originalMessage, reasonLabel) {
  if (!DR_RONAN_PHONE) {
    console.log("⚠️ DR_RONAN_PHONE não configurado. Encaminhamento interno não enviado.");
    return;
  }

  const forwardText =
    `Encaminhamento prioritário para o Dr. Ronan\n\n` +
    `Motivo: ${reasonLabel}\n` +
    `Remetente: ${senderName || "Não identificado"}\n` +
    `Telefone: ${originalPhone}\n` +
    `Mensagem:\n${originalMessage}`;

  try {
    await sendWhatsAppMessage(instanceId, DR_RONAN_PHONE, forwardText);
    console.log("✅ Encaminhamento ao Dr. Ronan enviado");
  } catch (error) {
    console.error("Erro ao encaminhar para Dr. Ronan:", error.response?.data || error.message);
  }
}

async function generateSecretaryReply(phone, message) {
  if (!ENABLE_OPENAI) {
    return "Olá! Vou te ajudar por aqui. Me informe por favor seu nome completo e o motivo principal do seu contato.";
  }

  const history = getHistory(phone);

  const input = [
    {
      role: "system",
      content: SECRETARY_SYSTEM_PROMPT
    },
    ...history.map(item => ({
      role: item.role,
      content: item.content
    })),
    {
      role: "user",
      content: message
    }
  ];

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input
  });

  const reply =
    response.output_text?.trim() ||
    "Olá! Vou te ajudar por aqui. Me informe por favor seu nome completo e o motivo principal do seu contato.";

  return reply;
}

/* ===============================
   ROTAS
================================= */

app.get("/", (req, res) => {
  res.send("Servidor rodando");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    const eventType = req.body?.type;
    const messageId = req.body?.messageId;
    const message = req.body?.text?.message;
    const rawPhone = req.body?.phone;
    const fromMe = req.body?.fromMe;
    const instanceId = req.body?.instanceId;
    const senderName = req.body?.senderName || "";

    res.sendStatus(200);

    if (eventType !== "ReceivedCallback") {
      console.log("⚠️ Evento ignorado:", eventType);
      return;
    }

    if (fromMe === true) {
      console.log("⚠️ Mensagem enviada pela própria instância ignorada");
      return;
    }

    if (alreadyProcessed(messageId)) {
      console.log("⚠️ Mensagem duplicada ignorada:", messageId);
      return;
    }

    const phone = normalizePhone(rawPhone);

    if (!phone || !message || !instanceId) {
      console.log("⚠️ Dados insuficientes:", {
        phone,
        rawPhone,
        message,
        instanceId
      });
      return;
    }

    const classification = await classifyMessage(message);
    const normalized = normalizeText(message);

    if (classification === "DOCTOR" || looksLikeDoctorOrHospital(message)) {
      const handoffMessage =
        "Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan.";

      await sendWhatsAppMessage(instanceId, phone, handoffMessage);
      await notifyDrRonan(instanceId, phone, senderName, message, "Contato profissional / sobreaviso / CHN");
      return;
    }

    if (classification === "URGENT" || looksUrgent(message)) {
      const urgentReply =
        "Entendi. Pelo que você me relatou, isso precisa de atenção mais rápida. Vou encaminhar sua mensagem com prioridade para o Dr. Ronan agora.";

      await sendWhatsAppMessage(instanceId, phone, urgentReply);
      await notifyDrRonan(instanceId, phone, senderName, message, "Urgência clínica");
      return;
    }

    saveHistory(phone, "user", message);

    let reply = await generateSecretaryReply(phone, message);

    if (normalized.includes("sobreaviso") || normalized.includes("chn")) {
      reply = "Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan.";
      await sendWhatsAppMessage(instanceId, phone, reply);
      await notifyDrRonan(instanceId, phone, senderName, message, "Sobreaviso / CHN");
      return;
    }

    saveHistory(phone, "assistant", reply);
    await sendWhatsAppMessage(instanceId, phone, reply);
  } catch (error) {
    console.error("ERRO NO WEBHOOK:");
    console.error(error.response?.data || error.message || error);
  }
});

/* ===== NOVAS ROTAS DE MONITORAMENTO ===== */

app.post("/delivery", (req, res) => {
  console.log("===== DELIVERY CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/message-status", (req, res) => {
  console.log("===== MESSAGE STATUS CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/connect", (req, res) => {
  console.log("===== CONNECT CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/disconnect", (req, res) => {
  console.log("===== DISCONNECT CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

/* ===============================
   START
================================= */

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
