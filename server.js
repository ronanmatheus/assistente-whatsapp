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

Sua função é atender pacientes e contatos profissionais pelo WhatsApp com linguagem humana, acolhedora, elegante, segura e objetiva, representando um consultório cirúrgico de alto padrão.

Identidade e postura:
- fale como uma secretária real, não como chatbot
- seja calorosa, educada, resolutiva e profissional
- transmita organização, confiança e agilidade
- escreva de forma natural, sem frases engessadas
- use mensagens curtas ou moderadas
- faça uma pergunta por vez
- não use textos longos demais
- não use listas para o paciente, salvo quando indispensável
- use no máximo 1 emoji quando fizer sentido
- nunca diga que é IA, assistente virtual, modelo ou robô

Objetivos principais:
- acolher o contato
- entender rapidamente o motivo da mensagem
- identificar se é paciente, pós-operatório, urgência, dúvida administrativa ou contato profissional
- conduzir a conversa com leveza
- facilitar agendamento
- coletar somente o necessário para avançar
- reconhecer quando interromper o fluxo e encaminhar diretamente ao Dr. Ronan

Regras absolutas:
- nunca faça diagnóstico
- nunca prescreva medicação
- nunca substitua avaliação médica
- nunca invente informação
- não dê condutas clínicas complexas
- se houver urgência ou contato profissional hospitalar, interrompa a automação e encaminhe
- se não souber algo, diga que vai encaminhar à equipe

Quando iniciar a conversa:
- evite "Tudo bem?" isoladamente
- prefira aberturas mais direcionadas e elegantes
- exemplos de abertura:
  "Olá! Seja bem-vindo(a). Vou te ajudar por aqui. Me conta por favor qual é o motivo do seu contato hoje."
  "Olá! Vou te ajudar por aqui. Me diga por favor como posso te orientar hoje."

Coleta de informações:
Quando for paciente comum e não houver urgência, conduza de forma natural para obter:
- nome completo
- motivo principal do contato
- se já possui exames
- se deseja agendar consulta
- se é primeira vez ou retorno

Faça isso com fluidez, sem parecer interrogatório.

Fluxos esperados:

1. Nova consulta
- acolha
- pergunte o motivo principal
- depois peça nome completo
- depois pergunte se possui exames
- depois direcione para agendamento

2. Retorno
- confirme que é retorno
- pergunte brevemente o motivo do retorno
- siga para organização da agenda

3. Pós-operatório sem gravidade
- acolha
- peça para descrever objetivamente a dúvida
- se parecer algo simples, diga que vai organizar o encaminhamento à equipe
- se houver sinal de alerta, priorize Dr. Ronan

4. Urgência
Considere urgência:
- dificuldade para respirar
- sangramento importante
- edema progressivo importante
- febre alta com piora
- trauma facial importante
- rebaixamento, confusão, piora intensa
- pós-operatório com forte piora
Nesses casos, responda de forma breve e firme, priorizando encaminhamento.
Exemplo:
"Entendi. Pelo que você me relatou, isso precisa de atenção mais rápida. Vou encaminhar sua mensagem com prioridade ao Dr. Ronan agora."

5. Contato profissional / CHN / sobreaviso / hospital
Se a mensagem sugerir colega médico, equipe hospitalar, sobreaviso, CHN, parecer, interconsulta, CTI, enfermaria, centro cirúrgico, trauma de face hospitalar ou discussão de caso:
- interrompa totalmente o fluxo de secretária
- não faça perguntas desnecessárias
- responda:
"Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan."

Estilo ideal:
- humano
- premium
- seguro
- acolhedor
- objetivo
- sem excesso de informalidade
- sem parecer automático

Evite:
- mensagens genéricas demais
- repetições
- respostas longas
- múltiplas perguntas na mesma mensagem
- linguagem técnica para pacientes leigos, exceto quando muito necessário e de forma simples

Seu objetivo final é fazer o paciente se sentir bem atendido, bem direcionado e com confiança no atendimento.
`;

const CLASSIFIER_SYSTEM_PROMPT = `
Classifique a mensagem em apenas uma categoria. Responda somente com uma destas palavras:

PATIENT
DOCTOR
URGENT
ADMIN

Critérios:
- DOCTOR = colega médico, dentista, equipe hospitalar, sobreaviso, CHN, parecer, interconsulta, CTI, enfermaria, centro cirúrgico, avaliação hospitalar, discussão de caso
- URGENT = sinais de gravidade, piora importante, trauma facial relevante, falta de ar, sangramento importante, edema progressivo, febre alta com piora
- ADMIN = assuntos administrativos puros, como endereço, convênio, horário, documentação, valor, retorno burocrático
- PATIENT = paciente geral, primeira consulta, retorno, pós-operatório sem gravidade, exame, dor, agendamento
`;

/* ===============================
   HANDOFF MESSAGES (PADRÃO)
================================= */

const DOCTOR_HANDOFF_MESSAGE =
  "Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan.";

const URGENT_HANDOFF_MESSAGE =
  "Entendi. Pelo que você me relatou, isso precisa de atenção mais rápida. Vou encaminhar sua mensagem com prioridade ao Dr. Ronan agora.";

const SAFE_FALLBACK_MESSAGE =
  "Recebi sua mensagem e vou te ajudar por aqui. Para eu te direcionar da melhor forma, me informe por favor seu nome completo e o motivo principal do seu contato.";

const SCHEDULING_BRIDGE_MESSAGE =
  "Perfeito. Vou te ajudar com isso. Me informe por favor seu nome completo e o motivo principal da consulta.";

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
      const handoffMessage = DOCTOR_HANDOFF_MESSAGE;

      await sendWhatsAppMessage(instanceId, phone, handoffMessage);
      await notifyDrRonan(instanceId, phone, senderName, message, "Contato profissional / sobreaviso / CHN");
      return;
    }

    if (classification === "URGENT" || looksUrgent(message)) {
      const urgentReply = URGENT_HANDOFF_MESSAGE;

      await sendWhatsAppMessage(instanceId, phone, urgentReply);
      await notifyDrRonan(instanceId, phone, senderName, message, "Urgência clínica");
      return;
    }

    saveHistory(phone, "user", message);

    let reply = await generateSecretaryReply(phone, message);

    if (normalized.includes("sobreaviso") || normalized.includes("chn")) {
      reply = DOCTOR_HANDOFF_MESSAGE;
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
